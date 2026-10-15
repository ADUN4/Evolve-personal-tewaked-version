# 联机与账号验证：设计与路线

> 决策（2026-10-14）：
> - **联机 = 服务端权威的公平玩法**（不接受"改存档就能赢"）
> - **邮箱验证 = 6 位验证码**（不是链接）
>
> 这两条合起来意味着必须引入自己的后端。本文档定义后端是什么、权威边界在哪、分几步做。

---

## 一、核心难题：联机数值从哪来？（**需要你拍板**）

这是整件事的地基。现在的游戏是**客户端权威**：

- 存档是 `localStorage` 里**无签名**的压缩 JSON，玩家随手能改（游戏自带的"导入存档"就是合法注入口）
- 时间推进也在客户端（fastLoop + web worker）

所以服务端的贸易和战斗**绝不能拿客户端上传的存档当依据** —— 否则改个数字就能买空市场、派出一支捏造的军队。

"服务端权威"具体有三种做法，**代价差一个数量级**：

| 方案 | 服务端存什么 | 公平性 | 工作量 |
|---|---|---|---|
| **A. 服务端独立账本** | 联机资源自成一套（贸易货物、军队、殖民地等级），只能通过服务端可验证的路径获得 | ✅ 公平 | 中 |
| **B. 速率折算** | 服务端按玩家的"产出速率"铸造资源，速率由服务端记录的建筑/等级决定 | ✅ 对未来产出公平；**对存量不公平** | 中 |
| **C. 服务端完整模拟** | 把游戏逻辑整体搬到服务端 | ✅最公平 | 极大（≈重写） |

### 我的建议：A + B 组合

```
首次加入联机时做一次"建账"（一次性快照，明确标注这是不完美的起点）
之后：
  服务端的产出速率 ← 由服务端记录的建筑等级决定
  建筑升级       ← 只能通过服务端可验证的路径（消耗服务端账本里的资源）
  贸易 / 战斗    ← 完全在服务端结算
客户端本地的单机模拟照旧跑，但它不参与联机数值
```

**代价要说清楚**：这样"联机里的资源"和"单机里的资源"是**两套账**。你在单机里挖的矿，不能直接拿去联机市场卖 —— 联机账本靠自己的速率累积。这是"公平"必须付的价格。

**需要你确认**：接受"A+B 组合（两套账）"，还是想试 C（真公平但要重写），还是干脆先做 B 的简化版（联机只看速率、不做存量）？

---

## 二、架构

```
浏览器（纯静态，Cloudflare Workers 静态资源）
  ├─ index.html 登录门 + 游戏包
  ├─ PlayFab Client SDK   → 账号 / 云存档（已有）
  └─ /api/*               → 我们自己的 Worker（新增）
                              ├─ D1        账号-邮箱验证记录、联机账本、交易/战斗记录
                              ├─ Durable Objects  按"世界/星球"串行化结算（后期）
                              └─ Resend API  → 发验证码邮件（key 存在 Worker secret）
```

**为什么用 Worker 而不是 PlayFab CloudScript**：CloudScript 也能跑服务端逻辑，但它的免费额度、以及外面流传的"免费档改成 Foundation Mode + 1000 玩家上限"的说法，我**没能从官方文档核实**（官方 pricing 页 404）。Worker + D1 的额度我们是实测过的（10 万请求/天、D1 10 万行写/天），可控。

**注意**：静态资源请求仍然免费不限量；只有 `/api/*` 计费。

---

## 三、功能设计

### 3.1 注册验证码

PlayFab **无法在注册前验证邮箱**（联系邮箱必须挂在已存在的玩家账号上），所以流程是：

```
1. 玩家填邮箱 → POST /api/verify/request
2. 服务端生成 6 位码 → 存哈希 → 调 Resend 发信
3. 玩家填码 → POST /api/verify/confirm
4. 校验通过 → 服务端记录"该邮箱已验证"，并返回一次性 token
5. 客户端拿 token 走 PlayFab 注册（RegisterPlayFabUser）
6. 注册成功后 → POST /api/player/link 绑定 PlayFabId ↔ 邮箱（后续联机要用）
```

防刷规则（全部在服务端强制）：

| 规则 | 值 |
|---|---|
| 同一邮箱两次请求间隔 | ≥ 60 秒 |
| 同一邮箱每小时请求上限 | 5 次 |
| 同一 IP 每小时请求上限 | 20 次 |
| 验证码有效期 | 10 分钟 |
| 单码最多试错 | 5 次，超了作废 |
| 存储 | 只存 `sha256(code + salt + email)`，不存明文 |

### 3.2 异步贸易（阶段 1）

- 服务端账本：`player_ledger(player_id, resource, amount)`
- 挂单：`market_orders(id, seller, give_res, give_amt, want_res, want_amt, created_at, status)`
- 成交：`POST /api/market/fill` → 服务端**在一个事务里**校验买方余额、扣卖方库存、转移资源、写 `trades` 记录（幂等键防重复提交）
- 行情：`GET /api/market/list` 只读，直接返回挂单列表
- **公平性关键**：所有余额变动只在服务端发生；客户端只能提交意图，不能提交"我现在有多少"

### 3.3 异步 PvP（阶段 2）

