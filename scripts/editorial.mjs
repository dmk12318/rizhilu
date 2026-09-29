#!/usr/bin/env node
/**
 * 主编专栏生成器
 *
 * 把当天的稿件整理成一份"通读材料"，交给大模型按固定体例写成专栏。
 * 本地和云端都能跑；不配 API Key 时会安静跳过，只发新闻、不发专栏。
 *
 * 用法：
 *   node scripts/editorial.mjs                  生成最新一期的专栏
 *   node scripts/editorial.mjs --dry-run        只导出提示词，不调用模型
 *   node scripts/editorial.mjs --date=2026-09-28 --items=15
 *   node scripts/editorial.mjs --force          已存在也重新写
 *   node scripts/editorial.mjs --variant=codex  写成 <日期>.codex.md，与云端版并存
 *   node scripts/editorial.mjs --scope=world    只写"境外要闻"（含涉华、涉鲁两节）
 *
 * 环境变量：
 *   EDITORIAL_API_KEY   接口密钥（也接受 OPENAI_API_KEY）
 *   EDITORIAL_BASE_URL  兼容 OpenAI 的接口地址，默认 https://api.deepseek.com
 *   EDITORIAL_MODEL     模型名，默认 deepseek-flash
 *                       （DeepSeek 现行模型为 deepseek-flash 与 deepseek-v4-pro；
 *                         旧的 deepseek-chat / deepseek-reasoner 已下线）
 *   EDITORIAL_THINKING    设成 enabled 才开启思考模式。默认关闭：
 *                         DeepSeek 的思考模式默认开启，若 max_tokens 不够，
 *                         额度会被思考过程吃光，正文返回空字符串。
 *   EDITORIAL_MAX_TOKENS  单次输出上限，默认 8000
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 'Asia/Shanghai';
const args = process.argv.slice(2);

const readArg = (name, fallback) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const DRY_RUN = Boolean(readArg('dry-run', false));
const FORCE = Boolean(readArg('force', false));
const PER_CATEGORY = Number(readArg('items', 12));
// 专栏允许两个版本并存：cloud 写 <日期>.md，其余变体写 <日期>.<变体>.md
const VARIANT = String(readArg('variant', process.env.EDITORIAL_VARIANT || 'cloud')).toLowerCase();
const IS_CLOUD = VARIANT === 'cloud';
const EDITOR_NAME = IS_CLOUD ? '云端主编' : (process.env.EDITORIAL_EDITOR_NAME || 'Codex');
// 范围：
//   all    全部新闻    → 主编专栏
//   world  只取境外源  → 境外要闻（文末附「境外涉华」「涉鲁简报」两节情报整理）
const RAW_SCOPE = String(readArg('scope', process.env.EDITORIAL_SCOPE || 'all')).toLowerCase();
const KNOWN_SCOPES = ['all', 'world'];
const SCOPE = KNOWN_SCOPES.includes(RAW_SCOPE) ? RAW_SCOPE : 'all';
const BAD_SCOPE = RAW_SCOPE !== SCOPE;
const IS_WORLD = SCOPE === 'world';
const SCOPE_LABEL = { all: '主编专栏', world: '境外要闻' }[SCOPE] || SCOPE;
const API_KEY = process.env.EDITORIAL_API_KEY || process.env.OPENAI_API_KEY || '';
const BASE_URL = (process.env.EDITORIAL_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.EDITORIAL_MODEL || 'deepseek-flash';
const THINKING = (process.env.EDITORIAL_THINKING || 'disabled').toLowerCase();
const MAX_TOKENS = Number(process.env.EDITORIAL_MAX_TOKENS || 8000);

const DATA_DIR = path.join(ROOT, 'data');
const NEWS_DIR = path.join(DATA_DIR, 'news');
const EDITORIAL_DIR = path.join(ROOT, 'editorial');
const STATUS_FILE = path.join(DATA_DIR, IS_WORLD ? 'editorial-status-world.json' : 'editorial-status.json');

let currentDate = null;
/** 本次写作的稿件池：主编专栏用全部，境外要闻只用 region=global 的源 */
let itemPool = [];

