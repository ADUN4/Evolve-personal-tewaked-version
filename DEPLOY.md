# Evolve 上线部署指南

> 针对 `D:\evolve-main` 这份中文版 Evolve（上游：pmotschmann/Evolve，MPL-2.0）实测后写成。
> 本文里带「实测」的结论都是在本机真跑过的，不是推测。

---

## 0. 先搞清楚它是什么 —— 决定了怎么上线

| 事实 | 影响 |
|---|---|
| 纯静态前端：Vue 2 + Buefy + jQuery，`src/` 用 esbuild 打成 `evolve/main.js`，LESS 编成 `evolve/evolve.css` | **不需要 Node/PHP/MySQL 任何服务端**，静态托管即可 |
| 存档在浏览器 `localStorage`，`strings/*.json` 用 ajax 读 | 必须用 http(s) 提供服务，**双击 `index.html` 用 file:// 打不开** |
| 唯一“后端”是 PlayFab 云存档（可关） | 不配也能玩，纯本地存档 |
| 构建产物 `dist/`：**63 个文件 / 17.81 MB**（实测） | GitHub Pages 的 1GB 仓库上限毫无压力 |

结论：**四条路都能用** —— GitHub Pages（最省事）、Cloudflare Pages / Vercel（带宽更宽、能自定义响应头）、自己的 VPS / nginx、Docker。

---

## 0.5 到底选哪条？（按这个站点的实测数据定）

先称重，再选平台。`node deploy/measure-weight.mjs` 实测这个站点的首次加载：

```
25 个文件     原始 5.13 MB   →   gzip 1.33 MB   →   brotli 1.10 MB
```

文本压缩能压到原来的 21%–26%。换算成流量：

| 平台 | 免费带宽额度 | 这份站点的实际含义 |
|---|---|---|
| **Cloudflare Pages** | **不限量** | 不会撞线 ← 公开站首选 |
| GitHub Pages | 软限制 ~100 GB/月 | 10 万首次访客 ≈ 130 GB（gzip），约 7–8 万访客就撞线 |
| Vercel（免费） | 100 GB/月 | 同 GitHub Pages，约 7 万首发访客 |
| 国内 OSS / COS + CDN | 按量计费，很便宜 | 国内最快最稳，但要 ICP 备案 |

> 10 万首次访客 ≈ 130 GB（gzip）/ 107 GB（brotli）——重复访问走缓存，只重新拉 HTML，所以真实流量远低于按访客数×5.13 MB 的估算。

> ✅ **本项目已选定这条路线**，完整操作清单见第 4 节。

- **只是自己玩 / 给几个朋友** → GitHub Pages 更省事，配置同样已就绪（见第 3 节）
- **面向国内公开玩家、在意首屏速度** → 国内对象存储 + CDN，代价是域名要 ICP 备案（个人可备案，约 1–3 周）
- 不想接 Git 仓库？Cloudflare Pages 支持直接上传：`npx wrangler pages deploy dist`

⚠️ **不管选哪条，先把最终域名定下来再对外开放。** 存档存在浏览器 `localStorage` 里，按「协议 + 域名 + 端口」隔离 —— 换域名等于**所有玩家的存档归零**。先用 `*.pages.dev` 试跑可以，但正式开放前定好域名。

---

## 1. 上线前必须处理的 4 件事（3 项已处理完，1 项按你的要求暂缓）

### 1.1 ⚠️ 必须先重新构建：仓库里已提交的 `evolve/main.js` 和 `src/` 不一致

实测：

```
evolve/main.js   仓库现有 2312827 字节  ≠  从 src/ 重新构建 2312660 字节
evolve/evolve.css  重建后 SHA256 与仓库现有文件【完全一致】
```

差异是**真实的代码差异**，不是压缩器噪声：`src/space.js:2741` 现在写的是
`loc('interstellar_alpha_starport_effect1',[$(this)[0].support()])`，
而仓库里已提交的 `main.js` 还是旧写法（`let r=+Re(5).toFixed(2),a=100;`）。

