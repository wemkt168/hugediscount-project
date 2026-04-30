import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// API URL - 相对路径，这样 nginx proxy 模式下也能工作
// 外部访问时用 /api/verify，docker-compose 时用服务名
const VERIFY_API = process.env.VERIFY_API_URL || 'http://localhost:3001';

// Serve static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// Redirect root to /quiz
app.get('/', (req, res) => {
  res.redirect('/quiz');
});

// Quiz route also injects API URL
app.get('/quiz', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');
  html = html.replace(
    "const VERIFY_API_BASE = '__VERIFY_API_BASE__'",
    `const VERIFY_API_BASE = '${VERIFY_API}'`
  );
  res.type('html').send(html);
});

// Proxy /r to patile for HMAC redirect
// Forward x-forwarded-for so patile sees real client IP for HMAC validation
app.get('/r', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Missing token');

  try {
    const url = `${VERIFY_API}/r?token=${encodeURIComponent(token)}`;
    const headers = { ...req.headers };
    headers['x-forwarded-for'] = req.ip || req.connection.remoteAddress;
    delete headers['host'];
    delete headers['content-length'];

    const resp = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual'
    });

    const location = resp.headers.get('location');
    if (location) {
      return res.redirect(302, location);
    }
    return res.status(502).send('No redirect from patile');
  } catch (e) {
    console.error('[quiz-front] /r proxy error:', e.message);
    return res.status(502).send('Proxy error');
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[quiz-front] Running on port ${PORT}`);
  console.log(`[quiz-front] VERIFY_API = ${VERIFY_API}`);
});
