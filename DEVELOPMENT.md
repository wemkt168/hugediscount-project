# HugeDiscount Project 开发说明书

> 最后更新：2026-04-30

---

## 1. 项目概述

HugeDiscount 是一个防骇客广告活动落地页系统，用于 Facebook/Meta 广告投放，将真实用户引导至购物页（win04.xyz），将机器人/骇客引导至假站（ubuy.com.ph）。

### 核心域名

| 用途 | 域名 | 说明 |
|------|------|------|
| 答题前端 | `hugediscount.store` | 用户看到的落地页 |
| 验证后端 | `patile.hugediscount.store` | verify-api 服务，验证用户并返回 token |
| 真人购物页 | `win04.xyz` | 真实目标，用户最终到达 |
| 假站（机器人） | `ubuy.com.ph` | 骇客/爬虫看到的内容 |

---

## 2. 服务架构

```
用户浏览器
    │
    ▼
┌─────────────────────────────────────────────┐
│  quiz-front (obox)                          │
│  hugediscount.store / quiz                  │
│  Zeabur: 69f102ac3846631902cc1c05           │
│  - 展示题目，引导用户互动                     │
│  - 提交答案时 POST /api/verify              │
│  - 拿 token → redirect to /r?token=xxx       │
└──────────────────┬──────────────────────────┘
                   │ POST /api/verify
                   ▼
┌─────────────────────────────────────────────┐
│  verify-api (patile)                        │
│  patile.hugediscount.store                  │
│  Zeabur: 69f102cb3846631902cc1c0b            │
│  - 运行 7 层检验（L1-L7）                   │
│  - 通过 → 生成 HMAC token                   │
│  - 不通过 → 生成 fake token                 │
│  - POST /api/verify 返回 { token }          │
│  - GET /r?token=xxx 验证并 302 跳转         │
└─────────────────────────────────────────────┘
                   │ 302 win04.xyz (真人)
                   ▼
        ┌──────────────────┐
        │   win04.xyz      │  ← 购物页（真人目标）
        └──────────────────┘
                   │ 302 ubuy.com.ph (机器人)
                   ▼
        ┌──────────────────┐
        │   ubuy.com.ph   │  ← 假站（骇客/爬虫）
        └──────────────────┘
```

---

## 3. 跳转流程（Token 方案）

> **设计原则：骇客/爬虫在 Network 面板只能看到 `/r?token=xxx`，永远看不到 win04.xyz**

### Network 面板可见内容

| 情况 | Network 面板看到 | 实际跳转 |
|------|-----------------|---------|
| 真人 | `GET /r?token=1714...abc` | → win04.xyz |
| 机器人 | `GET /r?token=fake_3f7a...` | → ubuy.com.ph |

**win04.xyz 和 ubuy.com.ph 从不出现在 Network 面板。**

---

## 4. 7 层检验（L1-L7）

| 层级 | 检验内容 | 不通过处理 |
|------|---------|-----------|
| L1 | IP 类型（VPN/数据中心/TOR/代理） | 生成 fake token → ubuy.com.ph |
| L2 | 设备类型（桌面浏览器） | 生成 fake token → ubuy.com.ph |
| L3 | Cloudflare Turnstile Token | 生成 fake token → ubuy.com.ph |
| L4 | 蜜罐字段（隐藏表单） | 生成 fake token → ubuy.com.ph |
| L5 | 触摸事件数（需 ≥1） | 生成 fake token → ubuy.com.ph |
| L6 | 答题时间（需 >2000ms） | 生成 fake token → ubuy.com.ph |
| L7 | HMAC 签名（/r 端点验证） | fake token → ubuy.com.ph |

---

## 5. Token 格式

### HMAC Token（真人）
```
{ts}.{ipSig}.{hexSig}
```
- `ts`: 当前时间戳（毫秒）
- `ipSig`: `HMAC(ip, secret).digest('hex').substring(0, 32)`
- `hexSig`: `HMAC('{ts}.{ip}', secret).digest('hex')`（完整 64 字符）