- 军队也是服务端账本的一部分（`army(player_id, unit, count)`），只能通过服务端路径招募
- 派兵：`POST /api/war/send` → 服务端记录行军（含到达时间戳），**不接受客户端提供的时间**
- 结算：到达时间之后任意一次请求触发结算（或定时任务），依据双方**服务端记录的**军队数值计算战斗
- 战报写入 `battles`，双方可读
- 防守方的"防御工事"同样必须是服务端记录的数值

**这一阶段最容易出错的地方**：结算必须幂等（同一场战斗只能结一次），否则玩家重放请求就能刷战果。

### 3.4 认证：Worker 怎么知道"你是你"

联机接口必须验证调用者身份，否则谁都能伪装成别人。做法：

- 客户端登录 PlayFab 后拿到 **SessionTicket**
- 调 Worker 时带上 `X-Authorization: <SessionTicket>`
- Worker 用 **PlayFab 服务端密钥**（title secret key，存在 Worker secret）调 PlayFab 的 `GetPlayerProfile`/实体接口验证票据 → 拿到可信的 PlayFabId

⚠️ 这意味着你需要再提供一个 **PlayFab title secret key**（服务端密钥）。它**只能存在 Worker 的 secret 里**，绝不能进客户端代码。

---

## 四、数据模型草案（D1）

```sql
-- 阶段 0：邮箱验证
verify_codes(email PK, code_hash, salt, expires_at, attempts, requested_at, hour_window, hour_count)
verified_emails(email PK, verified_at, token, token_expires_at)
players(playfab_id PK, email, display_name, created_at, world_id)

-- 阶段 1：贸易
player_ledger(playfab_id, resource, amount, updated_at, PRIMARY KEY(playfab_id, resource))
market_orders(id PK, seller_id, give_res, give_amt, want_res, want_amt, created_at, status)
trades(id PK, order_id, buyer_id, seller_id, filled_at, idempotency_key)

-- 阶段 2：PvP
army(playfab_id, unit, count, PRIMARY KEY(playfab_id, unit))
marches(id PK, attacker_id, defender_id, arrive_at, payload_json, status)
battles(id PK, march_id, resolved_at, result_json)
```

`players.email` 不要建额外索引（写放大：`TEXT PRIMARY KEY` 之外的索引会让每次写入多算一行）。余额/军队都是按主键取，读完全不是瓶颈。

---

## 五、分阶段交付与验收

| 阶段 | 内容 | 验收方式 | 预估 |
|---|---|---|---|
| **0** | Worker 骨架 + 验证码接口 + D1 表 + 登录门改成"验证码 → 注册" | 本地 `wrangler dev` 跑通；线上用一个真实邮箱收到并校验成功 | 1 天 |
| **1** | 服务端账本 + 全服市场（挂单/成交/行情） | 两个账号互通一次；余额对得上；重复提交只成交一次 | 3–5 天 |
| **2** | 派兵 / 行军 / 结算 / 战报 | 两个账号互打一次；结算幂等；时间不可伪造 | 1–2 周 |
| **3** | 共享星球世界（共享事件/资源池/地图） | 需要先把"共享世界"的游戏设计定下来 | 以月计 |

**先做阶段 1 的理由**：它一次性验证掉所有最麻烦的机制（服务端记账、幂等、防刷），而失败成本最低。PvP 建在没验证过的账本上，出问题就是"全服经济崩了"。

---

## 六、成本与限额（实测过的部分）

| 项 | 额度 | 备注 |
|---|---|---|
| 静态资源请求 | **免费且不限量** | 主站不受影响 |
| Worker 脚本请求 | 免费 10 万/天 | 只统计 `/api/*` |
| D1 行读 / 行写 | 500 万 / 10 万（每天） | 30 分钟一次同步 ≈ 2000 活跃玩家 |
| D1 单行上限 | 2 MB | 大存档也能放 |
| Resend | 100 封/天 | 只用于验证码，够 |
| Durable Objects | 免费可用（限 SQLite 后端），10 万请求/天 | 阶段 2 若要强一致性再用 |

---

## 七、需要你提供 / 确认

1. **确认第一节的方案**：A + B 组合（两套账）？还是别的？
2. **Resend API key**（`re_` 开头）—— 会存进 Worker secret，不进代码
3. **PlayFab title secret key** —— 同上，用于验证玩家身份
4. **发件地址**：用 `noreply@mail.evolve-adun4.cn` 还是别的？
5. **D1 数据库**：在 Cloudflare 后台建一个（Workers & Pages → D1 → Create），把它的 ID 填进 `wrangler.jsonc`

---

## 八、⚠️ 部署形态变化的注意事项

加了 `main`（Worker 脚本）之后：

- **`wrangler.jsonc` 里的 D1 `database_id` 是占位符时，部署会失败** —— 而 Cloudflare 构建失败**不会**让旧版本下线（上一个成功部署继续服务），但你的站点会停止更新。所以**先建好 D1、填对 ID，再推送**。
- **`_headers` 不再对 Worker 生成的响应生效** —— `/api/*` 的 CORS、缓存、安全头都得在 `src/worker.js` 里自己设。
- 静态资源默认优先匹配，所以 `/api/*` 这种没有同名文件的路径会落到 Worker，无需额外路由配置。