**含义**：直接拿现有 `main.js` 发布 = 发布的不是 `src/` 里那份代码；MPL-2.0 也要求“发布的二进制/产物”和“提供的源码”对应。所以**每次上线都要先构建**（第 2 节的命令），不要图省事跳过。

### 1.2 ⚠️ `package-lock.json` 与 `package.json` 不同步，`npm ci` 会直接失败

实测原始状态：

```
$ npm ci
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json ... are in sync. Please update your lock file ...
npm error Missing: fsevents@2.3.3 from lock file
```

**处理**：本地跑一次 `npm install`（会把 lockfile 补齐），然后**把这个 `package-lock.json` 一起提交**。之后再实测：

```
$ npm ci --no-audit --no-fund
added 208 packages in 4s      ✅
```

CI 里必须用 `npm ci` 才能复现依赖，所以这一步不能省。（本次我已经在 `D:\evolve-main` 里执行过 `npm install`，lockfile 已经修好，你只要提交它。）

### 1.3 ✅ 第三方资源已清除（本轮已完成）

原本 `index.html` / `wiki.html` / `save.html` 里混着 4 个「别人的」第三方资源：

| 位置 | 内容 | 问题 |
|---|---|---|
| `index.html` `<head>` | `//g8hh.com/static/css/kf.css`、`//www.g8hh.com/static/js/kf-evolve.js` | 别人的客服挂件，**在 `<head>` 里且没有 async/defer —— 阻塞首屏渲染**。对方站点挂掉、证书异常或国内被墙，你的首页会被拖住甚至白屏 |
| `index.html` `<body>` | `googletagmanager.com/gtag/js?id=G-CPC46V71CB` | **别人的 GA 统计 ID**：你站点的流量会记到别人账号 |
| `index.html` `<body>` | `hm.baidu.com/hm.js?f237591d5976f87ca2e06b38c3658d9c` | 同上，别人的百度统计 |
| `wiki.html`、`save.html` | 各一份同样的 GA 代码 | 同上 |

**已删除全部四处**（含 `<!--站长统计-->` 那个隐藏 div 和客服注释块）。删除是安全的，理由不是猜的：

- 全项目搜 `gtag`，只有 3 处调用 —— `src/functions.js:664`、`src/vars.js:2187`、`src/vars.js:2435`，**三处全部包在 `try { ... } catch (err) {}` 里**。所以 `gtag` 变成 undefined 只会被吞掉，不会中断游戏逻辑（比如软重置/硬重置）
- `_hmt`（百度）除了那段内联脚本本身，**没有任何代码引用**
- 客服挂件同理：`src/` 里搜不到任何对 `g8hh` / `kf-` / `window.kf*` 的调用

实测：清理后重新构建 + 自检 `RESULT: PASS`（26/26 资产），且 `deploy/verify-site.mjs` 的第三方 `[WARN]` 已全部消失。

> 想加回自己的统计：在 `index.html` 的 `<head>` 里加自己的 GA/百度片段即可（`dataLayer` + `gtag` 一起定义），或者直接用自己的 `tagEvent`（`src/functions.js:661`）——它本来就是项目里给埋点留的统一入口。

### 1.4 ⏸️ PlayFab `titleId = 'CE351'` 是上游的，云存档不是你的（按你的要求暂不处理）

`src/playfab.js:4` 写死 `PlayFab.settings.titleId = 'CE351'`。游戏设置里有面向用户的**「启用云存档(PlayFab)」+ 注册/登录界面**（`src/index.js:1455-1493`），而且 `src/playfab.js` 里还有 `setInterval(autoSaveToPlayFab, 30 * 60 * 1000)` —— 每 30 分钟自动往这个 title 上传存档。

三个选择：

1. **保持现状**：和上游社区共用同一个 PlayFab title（上游本身就是这么公开用的）。缺点：用户账号/云存档归属于别人的 title，owner 能看到数据；不同自建站之间存档互通。
2. **换成自己的**：去 PlayFab 建自己的 title，改 `src/playfab.js:4` 的 `titleId`（改完必须重新构建）。
3. **隐藏该功能**：把 `src/index.js` 里那块 `b-switch v-model="s.onlineSave"` 的 UI 去掉，只留本地存档。

