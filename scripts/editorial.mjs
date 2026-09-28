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
 *
 * 环境变量：
 *   EDITORIAL_API_KEY   接口密钥（也接受 OPENAI_API_KEY）
 *   EDITORIAL_BASE_URL  兼容 OpenAI 的接口地址，默认 https://api.deepseek.com
 *   EDITORIAL_MODEL     模型名，默认 deepseek-flash
 *                       （DeepSeek 现行模型为 deepseek-flash 与 deepseek-v4-pro；
 *                         旧的 deepseek-chat / deepseek-reasoner 已下线）
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
const API_KEY = process.env.EDITORIAL_API_KEY || process.env.OPENAI_API_KEY || '';
const BASE_URL = (process.env.EDITORIAL_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.EDITORIAL_MODEL || 'deepseek-flash';

const DATA_DIR = path.join(ROOT, 'data');
const NEWS_DIR = path.join(DATA_DIR, 'news');
const EDITORIAL_DIR = path.join(ROOT, 'editorial');

const fmt = (iso) => new Date(iso).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });

/* ---------------------------------------------------------- 选稿 */

function pickItems(data) {
  const scored = data.items.map((it) => {
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

function buildDigest(data) {
  const byCategory = pickItems(data);
  const out = [];
  for (const cat of data.categories) {
    const items = byCategory[cat.id] || [];
    if (!items.length) continue;
    out.push('');
    out.push(`▼ ${cat.name}（当日 ${data.stats.counts[cat.id] || 0} 条，下列为要目）`);
    for (const it of items) {
      const also = it.alsoIn?.length ? `（另有 ${it.alsoIn.length} 家跟进：${it.alsoIn.join('、')}）` : '';
      const summary = (it.summary || '').replace(/\s+/g, ' ').slice(0, 180);
      out.push(`- [${fmt(it.published).slice(5, 16)}｜${it.source}${also}] ${it.title}`);
      if (summary) out.push(`  ${summary}`);
    }
  }
  return out.join('\n');
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
  '5. 全文使用简体中文与全角标点（引号用“”），正文 1500–2500 字。',
].join('\n');

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
  lines.push('editor: 云端主编');
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
  lines.push(`*本专栏由云端主编基于当日抓取的 ${data.stats.total} 条公开报道自动撰写，仅供参考，不构成投资建议。*`);
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
  const date = await latestDate();
  const data = JSON.parse(await fs.readFile(path.join(NEWS_DIR, `${date}.json`), 'utf8'));
  const outFile = path.join(EDITORIAL_DIR, `${date}.md`);

  if (!FORCE && !DRY_RUN) {
    const exists = await fs.access(outFile).then(() => true).catch(() => false);
    if (exists) {
      console.log(`  专栏已存在：editorial/${date}.md（要覆盖请加 --force）`);
      return;
    }
  }

  const theses = await recentTheses(date);
  const userPrompt = buildUserPrompt(data, date, theses);
  await fs.mkdir(EDITORIAL_DIR, { recursive: true });

  if (DRY_RUN) {
    const promptFile = path.join(EDITORIAL_DIR, `${date}.prompt.md`);
    await fs.writeFile(promptFile, `<!-- 系统提示词 -->\n${SYSTEM_PROMPT}\n\n<!-- 用户提示词 -->\n${userPrompt}\n`, 'utf8');
    const picked = Object.values(pickItems(data)).flat().length;
    console.log(`\n  已导出提示词：editorial/${date}.prompt.md（未调用模型，未写入专栏）`);
    console.log(`  本期选入提示词的稿件 ${picked} 条，提示词约 ${Math.round(userPrompt.length / 1.5)} 字\n`);
    return;
  }

  if (!API_KEY) {
    console.log('  没有配置 EDITORIAL_API_KEY，跳过专栏生成（站点照常发布，专栏位置会显示"待撰写"）。');
    console.log('  配置方法见 README 的「部署到云端」一节。');
    return;
  }

  console.log(`  正在调用模型 ${MODEL} 撰写专栏...`);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.6,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`模型接口返回 ${res.status}：${body.slice(0, 300)}`);
  }

  const json = await res.json();
  let text = json.choices?.[0]?.message?.content?.trim() || '';
  text = text.replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '').trim();
  if (text.length < 400) throw new Error(`模型输出过短（${text.length} 字），已放弃写入`);

  await fs.writeFile(outFile, `${text}\n`, 'utf8');

  const missing = ['## 一、今日综述', '## 二、多角度观察', '## 三、明日观察清单', '主编按']
    .filter((s) => !text.includes(s));
  console.log(`  已写入 editorial/${date}.md（${text.length} 字）`);
  if (missing.length) console.log(`  注意：输出缺少以下结构 ${missing.join('、')}，建议人工过一眼。`);
  if (json.usage) {
    console.log(`  用量：输入 ${json.usage.prompt_tokens} tokens，输出 ${json.usage.completion_tokens} tokens`);
  }
}

main().catch((err) => {
  console.error(`\n  专栏生成失败：${err.message}\n`);
  process.exitCode = 1;
});
