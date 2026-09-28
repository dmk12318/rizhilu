#!/usr/bin/env node
/**
 * 主编工作台：把某一期的稿件按板块打印成可读摘要，供撰写专栏前通读。
 * 用法：
 *   node scripts/digest.mjs                 最新一期，每板块 12 条
 *   node scripts/digest.mjs 2026-09-28 20   指定日期与条数
 *   node scripts/digest.mjs --sources       附各源条目数
 *   node scripts/digest.mjs --grep=伊朗     按关键词跨板块检索（撰写专栏前核对线索）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SHOW_SOURCES = process.argv.includes('--sources');
const GREP = process.argv.find((a) => a.startsWith('--grep='))?.slice(7);

const days = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'days.json'), 'utf8')).days;
const date = args[0] || days[0]?.date;
const perCat = Number(args[1] || 12);
if (!date) {
  console.error('还没有数据，先运行 npm run fetch');
  process.exit(1);
}

const data = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'news', `${date}.json`), 'utf8'));
const fmt = (iso) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

if (GREP) {
  const hay = (it) => `${it.title} ${it.summary} ${it.source}`;
  const hits = data.items.filter((it) => hay(it).includes(GREP));
  console.log(`\n══════ ${date} 关键词「${GREP}」命中 ${hits.length} 条 ══════\n`);
  for (const it of hits) {
    console.log(`${fmt(it.published).slice(5, 16)}  [${it.category}] ${it.source}`);
    console.log(`  ${it.title}`);
    if (it.summary) console.log(`  ${it.summary.slice(0, 240).replace(/\s+/g, ' ')}`);
    console.log('');
  }
  process.exit(0);
}

console.log(`\n══════════ 日知录 ${date} 稿件通读 ══════════`);
console.log(`生成 ${fmt(data.generatedAt)} · 覆盖 ${data.windowHours} 小时 · 共 ${data.stats.total} 条 · 原始 ${data.stats.rawTotal} 条\n`);

for (const cat of data.categories) {
  const items = data.items.filter((i) => i.category === cat.id).slice(0, perCat);
  if (!items.length) continue;
  console.log(`\n─── ${cat.name}（${data.stats.counts[cat.id] || 0} 条）${'─'.repeat(Math.max(0, 40 - cat.name.length))}`);
  for (const it of items) {
    const tag = it.lang === 'en' ? 'EN' : '  ';
    const also = it.alsoIn?.length ? ` [+${it.alsoIn.length}]` : '';
    console.log(`\n${tag} ${fmt(it.published).slice(5, 16)}  ${it.source}${also}`);
    console.log(`    ${it.title}`);
    if (it.summary) console.log(`    ${it.summary.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
}

if (SHOW_SOURCES) {
  console.log('\n\n─── 各源条目数 ───');
  for (const [name, n] of Object.entries(data.stats.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${name}`);
  }
}
console.log('');