---

## 2. 本地构建 + 自检（每次上线前跑这三条）

```powershell
cd D:\evolve-main
npm install                      # 首次执行；同时把 lockfile 修好（提交它）
node deploy/make-dist.mjs        # 从 src/ 构建并组装出 dist/（跨平台）
node deploy/verify-site.mjs      # 起临时服务器 :4400，逐个资产自检
```

最后一条必须看到 `RESULT: PASS` 再往下走。

`deploy/make-dist.mjs` 做了三件事，替代了原有那套只能在 Linux 上跑的 `rm/cp` 和只能在 Windows 上跑的 `rmdir/xcopy` 脚本：

1. esbuild 打包 `src/main.js` → `evolve/main.js`、`src/wiki/wiki.js` → `wiki/wiki.js`
2. LESS 编译 `src/evolve.less` / `src/wiki/wiki.less`（用 `csso` 压缩，和上游一致 —— 实测重建 CSS 与仓库文件 SHA256 完全相同）
3. 组装 `dist/`：`*.html`、`*.ico`、`LICENSE`、`evolve/ font/ lib/ strings/ wiki/`，另外写入 `.nojekyll` 和 `_headers`

常用参数：`--no-build`（只重新组装，不编译）、`--out <dir>`（换输出目录）。

### 2.1 本地运行（在浏览器里实际玩一下）

三种跑法，按需要选：

```powershell
cd D:\evolve-main
npm install            # 首次；本地服务器 servehere 也在这里装好
```

**A. 跑构建产物（最接近线上）**

```powershell
npm run dist           # = node deploy/make-dist.mjs
npm run serve:dist     # servehere -d dist -p 4400
# 浏览器打开 http://localhost:4400/
```

**B. 跑仓库根目录（开发时更顺手，改完不用等复制 dist）**

```powershell
npm run serve          # servehere -c，服务当前目录，端口 4400
# 浏览器打开 http://localhost:4400/
```

**C. 不想装依赖**

任何静态服务器都行，指向 `dist/` 或仓库根目录即可：`npx serve dist`、VS Code 的 Live Server、`python -m http.server`……

两种模式我都实测过（HTTP 200、内容长度正确）：`-d dist` 与仓库根目录都能正常返回 `index.html`、`evolve/main.js`、`strings/strings.zh-CN.json`。

**必须知道的 3 件事**

1. **一定要用 `http://localhost:...`，不能双击 `index.html` 用 `file://` 打开** —— 游戏要用 ajax 读 `strings/*.json`，`file://` 会被同源策略拦掉，页面会一直卡在转圈
2. **存档按「协议+域名+端口」隔离**：`:4400` 和 `:4401` 的存档互不相通，换端口 = 重新开局（`save.html` 就是用来导出存档串搬迁的）
3. 本地加载几乎瞬时；放到线上首次打开要下 2.3 MB 的 `main.js` + 850 KB 的语言包，会先看到那个转圈动画

### 2.2 想在浏览器里调试源码（不要压缩包）

```powershell
npm run evolve-debug     # main.js 不压缩 + 生成 sourcemap
npm run wiki-debug       # wiki.js 同上
npm run serve            # 然后 http://localhost:4400/
```

注意两点：`make-dist` 一律产出**压缩版**，所以跑过一次 `npm run dist` 会把调试版覆盖掉；`.gitignore` 里有 `*.map`，sourcemap 不会被提交。

### 2.3 ⚠️ Windows 上 `npm run build` 会失败（实测）

`npm run build` → `evolve-less` 里用的是 Linux 的 `rm`，在 cmd 下实测报错：

```
'rm' is not recognized as an internal or external command,
exit=1   （并且留下 evolve/evolve-unminified.css 没删掉）
```

