#!/usr/bin/env node
/**
 * 单独做一次网络检查，看看现在能不能访问境外信息源。
 * 用法：npm run netcheck
 */

import { resolveOverseas, loadConfig, OVERSEAS_PROBE_URL } from './net.mjs';

console.log(`\n  试金石：${OVERSEAS_PROBE_URL}`);

const decision = await resolveOverseas();

console.log('');
console.log(`  结论：${decision.overseas === 'on' ? '收录境外源' : '跳过境外源'}（${decision.how}）`);
if (decision.proxy) console.log(`  代理：${decision.proxy}`);
const cfg = loadConfig();
if (Object.keys(cfg).length) {
  console.log(`  已记住的选择：${JSON.stringify({ overseas: cfg.overseas, proxy: cfg.proxy, skipAsk: cfg.skipAsk })}`);
  console.log('  想重新询问：删掉项目根目录的 config.local.json');
}
