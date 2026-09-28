/**
 * 网络环境探测与"是否翻墙"的决策
 *
 * 背景：feeds.json 里有 28 个境外源（标记 needsProxy）在国内直连不通。
 * 不检测就直接抓，每个源都要白白超时重试一轮，整次抓取会被拖慢好几分钟。
 * 所以抓取之前先回答一个问题：现在能不能访问境外源？
 *
 * 判断顺序：直连 → 配置里记过的代理 → 扫描常见本地代理端口 → 询问用户。
 * 结论会记在 config.local.json，下次不再重复问。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'config.local.json');
const NETPROBE = path.join(ROOT, 'scripts', 'netprobe.mjs');

/**
 * 用 BBC 的订阅源当试金石：它正是我们要抓的源之一，通不通最有代表性。
 * 可用环境变量 NEWS_PROBE_URL 换成别的地址（例如排查、或换一个境外源试）。
 */
export const OVERSEAS_PROBE_URL = process.env.NEWS_PROBE_URL || 'https://feeds.bbci.co.uk/news/world/rss.xml';

/** 常见代理客户端的本地端口：Clash / Clash Verge / v2rayN / Privoxy / Surge 等 */
export const PROXY_PORTS = [7890, 7897, 7891, 10809, 1080, 8118, 8889, 8080, 8888, 6152];

/* ---------------------------------------------------------- 配置读写 */

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/* ---------------------------------------------------------- 连通性测试 */

/** 直连能否访问境外源 */
export function probeDirect(timeoutMs = 8000) {
  const r = spawnSync(process.execPath, [NETPROBE, OVERSEAS_PROBE_URL, String(timeoutMs)], {
    stdio: 'ignore',
    cwd: ROOT,
  });
  return r.status === 0;
}

/** 走指定代理能否访问境外源 */
export function probeWithProxy(proxy, timeoutMs = 12000) {
  const r = spawnSync(process.execPath, [NETPROBE, OVERSEAS_PROBE_URL, String(timeoutMs)], {
    stdio: 'ignore',
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
    },
  });
  return r.status === 0;
}

function tcpOpen(port, timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/** 先快速看哪些端口在监听，再逐个验证是不是真能翻墙的代理 */
export async function scanLocalProxy() {
  const open = [];
  for (const port of PROXY_PORTS) {
    if (await tcpOpen(port)) open.push(port);
  }
  for (const port of open) {
    const proxy = `http://127.0.0.1:${port}`;
    if (probeWithProxy(proxy, 9000)) return proxy;
  }
  return null;
}

/* ---------------------------------------------------------- 交互询问 */

export async function askOverseas() {
  console.log('');
  console.log('  现在有两种抓取模式：');
  console.log('    开启代理 → 收录全部 107 个源（含 BBC、纽约时报、卫报、经济学人等 28 个境外源）');
  console.log('    不开代理 → 只收录 79 个国内与可直连的源，跳过境外源，抓取也更快');
  console.log('');
  console.log('    [1] 我这就去开代理，开好后按回车重试');
  console.log('    [2] 帮我扫描本地代理端口（Clash 等默认端口）');
  console.log('    [3] 本次跳过境外源，直接开始');
  console.log('    [4] 跳过境外源，并且以后不再询问');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const ans = (await rl.question('  请输入 1 / 2 / 3 / 4，直接回车等于 3：')).trim();
      if (ans === '1') {
        process.stdout.write('  重新检测... ');
        if (probeDirect(10000)) {
          process.stdout.write('通了\n');
          return { overseas: 'on', proxy: null };
        }
        process.stdout.write('还是不通\n');
        continue;
      }
      if (ans === '2') {
        process.stdout.write('  正在扫描本地代理端口... ');
        const proxy = await scanLocalProxy();
        if (proxy) {
          process.stdout.write(`找到了 ${proxy}\n`);
          return { overseas: 'on', proxy };
        }
        process.stdout.write('没找到可用的代理\n');
        continue;
      }
      if (ans === '4') return { overseas: 'off', remember: true };
      return { overseas: 'off', remember: false };
    }
  } finally {
    rl.close();
  }
}

/* ---------------------------------------------------------- 总决策 */

export async function resolveOverseas({ interactive = true } = {}) {
  const cfg = loadConfig();

  // 用户明确说过"以后不再询问"，就始终尊重这个选择，直到删掉 config.local.json。
  // 放在最前面，是为了让行为可预测：不会因为某天网络刚好通了就悄悄改变。
  if (cfg.overseas === 'off' && cfg.skipAsk) {
    console.log('\n  [网络检查] 按你上次的选择跳过境外源（想重新启用：删掉 config.local.json）。');
    return { overseas: 'off', proxy: null, how: '上次的选择' };
  }

  process.stdout.write('\n  [网络检查] 正在检测境外信息源（BBC、纽约时报等 28 个源）... ');
  if (probeDirect()) {
    process.stdout.write('可以直连\n');
    return { overseas: 'on', proxy: null, how: '直连' };
  }
  process.stdout.write('直连不通\n');

  if (cfg.proxy) {
    process.stdout.write(`  试一下上次记录里的代理 ${cfg.proxy} ... `);
    if (probeWithProxy(cfg.proxy)) {
      process.stdout.write('可用\n');
      return { overseas: 'on', proxy: cfg.proxy, how: '记录的代理' };
    }
    process.stdout.write('已失效\n');
  }

  process.stdout.write('  扫描本地代理端口... ');
  const found = await scanLocalProxy();
  if (found) {
    process.stdout.write(`发现可用代理 ${found}\n`);
    saveConfig({ proxy: found });
    return { overseas: 'on', proxy: found, how: '扫描到的代理' };
  }
  process.stdout.write('没有可用代理\n');

  if (!interactive || !process.stdin.isTTY) {
    console.log('  当前不是可交互终端，本次跳过境外源（不影响其余 79 个源）。');
    return { overseas: 'off', proxy: null, how: '非交互环境' };
  }

  const answer = await askOverseas();
  if (answer.remember) saveConfig({ overseas: 'off', skipAsk: true });
  return { ...answer, how: '手动选择' };
}

/**
 * 代理环境变量必须在 Node 启动前设好，所以需要时重新拉起自己。
 * 返回 true 表示"已经重新拉起了"，调用方应立即 return。
 */
export function reexecWithProxy(proxy) {
  if (!proxy || process.env.RIZHILU_PROXY_APPLIED === '1') return false;
  const result = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      RIZHILU_PROXY_APPLIED: '1',
      NEWS_OVERSEAS: 'on',   // 代理已确定可用，子进程不必再检测一遍
    },
  });
  process.exit(result.status ?? 0);
}
