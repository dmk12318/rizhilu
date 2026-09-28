#!/usr/bin/env node
/**
 * 最小连通性探针：能访问就退出码 0，否则 1。
 * 单独做成一个进程，是因为 NODE_USE_ENV_PROXY 必须在 Node 启动前设置，
 * 只有在子进程里带上代理环境变量，才能真正验证"走代理能不能通"。
 *
 * 用法：node scripts/netprobe.mjs <url> [超时毫秒]
 */

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] || 7000);

// 注意：这里不能写 process.exit()。
// Windows 上如果还有异步句柄（fetch 的连接）正在关闭，process.exit 会触发
// libuv 断言崩溃（0xC0000409），返回值看起来就像"网络不通"。
// 正确做法是设置 exitCode，让进程自己结束。
if (!url) {
  process.exitCode = 2;
} else {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    process.exitCode = res.ok ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}
