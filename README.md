# 日知录 · 每日要闻与主编专栏

> **线上地址：<https://dmk12318.github.io/rizhilu/>** —— 每天早上 8:00（北京时间）由 GitHub Actions 自动抓取、生成、发布，不需要任何本地设备开机。手机浏览器打开后可"添加到主屏幕"，全屏离线阅读。

一个只属于你的新闻工作流：每天自动抓取国内外 107 个信息源的政治、经济、财经、军事、科技、人文、社会报道，聚合成一期可读的"报纸"；再由主编（Codex 或云端模型）通读当天稿件，写一篇带多角度评论的专栏。

它同时是两种东西：

- **一个网站**：在电脑浏览器里打开，报纸质感的排版，支持搜索、收藏、标记已读、深色模式、按日期翻阅历史。
- **一个可以装到手机桌面的应用**：通过 PWA 安装后全屏运行、离线可读，用起来和微信小程序几乎一样。

---

## 一、快速开始

**最省事的方式：双击项目根目录的 `启动日知录.cmd`。**

它会依次做三件事：**检查网络（能不能访问境外源）** → 抓取最新新闻（90 分钟内已抓过就自动跳过）→ 启动阅读器并打开浏览器。
那个黑色命令行窗口就是服务本体，**关掉窗口等于停止服务**，下次阅读重新双击即可。
想让它顺带开放手机访问，就在窗口里执行 `node scripts/launcher.mjs --lan`。

习惯用命令行的话：

```bash
# 1. 抓取今天的新闻（约 30 秒）
npm run fetch

# 2. 启动本地阅读器并自动打开浏览器
npm run serve

# 一步到位（等价于双击那个 .cmd）
node scripts/launcher.mjs
```

> 注意：`npm run serve` 是**前台服务**——关掉终端窗口、或者由自动化会话启动的进程被回收，网址就会打不开。
> 遇到"localhost 打不开"，重新跑一次上面任意一条命令即可；服务已经在运行时脚本会检测到并提示你直接打开网址。

想让手机也能看，用局域网模式启动，然后按终端提示的地址在手机上打开（需要同一个 Wi-Fi）：

```bash
npm run serve -- --lan
```

> 说明：手机想在浏览器里"添加到主屏幕"并以独立应用方式启动，需要 HTTPS 环境。局域网 http 地址可以正常阅读，但不能安装。若要完整体验，用 `cloudflared tunnel --url http://localhost:5173` 之类的内网穿透拿到一个 https 地址即可。

---

## 二、每天的工作流

> 已经配好一条定时任务：**每天早上 8:00** 自动执行下面 1–3 步（抓取 → 通读 → 撰写专栏），完成后在这个对话里给出一条简短通知。想改时间或停用，在 Codex 的自动化面板里调整「日知录 · 每日新闻与主编专栏」即可。

系统把"抓取"和"判断"分开，前者交给脚本，后者留给人。

```bash
# 1. 抓取 —— 拉取所有信息源，去重归并，生成当天这一期
npm run fetch

# 2. 通读 —— 打印当天稿件摘要，这是写专栏前的功课
node scripts/digest.mjs                 # 每板块 12 条
node scripts/digest.mjs 2026-09-28 20   # 指定日期与条数
node scripts/digest.mjs --grep=关税     # 跨板块核对某条线索
node scripts/digest.mjs --sources       # 看各源贡献了多少条

# 3. 撰写 —— 新建 editorial/<日期>.md，写今天的专栏
# 4. 阅读 —— npm run serve
```

主编专栏文件格式（普通 Markdown，可选用 front matter）：

```markdown
---
editor: Codex
updated: 2026-09-28 13:20
---

# 标题
> 主编按：一句话定调。

## 一、今日综述
## 二、多角度观察
### 【地缘政治】小标题
### 【经济与市场】小标题
## 三、明日观察清单
```

网页端看到的效果：