/**
 * 把这一次生成的结果写进 data/editorial-status.json。
 * 云端失败时，错误原因会随数据一起提交回仓库，
 * 不必再去 Actions 页翻折叠日志。
 */
async function writeStatus(payload) {
  if (!IS_CLOUD) return;   // 状态文件只记录云端那一版，本地版不掺和
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      STATUS_FILE,
      `${JSON.stringify({ date: currentDate, model: MODEL, at: new Date().toISOString(), ...payload }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* 状态文件写不进去也不影响主流程 */
  }
}

const fmt = (iso) => new Date(iso).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });

/* ---------------------------------------------------------- 选稿 */

function pickItems(pool = itemPool) {
  const scored = pool.map((it) => {
    const ageHours = (Date.now() - Date.parse(it.published)) / 3600000;
    const recency = Math.sqrt(Math.max(0, 30 - ageHours) / 30);
    const crossSource = (it.alsoIn?.length || 0) * 1.1;   // 多家跟进 = 当日真正的公共议题
    return { it, score: recency * 2 + crossSource + (it.lang === 'zh' ? 0.3 : 0) };
  }).sort((a, b) => b.score - a.score);

  const byCategory = {};
  for (const { it } of scored) {
    const bucket = byCategory[it.category] || (byCategory[it.category] = []);
    if (bucket.length < PER_CATEGORY) bucket.push(it);
  }
  return byCategory;
}

function buildDigest(data, pool = itemPool, subPool = false) {
  const byCategory = pickItems(pool);
  const out = [];
  for (const cat of data.categories) {
    const items = byCategory[cat.id] || [];
    if (!items.length) continue;
    out.push('');
    const count = subPool ? `本节 ${items.length} 条` : `当日 ${data.stats.counts[cat.id] || 0} 条`;
    out.push(`▼ ${cat.name}（${count}，下列为要目）`);
    for (const it of items) {
      const also = it.alsoIn?.length ? `（另有 ${it.alsoIn.length} 家跟进：${it.alsoIn.join('、')}）` : '';
      const summary = (it.summary || '').replace(/\s+/g, ' ').slice(0, 180);
      out.push(`- [${fmt(it.published).slice(5, 16)}｜${it.source}${also}] ${it.title}`);
      if (summary) out.push(`  ${summary}`);
    }
  }
  return out.join('\n');
}

/**
 * 按主题标签取素材：境外源优先；涉鲁这类低频主题境外常常一条都没有，
 * 这时用国内源补上，否则小节会空着。
 */
function topicPool(data, topic) {
  const overseas = data.items.filter((it) => it.origin === 'overseas' && (it.topics || []).includes(topic));
  const domestic = data.items.filter((it) => it.origin !== 'overseas' && (it.topics || []).includes(topic));
  return topic === 'shandong' && overseas.length < 3 ? [...overseas, ...domestic] : overseas;
}

/** 读前几期写过的判断，避免云端模型每天重复同一套观点 */
async function recentTheses(date, count = 2) {
  let files = [];
  try {
    files = (await fs.readdir(EDITORIAL_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) < date)
      .sort()
      .reverse()
      .slice(0, count);
  } catch {
    return '';
  }
  const parts = [];
  for (const file of files) {
    const md = await fs.readFile(path.join(EDITORIAL_DIR, file), 'utf8');
    const marks = md.split('\n')
      .filter((l) => /^#{1,3}\s/.test(l) || l.startsWith('> 主编按'))
      .map((l) => l.replace(/^#+\s*/, '- ').slice(0, 90));
    if (marks.length) parts.push(`【${file.slice(0, 10)}】\n${marks.join('\n')}`);
  }
  return parts.join('\n\n');
}

/* ---------------------------------------------------------- 提示词 */

const SYSTEM_PROMPT = [
  '你是一位资深新闻主编，每天为一位中文读者编写《日知录》的头版专栏。',
  '你的工作不是复述新闻，而是替读者完成三件事：把散落的报道连成线索、指出市场与舆论正在定价什么、标出容易被忽略的反面证据。',
  '',
  '写作纪律（必须遵守）：',
  '1. 只能使用我提供的稿件标题与摘要。不得补充你记忆里的背景数字、人名、机构与因果；确实需要背景时，用「据此前公开报道」这类限定语，不得给出具体数字。',
  '2. 每条判断都要让读者看得出信息来自哪里，用“据 BBC World”“据中新网·国际”这样的方式标注来源。',
  '3. 只有单一来源、或来自匿名官员转述的内容，不要写进主论述；放进“风险与反面”并明确指出它是单线信源。',
  '4. 不写空话套话，不写“综上所述”式的收尾。每段都要给出一个可以被反驳的具体判断。',
  '5. 站在新闻工作者的立场：客观、理性、可核查。不使用煽动性修辞，不预设立场，不做道德宣判，不用“震惊”“惊人”这类词。判断与事实要分开写，推测必须标为推测。',
  '6. 全文使用简体中文与全角标点（引号用“”）。**篇幅不限**，以把事情讲清楚为准：该长则长，能短则短，不注水也不为凑字数删掉必要的解释。',
].join('\n');

/* 境外要闻综述用的提示词：任务不是评论，而是归纳与对照 */
const SYSTEM_PROMPT_WORLD = [
  '你是一位国际新闻编辑，负责把当天境外媒体的报道归纳成一份给中文读者的《境外要闻》简报。',
  '你拿到的材料**全部来自境外媒体**（BBC、纽约时报、卫报、半岛电视台、法新社系、南华早报、日经、海峡时报等）。',
  '',
  '你的任务不是评论，而是**归纳与对照**，替读者回答三个问题：',
  '一、境外媒体今天集中在讲什么议题；二、同一件事，不同国家的媒体讲法有什么差别；三、哪些报道被主流忽略但值得留意。',
  '',
  '写作纪律（必须遵守）：',
  '1. 只能使用我提供的稿件标题与摘要。不得补充你记忆里的背景数字、人名、机构与因果；确实需要背景时，用「据此前公开报道」这类限定语，不得给出具体数字。',
  '2. 每一条都要点明是哪家媒体说的，用“据 BBC World”“据纽约时报中文网”这样的方式标注。',
  '3. 归纳时必须指出媒体来源的国别或立场背景（例如“美媒”“中东媒体”“欧洲媒体”），让读者知道这是谁在说话。',
  '4. 同一事件有多家媒体报道时，要写清楚它们措辞与侧重的差异，不要合并成一句笼统的话。',
  '5. 只有单一来源、或来自匿名信源的内容，单独放在最后一节并明确标注是单线信源。',
  '6. 全文使用简体中文与全角标点（引号用“”），第一至第三节合计 1200–2000 字。',
  '',
  '第四、五节是「开源情报小节」，体例与前三节不同，按下面的纪律写：',
  '7. 第四节只归纳境外媒体的涉华报道（含涉台、涉港、涉疆与涉华企业）；第五节只整理与山东省相关的报道（境外媒体优先，不足时才用国内源补充，并标明信源）。只使用我给出的对应素材。',
  '8. 这两节要言简意赅、直击要害，各 500–900 字，宁短勿长。每一句都要有信息量，不写过渡句，不写背景铺垫，不写结论性排比。',
  '9. 严格区分三类内容：【事实】（有明确信源的事件）、【表态】（某方说了什么）、【推测】（你的推断，必须标注【推测】并说明依据）。三者不能混写。',
  '10. 这两节站在开源情报分析员的角度做归纳与影响判断，不做道德评判，不做价值宣判。若某节素材确实极少（例如境外媒体当天对山东几乎没有报道），如实写明这一点，不要硬凑。',
].join('\n');

function buildUserPromptWorld(data, date, theses) {
  const chinaPool = topicPool(data, 'china');
  const shandongPool = topicPool(data, 'shandong');
  const lines = [];
  lines.push(`今天是 ${date}。本期《境外要闻》的材料来自 ${Object.keys(data.stats.bySource || {}).length} 家媒体的报道，其中境外媒体部分共 ${itemPool.length} 条，覆盖最近 ${data.windowHours} 小时。`);
  lines.push('');
  lines.push('以下是当日境外媒体稿件（用于第一至第三节）：');
  lines.push(buildDigest(data));
  lines.push('');
  lines.push(`以下是从中筛出的与**中国相关**的报道共 ${chinaPool.length} 条（用于第四节「境外涉华」）：`);
  lines.push(chinaPool.length ? buildDigest(data, chinaPool, true) : '（当日境外媒体没有涉华条目，第四节写明这一点即可）');
  lines.push('');
  lines.push(`以下是与**山东省相关**的报道共 ${shandongPool.length} 条（用于第五节「涉鲁简报」，境外媒体优先，不足时已用国内源补充）：`);
  lines.push(shandongPool.length ? buildDigest(data, shandongPool, true) : '（当日窗口内没有任何涉鲁素材，第五节写明这一点即可）');
  lines.push('');
  if (theses) {
    lines.push('以下是前两期《主编专栏》写过的判断，避免重复：');
    lines.push(theses);
    lines.push('');
  }
  lines.push('请按下面的体例撰写，直接输出 Markdown，不要用代码块包裹：');
  lines.push('');
  lines.push('---');
  lines.push(`editor: ${EDITOR_NAME}`);
  lines.push(`updated: ${date} 08:00`);
  lines.push('---');
  lines.push('');
  lines.push('# <一句话概括今天境外媒体最集中的议题，不要用“境外要闻”这种标题>');
  lines.push('');
  lines.push('> 简报概要：<80–120 字，说清今天境外媒体的整体关注点>');
  lines.push('');
  lines.push('## 一、境外媒体今天在讲什么');
  lines.push('');
  lines.push('<按主题归纳，3–5 个主题。每个主题说清楚：哪些媒体在报同一件事、各自的落点是什么。>');
  lines.push('');
  lines.push('## 二、同一件事的不同讲法');
  lines.push('');
  lines.push('### 【对比】<事件一>');
  lines.push('### 【对比】<事件二>');
  lines.push('');
  lines.push('<至少写两组对比。指出不同媒体在措辞、归因、责任指向上的差别——这是这份简报最核心的价值。>');
  lines.push('');
  lines.push('## 三、值得单独留意的报道');
  lines.push('');
  lines.push('### 【线索】<小标题>');
  lines.push('### 【存疑】<小标题>');
  lines.push('');
  lines.push('<3–4 条。前几条是被主流忽略但有价值的报道；最后至少一条是单线信源或需要打问号的内容，明确写出它是单一来源。>');
  lines.push('');
  lines.push('## 四、境外涉华');
  lines.push('');
  lines.push('<本节只整理境外媒体的涉华报道，是开源情报小节，不是评论。先用一行 **加粗小标题** 点出今天涉华报道最值得注意的一件事，再按下面三个三级标题写。>');
  lines.push('');
  lines.push('> 要点：<60–100 字，直接给结论，不要铺垫>');
  lines.push('');
  lines.push('### 【事实】');
  lines.push('');
  lines.push('<3–6 条，一条一句，每条都带信源媒体。只写发生了什么、谁说了什么。>');
  lines.push('');
  lines.push('### 【信号与判断】');
  lines.push('');
  lines.push('<2–4 段。指出哪些报道口径一致、哪些互相矛盾、这可能指向什么。每段给一个可被证伪的判断，并标明属于【推测】。>');
  lines.push('');
  lines.push('### 【待观察】');
  lines.push('');
  lines.push('<3–5 条，每条一句话：盯什么、看到什么算变化。>');
  lines.push('');
  lines.push('## 五、涉鲁简报');
  lines.push('');
  lines.push('<与第四节同体例，只整理山东相关的素材。先用一行 **加粗小标题** 点出结论，再写要点、事实、信号与判断、待观察。若境外媒体当天几乎没有涉鲁报道，就如实说明——"境外媒体没有报道"本身也是一条信息。>');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*本简报由${EDITOR_NAME}归纳当日境外媒体报道，含涉华、涉鲁两节开源情报整理，仅呈现外部视角，不代表本刊立场，仅供参考。*`);
  return lines.join('\n');
}

