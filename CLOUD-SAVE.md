# 云存档（邮箱注册 / 登录）

本项目使用 **PlayFab** 做邮箱账号 + 云端存档。客户端代码已经写好，你只需要申请一个自己的 PlayFab Title 并填进配置。

> 上游仓库里 `titleId` 写死的是 `CE351`（原作者 pmotschmann 的公开 title）。继续用它意味着：玩家的账号和存档都存在**别人名下**，而且所有用这个 ID 的分叉之间存档互通。自建站请换成自己的。

---

## 一、它现在的行为（先搞清楚再动手）

| 行为 | 说明 |
|---|---|
| 注册 | 邮箱 + 密码（6–100 位）。PlayFab 会往该邮箱发验证邮件 |
| 登录 | 邮箱 + 密码 |
| 找回密码 | 「忘记密码」按钮 → PlayFab 往注册邮箱发重置邮件 |
| 自动备份 | **每 30 分钟**自动上传一次；也可点「立即备份到云端」 |
| 自动登录 | 勾选「启用云存档」后，下次打开游戏用上次的邮箱密码自动登录 |
| **登录后会不会覆盖本地存档** | **不会。** 登录只读云端时间戳，必须手动点「从云端导入存档」才会覆盖本地 —— 这是刻意设计的保护，避免误覆盖 |
| 存档存在哪 | PlayFab 的 Player Data，两个键：`saveString`（存档本体）、`gameTotalDays`（天数，用于比对） |
| 本地存档 | 仍然是 `localStorage` 的 `evolved` 键，云存档只是额外备份 |

---

## 二、启用步骤

### 1. 申请 PlayFab Title

1. 打开 <https://developer.playfab.com> 注册（免费）
2. 新建一个 **Title**（Studio → 你的游戏）
3. 在 Title 的 **Settings → API Features**（或 Title ID 旁边的信息区）找到 **Title ID**，形如 `A1B2C`

### 2. 填进代码

修改 `src/playfab.js`：

```js
PlayFab.settings.titleId = '123A76';   // ← 本仓库当前使用的 Title ID
```

> 换成自己的 ID 后，改完必须重新构建：`node deploy/make-dist.mjs`

### 3. PlayFab 后台需要确认的几项 ⚠️

**下面这些菜单名会随 PlayFab 版本变化，以你后台实际显示为准**（找不到就用后台的搜索框搜关键词）：

| 要找的设置 | 大概位置 | 不开会怎样 |
|---|---|---|
| **允许客户端添加/更新玩家数据**（Allow client to add player data 之类） | Title settings → API Features | **存档写不进去** —— 这是最常见的「代码没问题但就是存不上」 |
| **邮箱 + 密码登录**已启用 | Title settings → Add-ons / API Features | 注册或登录直接报错 |
| 邮箱验证策略 | Title settings 里与 Email 相关的项 | 默认未验证邮箱也能登录；想强制验证才需要开 |

### 4. 验证

```powershell
npm run dist        # 重新构建
npm run serve       # 本地起服务，http://localhost:4400/
```

进游戏 → 设置 → 「启用云存档(PlayFab)」→ 注册 → 用一个真实邮箱注册 → 看是否收到验证邮件、云存档状态是否显示「已登录」。然后点「立即备份到云端」，刷新页面重新登录，点「从云端导入存档」验证能否取回。

---

## 三、已知限制与风险（都要自己评估）

| 项 | 情况 |
|---|---|
| **存档大小上限** | PlayFab Player Data 有大小限制，而挂机游戏存档会越玩越大。**上线前务必拿一份中后期存档量一下**：游戏里按 F12 → Console → 执行 `LZString.compressToBase64(JSON.stringify(global)).length`，得到的字符数就是上传体积（约等于字节数）。再对照 PlayFab 官方对 Player Data 的限制。超了就得改存储方案（比如自建 D1 / R2） |
| **客户端完全信任** | 存档是**无签名的压缩 JSON**，玩家可以随意篡改（游戏自带的「导入存档」就是合法注入口）。所以云存档只能当**个人备份/跨设备同步**，**不能**作为排行榜、PvP 等竞争性玩法的依据。详见 `DEPLOY.md` 与之前的讨论 |
| **密码明文存 localStorage** | `playFabName` / `playFabPass` 两个键是明文（继承自上游实现）。只对同源脚本可见，且本站已移除第三方脚本，风险可控，但不是最佳实践。想改可以存 PlayFab 的 SessionTicket |
| **换设备需要手动拉取** | 登录后不会自动下载存档，必须点「从云端导入存档」—— 防止误覆盖本地进度 |
| **第三方依赖** | 账号与存档都在 Epic/PlayFab 的服务器上；玩家的删号、数据导出请求都得你到 PlayFab 后台处理 |

---

## 四、回滚

想彻底关掉云存档：把 `PlayFab.settings.titleId` 改成任意字符串（比如 `'DISABLED'`）后重新构建，云存档登录会失败但**不影响本地存档和正常游戏**。或者只在界面上不暴露入口。

---

## 五、相关文件

| 文件 | 作用 |
|---|---|
| `src/playfab.js` | 全部云存档逻辑：注册、登录、找回密码、自动备份、导入 |
| `src/index.js` | 设置页里的云存档 UI（登录/注册/忘记密码/导入/立即备份） |
| `lib/PlayFabClientApi.js` | vendored 的 PlayFab 客户端 SDK（无需联网加载） |