- `>` 引用块渲染成醒目的"主编按"；
- `###` 三级标题如果以 `【标签】` 开头，会自动渲染成一枚角度徽章（地缘政治 / 经济与市场 / 风险与反面……），这是"多角度评论"在视觉上的落点；
- 专栏缺失时页面不会报错，而是提示"本期专栏还没有写"。

---

## 三、目录结构

```
index.html                  阅读界面
assets/app.css              排版与主题
assets/app.js               前端逻辑（含迷你 Markdown 渲染器）
assets/sw.js                离线缓存（Service Worker）
assets/manifest.webmanifest PWA 清单，支持安装到桌面

feeds.json                  信息源清单与板块定义  ← 想加源就改这里
editorial/<日期>.md         主编专栏（一期一篇）

data/news/<日期>.json       每期数据
data/days.json              期数索引
data/sources.json           各源连通状态

scripts/fetch_news.mjs      抓取引擎（零依赖，自带 RSS/Atom 解析）
scripts/net.mjs             网络环境探测与代理决策
scripts/netprobe.mjs        连通性探针（独立进程，便于验证代理）
scripts/netcheck.mjs        单独跑一次网络检查
scripts/editorial.mjs       主编专栏生成器（本地与云端通用）
scripts/launcher.mjs        双击启动器背后的逻辑
scripts/digest.mjs          主编工作台：稿件通读与检索
scripts/probe.mjs           候选源体检：想知道某个源能不能用就跑它
scripts/serve.mjs           本地静态服务器
scripts/candidates*.json    候选源清单（体检用）
.github/workflows/daily.yml 云端每日任务
config.local.json           本机网络选择（自动生成，不随仓库走）
```

---

## 四、信息源说明

当前配置 **107 个源 / 7 个板块**，已全部实测可用：

| 板块 | 代表性来源 |
| --- | --- |
| 要闻 | 中国新闻网、中新网、界面新闻、澎湃新闻、BBC中文、德国之声中文、纽约时报中文网、联合早报 |
| 国际 | 中新网国际、BBC World、卫报、纽约时报、半岛电视台、外交事务、The Diplomat、France 24、Le Monde、Euronews、RFI、南华早报、日经亚洲、日本时报、海峡时报、CNA、The Hindu、TASS、Meduza、Moscow Times、Kyiv Post、Anadolu、Al-Monitor、Yonhap、Korea Herald |
| 财经 | 华尔街见闻、东方财富、经济观察网、36氪、钛媒体、集思录、雪球、FT中文网、CNBC、MarketWatch、The Economist |
| 军事 | Defense News、The War Zone、Breaking Defense、War on the Rocks、Task & Purpose、Air & Space Forces、Naval News、The Aviationist、C4ISRNET、DefenseScoop、Defense One、Navy/Army Times、The Strategist |
| 科技 | IT之家、开源中国、量子位、雷锋网、InfoQ、Solidot、爱范儿、少数派、Ars Technica、TechCrunch、The Verge、Wired、Hacker News、MIT TR、IEEE Spectrum、Quanta、Nature、Science、Physics World |
| 人文 | 中新网文化/教育、豆瓣书评、The New Yorker、Aeon、Psyche、Noema、The Marginalian、Literary Hub、Longreads、JSTOR Daily、Public Domain Review、3 Quarks Daily、Nautilus、Smithsonian、Paris Review、History Today、Arts & Letters Daily |
| 社会 | 中新网社会/健康/体育 |

几点实情：

1. **境外源的可达性会波动。** 早期实测时 BBC、纽约时报、卫报、经济学人全部超时，一度被排除；后来复测 38 个源全部恢复正常。脚本对此是容错的——失败的源自动跳过，页脚会显示"信息源连通 106/107"这样的状态，不会因为个别源挂掉而停更。
2. **澎湃、联合早报、法广**经由公共 RSSHub 镜像获取，标记为 `"tier": "mirror"`，可能限流。失败时同样自动跳过。
3. **军事类媒体日发文量稀疏**，单独放宽到 72–120 小时窗口；经济学人、外交事务、Nature 等低频刊物也各自放宽，避免板块空转。
4. 抓取失败的源会写入 `data/sources.json`，方便排查。