### Fake Token（机器人）
```
fake_{32字节随机hex}
```

---

## 6. API 端点

### POST /api/verify

**请求体：**
```json
{
  "answer": 4,
  "correctAnswer": 4,
  "touchEventsCount": 3,
  "answerTimeMs": 8500,
  "honeypotValue": "",
  "turnstileToken": "0.xxx.yyy"
}
```

**响应（只有 token）：**
```json
// 真人
{ "token": "1714xxxxx.8a3f....c9e5...." }

// 机器人
{ "token": "fake_3f7a9b2c1d4e5f6a..." }
```

⚠️ 响应 **只有 `token` 字段**，不返回 `redirectUrl`、`pass`、`reason`。

### GET /r?token=xxx

验证 token 并执行 302 跳转。

- HMAC token + 签名正确 → `302 → win04.xyz`
- fake token / 无效签名 → `302 → ubuy.com.ph`

### GET /health

健康检查：`{ "status": "ok", "time": "2026-04-30T..." }`

---

## 7. 环境变量

### verify-api（patile）

| 变量名 | 必须 | 说明 |
|--------|------|------|
| `TURNSTILE_SECRET` | ✅ | Cloudflare Turnstile Secret |
| `HMAC_SECRET` | ✅ | token 签名密钥 |
| `REAL_REDIRECT` | ✅ | `https://www.win04.xyz/?type=0&cid=402&a=x` |
| `FAKE_REDIRECT` | ✅ | `https://www.ubuy.com.ph/` |
| `IPAPI_IS_KEY` | 否 | ipapi.is API key（不填则跳过 L1） |

### quiz-front（obox）

| 变量名 | 必须 | 说明 |
|--------|------|------|
| `VERIFY_API_URL` | ✅ | `https://patile.hugediscount.store` |

---

## 8. GitHub 与部署

### GitHub

- **Org**: `wemkt168`
- **Repo**: `hugediscount-project`
- **Branch**: `main`

### Zeabur Services

| Service | Service ID | GitHub 路径 |
|---------|-----------|------------|
| quiz-front (obox) | `69f102ac3846631902cc1c05` | `/services/quiz-front` |
| verify-api (patile) | `69f102cb3846631902cc1c0b` | `/services/verify-api` |

### 部署流程（MCP only）

1. 推送代码：`git push origin main`
2. 用 MCP 部署：

```python
mcp_call("deploy-from-specification", {
    "service_id": "<SERVICE_ID>",
    "source": {
        "type": "BUILD_FROM_SOURCE",
        "build_from_source": {
            "source": {"type": "GITHUB", "github": {"repo_id": 1223811237, "ref": "main"}},
            "dockerfile": {"content": None, "path": "services/<service-name>/Dockerfile"}
        }
    },
    "framework": "NODE.JS",
    "env": []
})
```

3. 等待 RUNNING：用 `get-service` 轮询

---

## 9. 当前状态（2026-04-30）

- [x] Token 跳转方案已实现（commit `0d3285f`）
- [x] `/api/verify` 返回 `{ token }` 而非 `{ redirectUrl }`
- [x] `/r?token=xxx` 端点验证并 302 跳转
- [x] win04.xyz / ubuy.com.ph 不出现在 Network 面板
- [x] TURNSTILE_SECRET 环境变量已修正并重新部署
- [x] HMAC_SECRET、REAL_REDIRECT、FAKE_REDIRECT 已通过 MCP 创建
- [ ] 待用户测试验证

---

## 10. 关键约定

1. **永远不返回真实 URL 给前端** — `/api/verify` 只返回 token，真实 URL 只在 `/r` 的 302 跳转中出现
2. **答题页有两个** — `/quiz` 是入口，`/` 同理，都是答题页
3. **购物页是 win04.xyz** — 不是 ubuy，不是其他，是 win04.xyz
4. **真人立即跳转** — 验证通过后立即 redirect，不管答题是否完成
5. **所有 Zeabur 操作通过 MCP** — 不得使用 CLI 或 Dashboard