所以 Windows 上要么用 **`node deploy/make-dist.mjs`**（推荐，跨平台、一步到位），要么用 **`npm run build-win`**（实测通过，`exit=0`，无残留文件）。

### 💡 发版时别忘了改版本号（否则老玩家 7 天看不到新版）

页面里靠查询串做缓存击穿，**当前值是**：

- `index.html` → `evolve/main.js?r=20240116`、`evolve/evolve.css?r=20220810`
- `wiki.html` → `wiki/wiki.js?v=20240116`

资源目录本身按「长缓存」发布（nginx 里 7 天、`_headers` 里 `max-age=604800`）。所以**重新构建后如果 `?r=` 不变，回访用户的浏览器会继续用旧包最多 7 天** —— 这跟第 1.1 条（仓库里的 `main.js` 比 `src/` 旧）叠加起来，就是你本地明明是新代码、线上玩家却还是旧行为的原因。上面这三个值每发一版都顺手改大（例如改成当天日期），一次改完。

---

## 3. 备选路线：GitHub Pages（自用 / 小圈子够用）

> 静态站点、**零服务端**、自带 HTTPS。**公开仓库免费**；私有仓库要用 Pages 得 GitHub Pro。

### 3.1 建仓库并推送

```powershell
cd D:\evolve-main
git init -b main
git add .
git status                 # ★ 关键：确认 .github/workflows/deploy.yml 和 .nojekyll 在里面
git commit -m "Evolve 中文版 + 部署配置"
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

★ 这一步必须检查：原 `.gitignore` 里有一条 `.*`，会把 `.github/`、`.nojekyll`、`.dockerignore`，**甚至连 `.gitignore` 和 `.gitattributes` 自己**都静默忽略掉。`git add .` 不报错，但文件不进仓库 —— CI 永远不会跑，别人克隆下来也没有忽略规则，`git status` 会被 142 MB 的 `node_modules/` 淹没然后误提交。

我已经在 `.gitignore` 末尾加了反向规则，并且**用真实的项目文件实测过两种状态**：

```
修复前：git init && git add -A  →  138 个文件，5 个 dotfile 全部缺失
修复后：git init && git add -A  →  140 个文件，.github/workflows/deploy.yml、
                                   .nojekyll、.dockerignore、.gitignore、
                                   .gitattributes 全部 STAGED，
                                   且 node_modules/ 与 dist/ 正确排除
```

（复现方式：`git --git-dir=<临时目录>/.git --work-tree=D:\evolve-main ls-files`，不会在你的项目里留下 `.git`。）

### 3.2 打开 Pages

仓库 → **Settings → Pages → Source 选「GitHub Actions」**（不要选 "Deploy from a branch"，否则不会跑我们写好的 workflow）。

### 3.3 剩下的交给 CI

`.github/workflows/deploy.yml` 会在每次 push 到 `main`（或手动 `workflow_dispatch`）时跑四个阶段：

1. `build`：`npm ci` → `node deploy/make-dist.mjs` → `node deploy/verify-site.mjs`（**构建产物自检不过就不发布**）
2. `build` 续：`actions/configure-pages` + `actions/upload-pages-artifact`（上传 `dist/`）
3. `deploy`：`actions/deploy-pages` 发布
4. `verify`：对**线上真实网址**再跑一次 `verify-site.mjs --wait 90`，逐个资产确认 HTTP 200

### 3.4 访问地址

- 仓库名 = `USERNAME.github.io` → `https://USERNAME.github.io/`（根路径）
- 其他仓库名 → `https://USERNAME.github.io/REPO/`（子路径）

本项目的资源引用全部是相对路径，两种都行（子路径模式已实测通过）。

### 3.5 绑定自己的域名

1. Settings → Pages → Custom domain 填入域名（会往仓库写一个 `CNAME` 文件）
2. DNS：
   - 子域名（`www.example.com`）：`CNAME` → `USERNAME.github.io`
   - 根域名（`example.com`）：4 条 `A` → `185.199.108.153` / `185.199.109.153` / `185.199.110.153` / `185.199.111.153`
