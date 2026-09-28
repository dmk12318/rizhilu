#!/usr/bin/env node
/**
 * 候选源体检工具：批量测试 URL 是否可用，并显示最新一条的发布时间。
 * 用法：node scripts/probe.mjs [候选清单文件.json]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText, parseFeed } from './fetch_news.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listFile = process.argv[2] || path.join(ROOT, 'scripts', 'candidates.json');
const candidates = JSON.parse(await fs.readFile(listFile, 'utf8'));

const UA_FEED = { url: 'https://example.com/' };

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await worker(items[i]);
      }
    }),
  );
  return out;
}

const PROBE_CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 10);

const results = await mapLimit(candidates, PROBE_CONCURRENCY, async (cand) => {
  const feed = { ...cand, url: cand.url || UA_FEED.url };
  const t0 = Date.now();
  try {
    const xml = await fetchText(feed.url);
    const items = parseFeed(xml, feed);
    const dates = items.map((i) => (i.published ? Date.parse(i.published) : 0)).filter(Boolean);
    const newest = dates.length ? new Date(Math.max(...dates)) : null;
    const newestItem = newest ? items.find((i) => i.published && Date.parse(i.published) === newest.getTime()) : items[0];
    return {
      ...cand,
      ok: true,
      count: items.length,
      newest: newest ? newest.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无日期',
      sample: newestItem?.title?.slice(0, 70) || '',
      ms: Date.now() - t0,
    };
  } catch (err) {
    return { ...cand, ok: false, error: err.message, ms: Date.now() - t0 };
  }
});

const ok = results.filter((r) => r.ok);
const bad = results.filter((r) => !r.ok);

console.log('\n===== 可用 =====');
for (const r of ok.sort((a, b) => (a.group || '').localeCompare(b.group || ''))) {
  console.log(`[${r.group || '-'}] ${r.title}\n    ${r.url}\n    ${r.count} 条 · 最新 ${r.newest} · ${r.ms}ms\n    ${r.sample}\n`);
}
console.log('===== 不可用 =====');
for (const r of bad) console.log(`[${r.group || '-'}] ${r.title} → ${r.error}`);
console.log(`\n可用 ${ok.length} / 不可用 ${bad.length}\n`);