### 增加一个源

先用体检工具确认是否可用，再写进 `feeds.json`：

```bash
node scripts/inspect.mjs "https://example.com/rss.xml"   # 看原始 XML 结构
node scripts/probe.mjs scripts/candidates.json           # 批量体检
```

```json
{ "name": "某媒体", "url": "https://example.com/rss.xml",
  "category": "tech", "lang": "zh", "region": "cn",
  "max": 20, "windowHours": 24 }
```

`category` 取值：`top` `world` `business` `military` `tech` `culture` `society`。

---

## 五、抓取引擎做了什么

- **多格式解析**：RSS 2.0 / Atom / RDF 通吃，自动处理 CDATA、命名空间、相对链接、`media:content` 配图。
- **编码自适应**：按 HTTP 头与 XML 声明探测 UTF-8 / GBK / GB18030 / Big5，避免中文乱码。
- **容错重试**：429 / 502 / 503 自动退避重试（尊重 `Retry-After`），超时即放弃，不阻塞整期。
- **去重归并**：标题归一化 + 三元组 Jaccard 相似度，同一事件被多家跟进时合并为一条，并标注"另有 N 家跟进"（这个信号同时是"今日速览"的重要度权重）。
- **时间归一**：无时区的中文时间按东八区解释；个别无日期字段的源按序赋予递减合成时间。
- **保留历史**：按日归档，默认保留 45 天，过期自动清理。

可调参数（环境变量）：`NEWS_WINDOW_HOURS`（回溯窗口，默认 24）、`NEWS_RETENTION_DAYS`（保留天数）、`NEWS_TIMEOUT_MS`（单源超时）、`NEWS_CONCURRENCY`（并发数）。

---

## 六、阅读界面能做什么

- **七个板块页签**，带实时条目数；"全部"视图按时间倒序。
- **今日速览**：按"时效 + 跨源跟进数 + 板块权重"自动排出当日九条要目，每个板块最多两条，避免被单一板块刷屏。
- **检索**：标题、摘要、来源、板块全文匹配（按 `/` 快速聚焦）。
- **筛选**：未读 / 收藏 / 仅中文。
- **已读与收藏**存在浏览器本地，不上传任何数据。
- **日期翻阅**：`←` `→` 切换前一天与后一天，点日期回到最新一期。
- **深色模式**、**离线缓存**、**打印友好**。

---

## 七、边界

- 这里抓取的是各媒体的**标题与摘要**，正文请点"查看原文"跳转阅读，版权归原媒体所有。
- 自动聚合会带来噪音：财经板块里有大量 ETF 行情快讯，社会板块里有不少地方活动稿。这批内容恰好提醒你，**筛选比获取更难**。
- 专栏中的判断基于公开报道，其中单线信源的内容会在"风险与反面"一节单独标注。本专栏不构成投资建议。

---

## 八、部署到云端（电脑不用开机）

先说清楚哪些能搬上云、哪些不能：

| 环节 | 能否上云 | 说明 |
| --- | --- | --- |
| 抓取新闻 | ✅ 完全可以 | 就是一段脚本，任何定时器都能跑 |
| 网页阅读 | ✅ 完全可以 | 纯静态站点，托管在云端随时可访问 |
| 主编专栏 | ⚠️ 换个写法 | 我（Codex）只能运行在你的电脑上。云端方案是让 `scripts/editorial.mjs` 带着你自己的 API Key 去调模型写，不是我在写 |

### 方案：GitHub Actions + GitHub Pages（免费，推荐）

工作流已经写好在 [.github/workflows/daily.yml](.github/workflows/daily.yml)，你要做的是把它推上去并打开两个开关。

**第一步：准备仓库**

1. 注册 GitHub 账号（若还没有）。
2. 新建一个仓库，例如 `rizhilu`。
3. 把本项目推上去（在本目录执行，把地址换成你的）：