3. 回到 Pages 勾选 **Enforce HTTPS**
4. 如果用了根域名，`dist/CNAME` 也要带上（否则每次部署会被 Actions 覆盖掉）—— 更省事的做法是域名直接写进 Settings，Actions 模式会自动保留

### 3.6 已知限制

不支持自定义响应头（不能用 `_headers`）、无服务端、单文件 < 100MB、仓库建议 < 1GB、软带宽 100GB/月、**国内访问 `*.github.io` 经常不稳**。

---

## 4. ★ 已选定：Cloudflare Pages

免费、带宽不限量、支持自定义响应头、免备案、自带 HTTPS + CDN。Cloudflare 默认对 HTML/CSS/JS 开 Brotli，所以首次加载实际传输约 **1.10 MB**（原始 5.13 MB）。

### 4.1 方式一：接 Git 仓库（推荐，push 即部署）

1. 先把代码推上 GitHub —— 见第 3.1 节，**别忘了那一步的 `.gitignore` 检查**
2. Cloudflare 后台 → **Workers & Pages → Create → Pages → Connect to Git**
3. 选中仓库，构建配置照抄：

```
Framework preset       : None
Build command          : node deploy/make-dist.mjs
Build output directory : dist
环境变量                : NODE_VERSION = 20
```

4. **Save and Deploy** → 拿到 `https://<项目名>.pages.dev`
5. 绑自己的域名：**Custom domains → Set up a domain**（域名托管在 Cloudflare 就一键配好 DNS；不在的话按提示改 NS 或加 CNAME）
6. 之后每次 push 到 `main`，Cloudflare 自动重新构建发布

> Cloudflare Pages 检测到 `package-lock.json` 会用 `npm ci` 装依赖 —— **这就是前面必须先修 lockfile 的原因**，不然线上构建会和本地一样直接报 `can only install packages when ... in sync`。

### 4.2 方式二：不接 Git，命令行直接上传

```powershell
npm run dist          # 先构建出 dist/
npm run deploy:cf     # = npx --yes wrangler@latest pages deploy dist --project-name evolve
```

首次会要求浏览器登录 Cloudflare 并确认创建项目；`evolve` 这个名字被占用了就换一个（改命令里的 `--project-name`）。

我**没有**把 wrangler 写进 `devDependencies` —— 它会额外拖进几十 MB 依赖和 workerd 二进制，而这里只是偶尔用一次，所以走 `npx`。

### 4.3 已经为这条路线准备好的东西

| 文件 | 作用 |
|---|---|
| `deploy/_headers` → `dist/_headers` | 缓存策略 + `X-Content-Type-Options` / `Referrer-Policy`，CF Pages 自动识别（GitHub Pages 不支持自定义响应头，只有这条路线吃得到） |
| `deploy/make-dist.mjs` | 构建命令就填它，跨平台，CI 里也不会因为 `rm` 挂掉 |
| `deploy/nginx.conf` | CF 上用不到，留给「自建服务器」那条路线 |
| `.nojekyll` | CF 用不到，留着无害 |

### 4.4 上线后复检（别跳过）

```powershell
node deploy/verify-site.mjs https://你的域名/ --wait 90
```

它会逐个请求线上资产（`main.js`、`wiki.js`、语言包、图标……），看到 `RESULT: PASS` 才算真的好了。

### 4.5 那条 GitHub Actions 我已经改成手动触发

`deploy.yml` 现在只保留 `workflow_dispatch`，**不再随 push 自动跑**。原因：这条路线由 Cloudflare 构建，如果 Actions 还在 push 时自动跑，会因为仓库没开 GitHub Pages 而每次都报 "Pages site not found" 变成红叉。哪天你想切回 GitHub Pages，去 Actions 页点一次 "Run workflow" 就行。

### 4.6 Vercel（备选，免费额度 100 GB/月）

仓库根已经放好了 `vercel.json`，Import 仓库后不用改任何设置：

仓库根已经放好了 `vercel.json`，Import 仓库后不用改任何设置：

