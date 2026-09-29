# 日知录 · 每日要闻与主编专栏

线上：<https://dmk12318.github.io/rizhilu/>　仓库：`github.com/dmk12318/rizhilu`（**公开**）。
每天抓取国内外上百个信息源，聚合成一期"报纸"，另加主编专栏与境外要闻两栏，每栏各有云端版与本地精修版。

> 项目自身的完整说明在 `README.md`，这里只写"在这个项目里干活必须知道的规矩"。

## 两条轨道，别搞混

| 轨道 | 什么时候跑 | 干什么 |
| --- | --- | --- |
| 云端 GitHub Actions | 每天 UTC 00:00 ＝ 北京 08:00 | `npm run fetch` → 调 DeepSeek 生成 `<日期>.md` / `<日期>.world.md` → 发 Pages → 把 `data/`、`editorial/` 提交回仓库 |
| 本地（自动化或手工） | 每天 20:00 | 拉到云端当天那一期，写两篇**精修版** `<日期>.codex.md` / `<日期>.world.codex.md`，提交推送 |

本地那条自动化的名字是「日知录 · 两篇专栏主编精修（本地增强，可选）」。

## 铁律

- **写精修稿之前不要重新抓取**：稿子必须和页面显示的是同一份材料。先 `git pull --rebase`，确认
  `data/news/<日期>.json` 已存在；只有当天数据还没生成时才 `npm run fetch`。
- 云端那两篇（`<日期>.md` / `<日期>.world.md`）**只读**，不许改、不许删。
- 不要再单独建 `<日期>.china.md` / `.shandong*` 之类文件——涉华、涉鲁已经并进境外要闻一篇里。
- 不要动 `data/`，不要改 `assets/` 前端，不要改 `feeds.json`（除非某个源连续多日失效）。
- 写稿只依据 `data/` 与 `digest` 给出的材料，不要上网另找新闻，否则专栏和页面上的新闻列表会对不上。

## 日常命令

```bash
npm run fetch                                  # 抓取当天新闻（约 30 秒）
node scripts/digest.mjs                        # 通读当天稿件，写专栏前的功课
node scripts/digest.mjs --foreign              # 只看境外媒体
node scripts/digest.mjs 2026-09-28 --grep=关税  # 跨板块核对某条线索
npm run serve                                  # 本地阅读器（前台服务，关窗即停）
npm run start                                  # 等于双击 `启动日知录.cmd`：查网络 → 抓取 → 起服务
node scripts/editorial.mjs --scope=world --variant=codex   # 手动生成某一版专栏
```

## 环境与依赖

- Node.js **v24**（本机 v24.18.1）。**零 npm 依赖**：`scripts/*.mjs` 只用 Node 内置模块加相对导入，
  `package.json` 里没有任何 `dependencies`。
  **新 worktree 里不需要 `npm install`**，克隆完直接能跑（跑了也只会多出一个空 `node_modules`）。
- 网络：31 个境外源（BBC、纽约时报等）国内直连不通。抓取前会先探测，直连不通就扫本地代理端口，
  结果记在 `config.local.json`（已 gitignore）。云端节点在境外，`NEWS_OVERSEAS: "on"` 跑满全部源，不需要代理。

## git 规矩

- 仓库每天有机器人提交，**动手前先 `git pull --rebase`**；推送被拒也是先 rebase（最多重试三次），**不要 force push**。
- `.gitattributes` 强制仓库内 LF、`.cmd` 用 CRLF，别顺手改成别的行尾。
- 只提交 `data/` 与 `editorial/`；`logs/`、`preview/`、`config.local.json`、`editorial/*.prompt.md` 不进仓库。

## worktree

- 这是目前唯一用 worktree 的项目。没被 git 跟踪但每个检出都要有的本地文件，写在仓库根的 `.worktreeinclude` 里。
- 一个 worktree 一个分支一个对话；数据靠 `git pull --rebase` 同步，不靠复制主目录。
- 每天 20:00 的自动精修走的是主检出，worktree 留给"并行改前端/脚本"这类开发活。