```bash
git init
git add .
git commit -m "日知录：首版"
git branch -M main
git remote add origin https://github.com/<你的用户名>/rizhilu.git
git push -u origin main
```

> **注意：免费账号要让 GitHub Pages 正常工作，仓库必须是 Public。** 里面的新闻数据本来都是公开内容，但专栏是你要不要公开的问题。若介意，见下面的"不想公开仓库"。

**第二步：打开两个开关**

1. `Settings → Pages → Source` 选 **GitHub Actions**。
2. `Settings → Actions → General → Workflow permissions` 选 **Read and write permissions**（否则每天的数据提交不回去；就算忘了开，站点仍会正常更新，只是仓库里不留档）。

**第三步（可选）：让云端自动写专栏**

不配的话，云端只发新闻，专栏位置显示"待撰写"。要自动写：

**① 申请一个 API Key（以 DeepSeek 为例）**

1. 打开 <https://platform.deepseek.com>，用手机号注册 / 登录。
   ⚠️ 注意是 **platform** 这个域名（开放平台），不是日常聊天的 `chat.deepseek.com`。两者账号体系不通用，聊天端的会员**不会**给你 API 额度。
2. 左侧菜单进入 **API keys**（或"API 密钥"），点 **创建 API key**，起个名字比如 `rizhilu`。
3. 复制生成的 `sk-` 开头的字符串——**它只完整显示这一次**，关掉页面就再也看不到了（丢了只能删掉重建）。
4. 左侧进入 **充值 / 账单**，充一点点即可。按每天一期的用量，充 10 元能用一年以上。

**② 把它填进仓库**

`Settings → Secrets and variables → Actions`：

- **Secrets** 页 → `New repository secret`：名字 `EDITORIAL_API_KEY`，值粘贴刚才的 Key
- **Variables** 页 → `New repository variable`：名字 `EDITORIAL_BASE_URL`，值 `https://api.deepseek.com`
- **Variables** 页 → `New repository variable`：名字 `EDITORIAL_MODEL`，值 `deepseek-flash`

> Secret 是加密存储、创建后连你自己也看不到内容（只能覆盖）；Variable 是明文，所以只放 base URL 和模型名这类不含密钥的值。
> 换服务商只改这两个 Variable，例如通义千问用 `https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-plus`，OpenAI 用 `https://api.openai.com/v1` + `gpt-4o-mini`。

**③ 想先看看模型会拿到什么材料、且不花钱**

在本地跑：

```bash
npm run editorial:preview      # 只导出 editorial/<日期>.prompt.md，不调用模型
```

**成本**（按 DeepSeek 现行价格，百万 token 计）：

| 模型 | 输入（缓存未命中） | 输出 | 每期约 | 每月约 |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | ¥1（空闲）/ ¥2（高峰） | ¥4 / ¥8 | ¥0.02 | **不到 1 元** |
| `deepseek-v4-pro` | ¥4.5 / ¥9 | ¥13.5 / ¥27 | ¥0.09 | 约 3 元 |

每期约 1 万 token 输入 + 3 千 token 输出。空闲时段是高峰时段的一半价格；北京时间工作日的 9:00–12:00、14:00–18:00 为高峰，**我们排在早上 8:00，正好是空闲时段**。

> 实测（2026-09-28 那一期）：输入 9045 tokens、输出 2711 tokens，生成 4514 字的专栏，花费约 2 分钱。

**两个容易踩的坑：**

1. **思考模式默认是开的。** DeepSeek 这两个模型默认走"思考模式"，思考过程会先消耗 `max_tokens`；如果额度给得不够，正文会返回空字符串（表现为"模型输出过短（0 字）"）。脚本默认已显式关闭思考模式（`EDITORIAL_THINKING=disabled`），想要更强推理就把它设成 `enabled`，同时把 `EDITORIAL_MAX_TOKENS` 调大（例如 16000）。
2. **专栏生成失败不会拖垮发版。** 该步骤设了 `continue-on-error`，接口欠费或限流时，新闻照常发布。失败原因会写进 `data/editorial-status.json` 并随数据提交回仓库，不用去 Actions 页翻日志。