```json
{
  "framework": null,
  "installCommand": "npm ci",
  "buildCommand": "node deploy/make-dist.mjs",
  "outputDirectory": "dist"
}
```

---

## 5. 路线 C：自己的服务器 / VPS / 宝塔 / 对象存储

1. 本地跑 `npm run dist` 生成 `dist/`
2. 把 **`dist/` 里的全部内容**（不是 `dist` 这个文件夹本身）上传到网站根目录
   ```powershell
   Compress-Archive -Path D:\evolve-main\dist\* -DestinationPath D:\evolve-dist.zip -Force
   ```
3. nginx 用户直接把 `deploy/nginx.conf` 拷到 `/etc/nginx/conf.d/evolve.conf`，把 `root` 改成你的目录，然后 `nginx -t && nginx -s reload`
   - 里面已配好：gzip、入口页 `no-cache`、`evolve|wiki|lib|font` 长缓存 7 天、`strings/` 缓存 1 小时
   - `add_header` 的继承坑已经绕开了（只在 server 级写安全头，location 里只用 `expires`）
4. 对象存储（阿里 OSS / 腾讯 COS / S3）：把 `dist/` 内容全量上传，默认首页设 `index.html`，开启静态网站托管
5. 要在**国内服务器**上跑，域名需要 **ICP 备案**；GitHub Pages / Cloudflare 这种境外托管不需要备案，但国内访问质量看线路

---

## 6. 路线 D：Docker（配置已修好，但本机没 Docker 未实机验证）

```powershell
cd D:\evolve-main
docker compose up -d --build      # → http://localhost:8080/
# 或
docker build . -t evolve
docker run --name evolve -p 8080:80 -d evolve
```

我改了 `Dockerfile` 三处，都是原配置的真实问题：

| 原配置 | 问题 | 改后 |
|---|---|---|
| `ARG BUILDER_IMAGE=node:16.20` | **esbuild 0.25（package.json 里钉死的版本）要求 Node ≥ 18**（实测 `esbuild` 的 `engines` = `{"node":">=18"}`），node:16 构建阶段很可能直接失败 | `node:20-slim`（Debian/glibc，esbuild 预编译二进制直接可用；没用 alpine 是为了避开 musl 变体问题） |
| `npm install` + `npm run build` + 手工 `cp` | 依赖 lockfile 状态、且是 Linux 专用命令 | `npm ci` + `node deploy/make-dist.mjs`（跨平台，顺带产出 `dist/.nojekyll`） |
| 没有 `.dockerignore` | `COPY ./` 会把宿主机的 `node_modules/`（**实测 142.7 MB**，其中 113 MB 是依赖树里那个匪夷所思的 `node` 包下载的整套 Node 16 运行时）塞进镜像 | 新增 `.dockerignore`，排除 `node_modules`、`dist`、`.git` 等 |

> 本机没装 Docker，这条路径只做了静态审查和配置修正，**没有实机构建验证**。要我没验证就下结论说"能跑"，我不干 —— 你在有 Docker 的机器上先跑一次 `docker compose up --build` 确认。

顺带一提：`package.json` 的 `dependencies` 里那两个 `node` 和 `npmcli` 是**没人引用的历史残留**（实测在 `src/`、`build*.js` 里搜不到任何 import / require）。想瘦身可以 `npm uninstall node npmcli`，安装体积能少 113 MB、CI 快不少。这是可选项，不删也不影响上线。

---

## 7. 本次为你新增/修改的文件