function buildUserPrompt(data, date, theses) {
  const lines = [];
  lines.push(`今天是 ${date}，当期共收录 ${data.stats.total} 条报道，来自 ${Object.keys(data.stats.bySource || {}).length} 家媒体，覆盖最近 ${data.windowHours} 小时。`);
  lines.push('');
  lines.push('以下是当日稿件通读材料：');
  lines.push(buildDigest(data));
  lines.push('');
  if (theses) {
    lines.push('以下是前两期已经写过的判断，请避免重复这些角度，除非今天有新的进展：');
    lines.push(theses);
    lines.push('');
  }
  lines.push('请按下面的体例撰写今天的专栏，直接输出 Markdown，不要用代码块包裹：');
  lines.push('');
  lines.push('---');
  lines.push(`editor: ${EDITOR_NAME}`);
  lines.push(`updated: ${date} 08:00`);
  lines.push('---');
  lines.push('');
  lines.push('# <一个具体的标题，点出今天最核心的矛盾，不要用“今日综述”这种标题>');
  lines.push('');
  lines.push('> 主编按：<一句话定调，60–100 字>');
  lines.push('');
  lines.push('## 一、今日综述');
  lines.push('');
  lines.push('<三到四段。把当天最重要的三件事串成一套因果，而不是罗列。>');
  lines.push('');
  lines.push('## 二、多角度观察');
  lines.push('');
  lines.push('### 【地缘政治】<小标题>');
  lines.push('### 【经济与市场】<小标题>');
  lines.push('### 【科技与产业】<小标题>');
  lines.push('### 【社会与人文】<小标题>');
  lines.push('### 【风险与反面】<小标题>');
  lines.push('');
  lines.push('<每个角度两到三段，角度名必须用【】包裹。第五个角度专门写反面证据、单线信源与被忽略的风险，至少写出一条。>');
  lines.push('');
  lines.push('## 三、明日观察清单');
  lines.push('');
  lines.push('<6 条左右，每条一句话，写清楚“看什么”和“为什么值得看”。>');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*本专栏由${EDITOR_NAME}基于当日抓取的 ${data.stats.total} 条公开报道自动撰写，仅供参考，不构成投资建议。*`);
  return lines.join('\n');
}

/* ---------------------------------------------------------- 主流程 */

async function latestDate() {
  const forced = readArg('date', null);
  if (forced) return String(forced);
  const days = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'days.json'), 'utf8')).days || [];
  if (!days.length) throw new Error('还没有任何一期数据，先运行 npm run fetch');
  return days[0].date;
}

async function main() {
  if (BAD_SCOPE) {
    console.error(`  未知的 --scope=${RAW_SCOPE}：只支持 all（主编专栏）与 world（境外要闻）。`);
    process.exitCode = 1;
    return;
  }
  const date = await latestDate();
  currentDate = date;
  const data = JSON.parse(await fs.readFile(path.join(NEWS_DIR, `${date}.json`), 'utf8'));
  // 文件名：<日期>.md / <日期>.codex.md / <日期>.world.md / <日期>.china.md / <日期>.shandong.codex.md …
  const scopePart = SCOPE === 'all' ? '' : SCOPE;
  const suffix = [scopePart, IS_CLOUD ? '' : VARIANT].filter(Boolean).join('.');
  const outName = suffix ? `${date}.${suffix}.md` : `${date}.md`;
  const outFile = path.join(EDITORIAL_DIR, outName);

  // 素材池：主编专栏用全部稿件，境外要闻只用境外源（涉华、涉鲁两节在提示词里另给）
  if (SCOPE === 'all') itemPool = data.items;
  else itemPool = data.items.filter((it) => it.origin === 'overseas');
  if (SCOPE !== 'all' && !itemPool.length) {
    console.log(`  这一期没有符合《${SCOPE_LABEL}》条件的稿件，跳过。`);
    await writeStatus({ ok: true, status: 'skipped-empty', scope: SCOPE, note: `本期没有${SCOPE_LABEL}素材` });
    return;
  }

  if (!FORCE && !DRY_RUN) {
    const exists = await fs.access(outFile).then(() => true).catch(() => false);
    if (exists) {
      console.log(`  专栏已存在：editorial/${outName}（要覆盖请加 --force）`);
      await writeStatus({ ok: true, status: 'kept-existing', note: '专栏已存在，保留原稿未覆盖' });
      return;
    }
  }

  const theses = await recentTheses(date);
  const userPrompt = IS_WORLD
    ? buildUserPromptWorld(data, date, theses)
    : buildUserPrompt(data, date, theses);
  const systemPrompt = IS_WORLD ? SYSTEM_PROMPT_WORLD : SYSTEM_PROMPT;
  await fs.mkdir(EDITORIAL_DIR, { recursive: true });

  if (DRY_RUN) {
    const promptName = suffix ? `${date}.${suffix}.prompt.md` : `${date}.prompt.md`;
    const promptFile = path.join(EDITORIAL_DIR, promptName);
    await fs.writeFile(promptFile, `<!-- 系统提示词 -->\n${systemPrompt}\n\n<!-- 用户提示词 -->\n${userPrompt}\n`, 'utf8');
    const picked = Object.values(pickItems()).flat().length;
    console.log(`\n  已导出提示词：editorial/${promptName}（未调用模型，未写入专栏）`);
    console.log(`  本期选入提示词的稿件 ${picked} 条，提示词约 ${Math.round(userPrompt.length / 1.5)} 字\n`);
    return;
  }

  if (!API_KEY) {
    console.log('  没有配置 EDITORIAL_API_KEY，跳过专栏生成（站点照常发布，专栏位置会显示"待撰写"）。');
    console.log('  配置方法见 README 的「部署到云端」一节。');
    await writeStatus({ ok: false, status: 'no-api-key', note: '没有读到 API Key，本期没有生成专栏' });
    return;
  }

  console.log(`  正在调用模型 ${MODEL} 撰写专栏...`);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.6,
      max_tokens: MAX_TOKENS,
      // 显式关掉思考模式：默认开启时，思考会先吃掉额度，可能导致正文为空
      thinking: { type: THINKING === 'enabled' ? 'enabled' : 'disabled' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = body.slice(0, 500);
    console.log(`  模型接口返回 ${res.status}：${detail}`);
    await writeStatus({
      ok: false,
      reason: 'api-error',
      httpStatus: res.status,
      endpoint: `${BASE_URL}/chat/completions`,
      detail,
    });
    throw new Error(`模型接口返回 ${res.status}`);
  }

  const json = await res.json();
  let text = json.choices?.[0]?.message?.content?.trim() || '';
  text = text.replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '').trim();
  if (text.length < 400) {
    // 把响应骨架记进状态文件，以后出问题不用猜
    const message = json.choices?.[0]?.message || {};
    await writeStatus({
      ok: false,
      reason: 'empty-content',
      thinking: THINKING,
      maxTokens: MAX_TOKENS,
      finishReason: json.choices?.[0]?.finish_reason || null,
      contentChars: (message.content || '').length,
      reasoningChars: (message.reasoning_content || '').length,
      messageKeys: Object.keys(message),
      usage: json.usage || null,
    });
    throw new Error(`模型输出过短（${text.length} 字），已放弃写入`);
  }

  await fs.writeFile(outFile, `${text}\n`, 'utf8');

  // 两种专栏的体例不同，检查项也不同
  const REQUIRED = IS_WORLD
    ? ['## 一、境外媒体今天在讲什么', '## 二、同一件事的不同讲法', '## 三、值得单独留意的报道', '## 四、境外涉华', '## 五、涉鲁简报', '简报概要']
    : ['## 一、今日综述', '## 二、多角度观察', '## 三、明日观察清单', '主编按'];
  const missing = REQUIRED.filter((s) => !text.includes(s));
  console.log(`  已写入 editorial/${outName}（${text.length} 字）`);
  await writeStatus({
    ok: true,
    scope: SCOPE,
    chars: text.length,
    usage: json.usage || null,
    file: `editorial/${outName}`,
    note: '已完成',
  });
  if (missing.length) console.log(`  注意：输出缺少以下结构 ${missing.join('、')}，建议人工过一眼。`);
  if (json.usage) {
    console.log(`  用量：输入 ${json.usage.prompt_tokens} tokens，输出 ${json.usage.completion_tokens} tokens`);
  }
}

main().catch((err) => {
  console.error(`\n  专栏生成失败：${err.message}\n`);
  writeStatus({ ok: false, reason: 'exception', error: err.message }).catch(() => {});
  process.exitCode = 1;
});
