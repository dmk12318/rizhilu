#!/usr/bin/env node
/**
 * 双击启动器：网络检查 → 按需抓取 → 启动阅读器 → 自动打开浏览器
 *
 * 用法：
 *   node scripts/launcher.mjs             数据太旧才抓取（90 分钟内视为新鲜）
 *   node scripts/launcher.mjs --force     强制重新抓取
 *   node scripts/launcher.mjs --lan       允许同一 Wi-Fi 下的手机访问
 *   node scripts/launcher.mjs --no-open   不自动开浏览器
 *
 * 中文输出放在这里而不是 .cmd 里：cmd.exe 会按 GBK 解析批处理文件，
 * 里面写 UTF-8 中文会被解析成乱码命令，进而报错甚至误执行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveOverseas } from './net.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const FRESH_MINUTES = 90;

const line = () => console.log('  ' + '─'.repeat(44));

function newestEdition() {
  try {
    const days = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'days.json'), 'utf8')).days || [];
    return days[0] || null;
  } catch {
    return null;
  }
}

function run(cmd, argv, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', cwd: ROOT, env: env || process.env });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

console.log('');
console.log('  日知录 · 每日要闻');
line();

const edition = newestEdition();
const ageMinutes = edition ? (Date.now() - Date.parse(edition.generatedAt)) / 60000 : Infinity;
const stale = FORCE || !edition || ageMinutes > FRESH_MINUTES;

if (stale) {
  // 先回答"现在能不能访问境外源"，再决定抓多少个源。
  // 不做这一步的话，没开代理时每个境外源都要白白超时重试一轮。
  const decision = await resolveOverseas();
  if (decision.overseas === 'on') {
    console.log(`  本次收录全部源（${decision.how}）。`);
  } else {
    console.log('  本次只收录国内与可直连的源。境外源随时可以再补：开代理后重新双击本文件即可。');
  }

  const env = { ...process.env, NEWS_OVERSEAS: decision.overseas };
  if (decision.proxy) {
    env.NODE_USE_ENV_PROXY = '1';
    env.HTTPS_PROXY = decision.proxy;
    env.HTTP_PROXY = decision.proxy;
  }

  line();
  console.log('\n  [抓取] 正在拉取最新新闻，大约需要 30 秒，请稍等...\n');
  const code = await run(process.execPath, [path.join(ROOT, 'scripts', 'fetch_news.mjs')], env);
  if (code !== 0) {
    console.log('\n  抓取没有成功（多半是网络问题）。仍会打开阅读器，显示上一期的内容。');
  }
} else {
  const mins = Math.round(ageMinutes);
  console.log(`\n  上一期是 ${mins} 分钟前抓取的（${edition.date}，${edition.total} 条），跳过抓取。`);
  console.log('  想立刻更新：停掉本窗口，再执行  npm run fetch');
}

line();
console.log('\n  正在启动阅读器，浏览器会自动打开...');
line();

await import(new URL('./serve.mjs', import.meta.url).href);