| 文件 | 作用 |
|---|---|
| `deploy/make-dist.mjs` | ★ 跨平台「构建 + 组装 dist」，一条命令搞定，替代 Linux/Windows 两套脚本 |
| `deploy/measure-weight.mjs` | ★ 称重：算出首次访客实际要下多少字节（raw / gzip / brotli），用来判断哪个平台的免费带宽够用 |
| `deploy/verify-site.mjs` | ★ 站点自检：解析 HTML 里所有资源、逐个请求、报状态码和体积，顺手提示第三方引用。既查本地 `dist/`，也能查线上网址（`node deploy/verify-site.mjs https://你的域名/ --wait 90`） |
| `.github/workflows/deploy.yml` | GitHub Pages CI：构建 → 自检 → 发布 → 线上复检。**已改为仅手动触发**（本项目走 Cloudflare Pages 构建，见 4.5） |
| `.nojekyll` | 阻止 GitHub Pages 用 Jekyll 处理输出 |
| `.dockerignore` | Docker 构建上下文瘦身（原来会把 142MB 的 node_modules 打进去） |
| `docker-compose.yml` | 一条命令起容器 |
| `deploy/nginx.conf` | nginx 缓存/压缩/安全头配置 |
| `deploy/_headers` | Cloudflare Pages / Netlify 的响应头配置，会被自动复制进 `dist/` |
| `vercel.json` | Vercel 零配置部署 |
| `Dockerfile`（已改） | Node 版本修正 + 走 make-dist + nginx 配置 |
| `.gitignore`（已改） | 补反向规则，避免 `.github/`、`.nojekyll`、`.dockerignore`、`.gitignore`、`.gitattributes` 被 `.*` 静默吞掉 |
| `package.json`（已改） | 新增 `npm run dist` / `dist-no-build` / `verify` / `serve:dist` 脚本 |
| `index.html`（已改） | 删掉客服挂件（`g8hh.com` 的 css+js）、别人的 GA、别人的百度统计 |
| `wiki.html` / `save.html`（已改） | 各删掉一份别人的 GA |

**没有改动游戏逻辑**：`src/` 下的代码、样式、语言包、存档格式一律没碰，改的只是三个 HTML 页面里的第三方 `<script>`/`<link>` 标签。

第 1.4 条（PlayFab `titleId = 'CE351'`）按你的意思**暂时不动** —— 现状等同于和上游社区共用同一个云存档 title，不配也能纯本地玩。哪天要换成自己的，改 `src/playfab.js:4` 再重新构建即可。

---

## 8. 常见坑速查

- **`git add .` 之后一定要 `git status` 确认 `.github/workflows/deploy.yml` 进去了**（`.*` 在 `.gitignore` 里的历史遗留问题）
- Pages 选了 branch 模式 → 不跑 Actions；选了 Actions 模式 → 必须有 workflow 产物
- 改了代码一定要**重新构建**（第 1.1 条：别信仓库里那份 `main.js`）
- 缓存刷新：`index.html` 里 `evolve/main.js?r=20240116`、`evolve/evolve.css?r=20220810` 的 `?r=` 就是版本号，改大即可强刷
- `strings/*.json` 是运行时 ajax 读取，且 `$.ajaxSetup({cache:true})`，换语言包后要改 `?r=` 或清缓存
- **存档按域名隔离**（localStorage），换域名/换网址 = 用户存档不通；迁移靠游戏内导出存档串，或让用户开 `save.html` 导出（它就是干这个的）
- `zh/core.js` 是**没被引用的死文件**（`index.html` 里那行是注释掉的），不用部署；`make-dist.mjs` 也不会复制它
- MPL-2.0：`dist/` 里保留 `LICENSE`；发布了就要能给出对应源码 —— 直接公开这个仓库就满足
- **别把密钥提交到公开仓库**；PlayFab 之类的凭据走 Actions Secrets

---

## 9. 本次实测记录（复现方式都在上面）

