#!/usr/bin/env node
/**
 * 按当前 feeds.json 的规则，给某一期重新计算「板块分类」与「主题标签」
 *
 * 用途：改了分类规则（新增板块、新增关键词）之后，把已有的某一期补上标注，
 * 不改变条目集合，也不重新抓取。
 *
 * 用法：node scripts/retag-edition.mjs [日期]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEWS_DIR = path.join(ROOT, 'data', 'news');

const feeds = JSON.parse(await fs.readFile(path.join(ROOT, 'feeds.json'), 'utf8'));
const feedCategory = new Map(feeds.feeds.map((f) => [f.name, f.category]));

const hit = (text, patterns) => !!text && (patterns || []).some((p) => {
  const ascii = /^[\x20-\x7E]+$/.test(p);
  const needsBoundary = ascii && p.replace(/\s/g, '').length <= 4;
  const re = needsBoundary
    ? new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    : new RegExp(p, ascii ? 'i' : '');
  return re.test(text);
});

const argDate = process.argv[2];
let date = argDate;
if (!date) {
  const days = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'days.json'), 'utf8')).days || [];
  date = days[0]?.date;
}
if (!date) throw new Error('找不到要处理的日期');

const file = path.join(NEWS_DIR, `${date}.json`);
const payload = JSON.parse(await fs.readFile(file, 'utf8'));

let sportsMoved = 0;
let tagged = 0;
for (const it of payload.items) {
  const haystack = `${it.title} ${it.summary || ''}`;
  const topics = [];
  if (hit(haystack, feeds.chinaPatterns)) topics.push('china');
  if (hit(haystack, feeds.shandongPatterns)) topics.push('shandong');
  if (topics.length) { it.topics = topics; tagged += 1; } else { delete it.topics; }

  const next = hit(it.title, feeds.sportsPatterns) ? 'sports' : (feedCategory.get(it.source) || it.category);
  if (next !== it.category) sportsMoved += 1;
  it.category = next;
}

// 重算统计
const counts = {};
const bySource = {};
for (const it of payload.items) {
  counts[it.category] = (counts[it.category] || 0) + 1;
  bySource[it.source] = (bySource[it.source] || 0) + 1;
}
payload.stats = { ...payload.stats, total: payload.items.length, counts, bySource };
payload.retaggedAt = new Date().toISOString();
payload.categories = feeds.categories;

await fs.writeFile(file, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');

console.log(`\n  ${date} 重新标注完成：调整分类 ${sportsMoved} 条，打主题标签 ${tagged} 条\n`);
for (const c of feeds.categories) {
  console.log(`    ${c.name.padEnd(4, '　')} ${String(counts[c.id] || 0).padStart(4)} 条`);
}
console.log('');
