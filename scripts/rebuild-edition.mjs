#!/usr/bin/env node
/**
 * 重建某一期
 *
 * 场景：想补做历史上某一期（例如"9月28日早上8点之前24小时"），
 * 但 RSS 源不保留历史——现在去抓，各源的列表里只剩最近二三十条，
 * 大部分旧稿件早就滚出去了。
 *
 * 办法：把 git 历史里每一次抓取的快照全部翻出来，连同当前文件，
 * 一起按指定窗口过滤、去重，尽力把那一期还原到最全。
 *
 * 用法：
 *   node scripts/rebuild-edition.mjs --date=2026-09-28 --until=2026-09-28T08:00:00+08:00
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEWS_DIR = path.join(ROOT, 'data', 'news');
const args = process.argv.slice(2);

const readArg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const untilRaw = readArg('until', '');
const until = untilRaw ? new Date(untilRaw) : new Date();
if (!Number.isFinite(until.getTime())) {
  console.error(`--until 无法解析：${untilRaw}`);
  process.exit(1);
}

const date = readArg('date', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(until));
const windowHours = Number(readArg('hours', 24));
const from = until.getTime() - windowHours * 3600 * 1000;
const to = until.getTime();

const fmt = (t) => new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

console.log(`\n  重建 ${date} 这一期`);
console.log(`  窗口：${fmt(from)} → ${fmt(to)}（${windowHours} 小时）\n`);

/** 收集：当前文件 + git 历史里所有快照，凡是落在这个窗口内的条目 */
const items = new Map();
let snapshotCount = 0;

function absorb(payload) {
  const list = payload?.items;
  if (!Array.isArray(list)) return 0;
  let added = 0;
  for (const it of list) {
    const t = Date.parse(it.published);
    if (!Number.isFinite(t) || t < from || t > to) continue;
    if (items.has(it.id)) {
      // 已有则合并"另有 N 家跟进"
      const kept = items.get(it.id);
      if (it.alsoIn?.length) {
        kept.alsoIn = [...new Set([...(kept.alsoIn || []), ...it.alsoIn])].slice(0, 4);
      }
      continue;
    }
    items.set(it.id, it);
    added += 1;
  }
  return added;
}

// 1) 当前工作区里的文件
for (const file of await fs.readdir(NEWS_DIR).catch(() => [])) {
  if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
  try {
    absorb(JSON.parse(await fs.readFile(path.join(NEWS_DIR, file), 'utf8')));
  } catch {
    /* 忽略损坏文件 */
  }
}
console.log(`  当前工作区：${items.size} 条`);

// 2) git 历史里的所有快照
const log = execFileSync('git', ['log', '--all', '--pretty=format:COMMIT %H', '--name-only', '--', 'data/news/'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
});

let currentSha = null;
const seenPairs = new Set();
for (const line of log.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (trimmed.startsWith('COMMIT ')) {
    currentSha = trimmed.slice(7).trim();
    continue;
  }
  if (!currentSha || !/^data\/news\/\d{4}-\d{2}-\d{2}\.json$/.test(trimmed)) continue;
  const pair = `${currentSha}:${trimmed}`;
  if (seenPairs.has(pair)) continue;
  seenPairs.add(pair);
  try {
    const raw = execFileSync('git', ['show', pair], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    snapshotCount += 1;
    absorb(JSON.parse(raw));
  } catch {
    /* 该提交里没有这个文件，跳过 */
  }
}
console.log(`  git 历史快照 ${snapshotCount} 份，合计去重后：${items.size} 条\n`);

if (!items.size) {
  console.error('  窗口内一条都没有，什么都没写。');
  process.exit(1);
}

const sorted = [...items.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
const feeds = JSON.parse(await fs.readFile(path.join(ROOT, 'feeds.json'), 'utf8'));

// 历史快照里没有主题标签，这里按当前规则重新标注一遍，
// 保证重建出来的这一期与正常抓取的结构一致（体育归类、涉华/涉鲁标签）。
const hit = (text, patterns) => !!text && (patterns || []).some((p) => {
  const ascii = /^[\x20-\x7E]+$/.test(p);
  const needsBoundary = ascii && p.replace(/\s/g, '').length <= 4;
  const re = needsBoundary
    ? new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    : new RegExp(p, ascii ? 'i' : '');
  return re.test(text);
});
/** 每个源在 feeds.json 里的原始板块，用来纠正历史快照里被误改的分类 */
const feedCategory = new Map(feeds.feeds.map((f) => [f.name, f.category]));
for (const it of items.values()) {
  const haystack = `${it.title} ${it.summary || ''}`;
  const topics = [];
  if (hit(haystack, feeds.chinaPatterns)) topics.push('china');
  if (hit(haystack, feeds.shandongPatterns)) topics.push('shandong');
  if (topics.length) it.topics = topics;
  else delete it.topics;
  // 分类重算：体育关键词优先，否则回到该源在 feeds.json 里配置的板块
  it.category = hit(it.title, feeds.sportsPatterns) ? 'sports' : (feedCategory.get(it.source) || it.category);
}

const counts = {};
const bySource = {};
for (const it of sorted) {
  counts[it.category] = (counts[it.category] || 0) + 1;
  bySource[it.source] = (bySource[it.source] || 0) + 1;
}

const payload = {
  date,
  generatedAt: until.toISOString(),
  windowHours,
  timezone: 'Asia/Shanghai',
  rebuilt: true,
  note: `由 scripts/rebuild-edition.mjs 依据 git 历史快照重建，窗口为 ${fmt(from)} → ${fmt(to)}`,
  categories: feeds.categories,
  stats: {
    total: sorted.length,
    rawTotal: sorted.length,
    sourcesConfigured: feeds.feeds.length,
    sourcesActive: feeds.feeds.length,
    sourcesSkipped: 0,
    overseas: 'on',
    sourcesOk: Object.keys(bySource).length,
    sourcesFailed: 0,
    counts,
    bySource,
  },
  items: sorted,
};

await fs.writeFile(path.join(NEWS_DIR, `${date}.json`), `${JSON.stringify(payload, null, 1)}\n`, 'utf8');

// 同步重建 days.json
const files = (await fs.readdir(NEWS_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
const days = [];
for (const file of files) {
  try {
    const d = JSON.parse(await fs.readFile(path.join(NEWS_DIR, file), 'utf8'));
    days.push({ date: d.date, total: d.stats?.total ?? d.items?.length ?? 0, counts: d.stats?.counts || {}, generatedAt: d.generatedAt });
  } catch {
    /* 忽略 */
  }
}
await fs.writeFile(path.join(ROOT, 'data', 'days.json'), `${JSON.stringify({ updatedAt: new Date().toISOString(), days }, null, 1)}\n`, 'utf8');

console.log(`  已写入 data/news/${date}.json：${sorted.length} 条`);
for (const c of feeds.categories) {
  console.log(`    ${c.name.padEnd(4, '　')} ${String(counts[c.id] || 0).padStart(4)} 条`);
}
console.log('');