| 项目 | 结果 |
|---|---|
| `npm ci`（修复 lockfile 前） | ❌ 失败：lock 与 package.json 不同步 |
| `npm ci`（修复 lockfile 后） | ✅ 208 个包，4 秒 |
| `node deploy/make-dist.mjs` | ✅ 63 个文件 / 17.81 MB |
| `node deploy/verify-site.mjs` | ✅ **PASS 26/26 资产**均返回 200 且非空，含 `evolve/main.js`、`wiki/wiki.js`、`strings/strings.json`、`strings/strings.zh-CN.json` |
| CSS 重建一致性 | ✅ `evolve/evolve.css`、`wiki/wiki.css` 与仓库现有文件 **SHA256 完全一致** |
| JS 重建一致性 | ❌ **不一致**（见 1.1，`src/` 比已提交产物新） |
| `deploy.yml` / `docker-compose.yml` YAML 解析 | ✅ 通过（js-yaml） |
| `vercel.json` / `package.json` JSON 解析 | ✅ 通过 |
| `.gitignore` 反向规则 | ✅ 用真实项目文件实测：修复前 138 文件且 5 个 dotfile 全缺失；修复后 140 文件、5 个 dotfile 全部纳入，`node_modules/` 与 `dist/` 仍未泄漏 |
| 三个页面清理第三方资源 | ✅ `*.html` 全文搜 `g8hh` / `gtag` / `googletagmanager` / `_hmt` / `hm.baidu` / `客服` / `站长统计` → **0 命中**；`verify-site.mjs` 的第三方 `[WARN]` 全部消失 |
| 清理后重新构建 + 自检 | ✅ 64 文件 / 17.81 MB，26/26 资产 HTTP 200 且有内容，`RESULT: PASS` |
| 本地运行（servehere 两种模式） | ✅ 实测均 HTTP 200：`-d dist` 与仓库根目录都能取到 `index.html`(2901 B)、`evolve/main.js`(2312660 B)、`strings/strings.zh-CN.json`(849520 B) |
| `npm run build-win`（Windows 构建路径） | ✅ exit=0，无残留 `*unminified*` 文件 |
| `npm run evolve-less`（Linux 路径，在 Windows 上） | ❌ 实测失败：`'rm' is not recognized as an internal or external command`，exit=1 且留下未删的中间文件 |
| 打包产物语法检查 | ✅ `node --check evolve/main.js`、`node --check wiki/wiki.js` 均通过 |
| 首次加载称重 | ✅ 25 个文件：原始 5.13 MB → gzip **1.33 MB**（26%）→ brotli **1.10 MB**（21%）；10 万首发访客 ≈ gzip 130 GB |
| 最大单文件（对比 CF Pages 25 MiB 单文件上限） | ✅ `wiki/wiki.js` 2.33 MiB，占上限 **9.31%** |
| 改完 workflow 后重新校验 YAML | ✅ `top-level keys: name, on, permissions, concurrency, jobs`；`triggers: {"workflow_dispatch":null}`（确认已不再随 push 触发） |
| `package.json` 脚本 | ✅ `dist` / `dist-no-build` / `verify` / `weight` / `serve:dist` / `deploy:cf` 全部注册成功 |
| Docker 镜像构建 | ⚠️ **未执行**（本机没有 docker 命令） |

---

## 10. 最短路径总结（Cloudflare Pages）

```powershell
cd D:\evolve-main
npm install                                   # 1. 修 lockfile（必须一起提交）
node deploy/make-dist.mjs                     # 2. 重新构建（别用仓库里的旧 main.js）
node deploy/verify-site.mjs                   # 3. 看到 RESULT: PASS

git init -b main
git add .
git status                                    # 4. 确认 .github/ 和 .nojekyll 在列
git commit -m "Evolve 中文版 + 部署配置"
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main                       # 5. 推送
```

6. Cloudflare 后台 → **Workers & Pages → Create → Pages → Connect to Git** → 选仓库
7. 构建配置：Build command `node deploy/make-dist.mjs`，Output directory `dist`，环境变量 `NODE_VERSION=20`
8. **Save and Deploy** → 拿到 `https://<项目名>.pages.dev`
9. 绑自己的域名（**正式拉人之前定好**，存档按域名隔离）

```powershell
# 10. 线上复检
node deploy/verify-site.mjs https://你的域名/ --wait 90
```

做完第 10 步看到 `RESULT: PASS`，就是真的上线成功了。

> 只想要个自己玩的地方？把 6–9 步换成 GitHub Pages：仓库 **Settings → Pages → Source = GitHub Actions**，然后去 Actions 页手动跑一次 `deploy.yml`（我已经把它改成手动触发了）。
