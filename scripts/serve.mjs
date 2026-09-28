#!/usr/bin/env node
/**
 * 本地静态服务器（零依赖）。默认只监听本机，
 * 加 --lan 可让同一 Wi-Fi 下的手机访问，把网页装成桌面小程序。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5173);
const LAN = process.argv.includes('--lan');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const OPEN = !process.argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let target = path.join(ROOT, urlPath);
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let stat = await fsp.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = await fsp.stat(target).catch(() => null);
    }
    if (!stat?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 未找到：' + urlPath);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const noCache = ['.html', '.js', '.css', '.json', '.md', '.webmanifest'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
    });
    fs.createReadStream(target).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`\n  端口 ${PORT} 已被占用。`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/data/days.json`);
    if (res.ok) {
      console.log(`  日知录看起来已经在运行了，直接打开即可：http://localhost:${PORT}/`);
      console.log('  无需重复启动（如果想重启，先关闭上一个窗口）。\n');
      process.exitCode = 0;   // 不用 process.exit：Windows 上会撞上 libuv 断言
      return;
    }
  } catch {
    /* 端口被别的程序占用 */
  }
  console.log('  占用该端口的不是日知录，请先关闭那个程序，或换端口启动：');
  console.log(`  PowerShell 里执行  $env:PORT=5174; npm run serve\n`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const local = `http://localhost:${PORT}/`;
  console.log('\n  日知录已就绪');
  console.log(`  本机访问：${local}`);
  if (LAN) {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    for (const ip of ips) console.log(`  手机访问：http://${ip}:${PORT}/   （需与电脑同一 Wi-Fi）`);
  }
  console.log('  按 Ctrl+C 停止\n');

  if (OPEN && process.platform === 'win32') {
    import('node:child_process').then(({ spawn }) => {
      spawn('cmd', ['/c', 'start', '', local], { detached: true, stdio: 'ignore' }).unref();
    });
  }
});
