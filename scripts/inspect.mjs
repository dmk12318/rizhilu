#!/usr/bin/env node
/** 查看某个源的单条原始 XML，用于排查字段结构。用法：node scripts/inspect.mjs <url> */
import { fetchText } from './fetch_news.mjs';

const url = process.argv[2];
if (!url) {
  console.error('用法：node scripts/inspect.mjs <url>');
  process.exit(1);
}

const xml = await fetchText(url);
console.log('--- 头部 600 字符 ---');
console.log(xml.slice(0, 600));
const m = xml.match(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/i);
console.log('\n--- 首条 ---');
console.log(m ? m[0].slice(0, 1500) : '（未匹配到条目）');
