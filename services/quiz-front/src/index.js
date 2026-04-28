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
app.use(express.static(path.join(__dirname, 'public')));

// Inject VERIFY_API into HTML
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');
  // Replace placeholder with actual API URL
  html = html.replace('const VERIFY_API = window.location.protocol + \'//\' + window.location.hostname + \':3001\';',
                       `const VERIFY_API = '${VERIFY_API}';`);
  res.type('html').send(html);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[quiz-front] Running on port ${PORT}`);
  console.log(`[quiz-front] VERIFY_API = ${VERIFY_API}`);
});