**第四步：手动跑一次验证**

`Actions → 每日新闻与主编专栏 → Run workflow`。跑完后你的站点就是：

```
https://<你的用户名>.github.io/rizhilu/
```

手机浏览器打开这个地址 → 添加到主屏幕，就有桌面图标了（HTTPS，可以正常安装）。

### 不想公开仓库怎么办

免费账号的私有仓库不能发布 GitHub Pages。三条替代路：

- **Cloudflare Pages**：支持私有仓库、免费、国内访问速度通常比 GitHub Pages 好。构建命令留空，输出目录填 `/`，用同样的仓库即可。
- **腾讯云轻量服务器**：约 ¥100/年，`crontab` 里每天跑一次 `npm run fetch && node scripts/editorial.mjs`。用 `http://服务器IP:5173` 访问，不备案也能用；绑域名走 80/443 就必须 ICP 备案。
- **保持现状**：只在自己电脑上看，双击 `启动日知录.cmd`。

### 云端与本地的关系

两边共用同一套脚本和数据格式，互不冲突：

- 云端每天提交的数据会进仓库，你在本地 `git pull` 就能同步历史；
- 本地跑的抓取也可以照常使用，`data/` 目录是纯文件，没有数据库。

---

## 九、网络与代理（要不要翻墙）

**为什么这件事必须处理：** 107 个源里有 **28 个境外源**（BBC、纽约时报、卫报、经济学人、南华早报、日经、海峡时报等）在国内直连不通。不检测就直接抓，每个源都会白白超时重试三轮，整次抓取要多等一分多钟，最后还报一堆错。

所以抓取之前会先回答一个问题：**现在能不能访问境外源？** 这些源在 `feeds.json` 里标记了 `"needsProxy": true`，逻辑如下。

### 自动流程

```
[网络检查] 正在检测境外信息源（BBC、纽约时报等 28 个源）...
   ↓
 可以直连 ──────────────→ 收录全部 107 个源
   ↓ 直连不通
 试上次记录的代理
   ↓ 不行
 扫描本地常见代理端口（Clash 7890/7897、v2rayN 10809 等 10 个）
   ↓ 找到了
 自动启用，并记住这个端口
   ↓ 都没找到
 询问你 ↓
```

询问时长这样：

```
  现在有两种抓取模式：
    开启代理 → 收录全部 107 个源（含 BBC、纽约时报、卫报、经济学人等 28 个境外源）
    不开代理 → 只收录 79 个国内与可直连的源，跳过境外源，抓取也更快

    [1] 我这就去开代理，开好后按回车重试
    [2] 帮我扫描本地代理端口（Clash 等默认端口）
    [3] 本次跳过境外源，直接开始
    [4] 跳过境外源，并且以后不再询问
```

你的选择会记在 `config.local.json`（已在 .gitignore 里，不会上传）。选过 [4] 之后就不再打扰你——想重新启用，删掉这个文件即可。

### 相关命令

```bash
npm run netcheck                 # 单独看一眼现在通不通、走的是直连还是代理

# 手动指定模式，跳过一切询问
$env:NEWS_OVERSEAS="off"; npm run fetch     # 只抓国内与可直连的源
$env:NEWS_OVERSEAS="on";  npm run fetch     # 强制按全部源抓
```

如果你想自己指定代理端口（而不是靠自动扫描），在 PowerShell 里这样跑：

```powershell
$env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:7890"; npm run fetch
```

> 注意：`NODE_USE_ENV_PROXY` 必须在 Node 启动前设置，写在脚本里改 `process.env` 是无效的——这也是启动器和抓取脚本之间要传递环境变量、必要时甚至重启一次进程的原因。

### 云端不需要翻墙

GitHub Actions 的运行节点在境外，工作流里已经写死 `NEWS_OVERSEAS: "on"`，直接跑满 107 个源，不用任何代理。**这本身也是把抓取搬上云的一个理由**——定时任务不会因为你忘了开代理而少掉一半信息源。
