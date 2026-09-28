#!/usr/bin/env node
/**
 * 日知录 · 新闻抓取引擎
 * 零依赖：只使用 Node 内置模块。抓取 feeds.json 中所有 RSS/Atom/RDF 源，
 * 归一化后输出为 data/news/<YYYY-MM-DD>.json 与 data/days.json。
 *
 * 用法：
 *   node scripts/fetch_news.mjs            抓取并写入数据
 *   node scripts/fetch_news.mjs --check    只做连通性体检，不写文件
 *   NEWS_WINDOW_HOURS=36 node scripts/...  自定义回溯窗口（默认 24 小时）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const NEWS_DIR = path.join(DATA_DIR, 'news');
const TZ = 'Asia/Shanghai';
const CHECK_ONLY = process.argv.includes('--check');
const WINDOW_HOURS = Number(process.env.NEWS_WINDOW_HOURS || 24);
const RETENTION_DAYS = Number(process.env.NEWS_RETENTION_DAYS || 45);
const TIMEOUT_MS = Number(process.env.NEWS_TIMEOUT_MS || 18000);
const CONCURRENCY = Number(process.env.NEWS_CONCURRENCY || 12);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------- 文本工具

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', times: '×',
  laquo: '«', raquo: '»', sbquo: '‚', bdquo: '„', dagger: '†', permil: '‰',
};

function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return Object.hasOwn(NAMED, body) ? NAMED[body] : whole;
  });
}

/**
 * 摘要清洗。有些源（InfoQ、IT之家等）把整段 HTML 做了实体编码，
 * 必须先解码再剥标签，而且要来回两遍，否则 <p data-vmark=...> 会被当成正文留下。
 */
function stripHtml(input) {
  let text = String(input || '');
  for (let pass = 0; pass < 2; pass += 1) {
    text = decodeEntities(text)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, ' ')
      .replace(/<[^>]*>/g, ' ');
  }
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/** 判定是否为基金/ETF 推广类噪音稿（标题里带六位基金代码是典型特征） */
function isNoise(title, patterns) {
  if (!patterns?.length) return false;
  return patterns.some((p) => new RegExp(p).test(title));
}

/** 摘要只剩"点击查看原文"之类的残渣时，宁可留空，让卡片只显示标题 */
function cleanupSummary(summary, title) {
  const text = String(summary || '').trim();
  if (text.length < 16) return '';
  const norm = (s) => s.replace(/[\s\u3000]+/g, '').replace(/[，。、！？：；,.!?:;]/g, '');
  if (norm(text) === norm(title)) return '';
  return text;
}

function decodeBuffer(buf, charsetHint) {
  const head = buf.subarray(0, 3000).toString('latin1');
  let charset = (charsetHint || '').toLowerCase().trim();
  if (!charset) {
    charset = (head.match(/encoding\s*=\s*["']([\w-]+)["']/i)?.[1] || '').toLowerCase();
  }
  const aliases = {
    'gb2312': 'gbk', 'gb-2312': 'gbk', 'gb18030': 'gb18030', 'big5': 'big5',
    'utf8': 'utf-8', 'utf-8': 'utf-8', 'ascii': 'utf-8', 'iso-8859-1': 'utf-8',
    'windows-1252': 'utf-8', 'shift_jis': 'shift_jis', 'euc-jp': 'euc-jp',
  };
  const norm = aliases[charset] || charset || 'utf-8';
  if (norm === 'utf-8') {
    const text = buf.toString('utf8');
    if (!text.includes('\uFFFD')) return text;
  }
  try {
    return new TextDecoder(norm, { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

// ---------------------------------------------------------------- 网络

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('空响应');
    const ctype = res.headers.get('content-type') || '';
    const hint = ctype.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || '';
    return decodeBuffer(buf, hint);
  } finally {
    clearTimeout(timer);
  }
}

/** 带退避重试的抓取：429/503 通常代表限流，等一等再试往往就通了。 */
async function fetchText(url, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetchOnce(url, TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      const retryable = err.status === 429 || err.status === 503 || err.status === 502 || !err.status;
      if (!retryable || i === attempts - 1) break;
      const wait = err.retryAfter ? err.retryAfter * 1000 : 1500 * 2 ** i;
      await sleep(Math.min(wait, 12000));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------- 解析

function tagText(block, names) {
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc}>`, 'i');
    const m = block.match(re);
    if (m && m[1].trim()) {
      const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
      return { raw, text: stripHtml(raw) };
    }
  }
  return null;
}

function tagAttr(block, names) {
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<${esc}\\b([^>]*)>`, 'i');
    const m = block.match(re);
    if (m) {
      const attrs = m[1];
      const url = attrs.match(/(?:url|href)\s*=\s*["']([^"']+)["']/i)?.[1];
      if (url) return decodeEntities(url.trim());
    }
  }
  return '';
}

function absolutize(url, base) {
  if (!url) return '';
  const clean = decodeEntities(url).trim();
  if (!clean || clean.startsWith('data:')) return '';
  try {
    return new URL(clean, base).toString();
  } catch {
    return /^https?:\/\//i.test(clean) ? clean : '';
  }
}

function pickLink(block, base) {
  const direct = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (direct) {
    const inner = direct[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
    if (inner && !/^</.test(inner)) {
      const abs = absolutize(inner, base);
      if (abs) return abs;
    }
  }
  const linkTags = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  if (linkTags.length) {
    const preferred =
      linkTags.find((a) => /rel\s*=\s*["']alternate["']/i.test(a) || /type\s*=\s*["']text\/html["']/i.test(a)) ||
      linkTags[0];
    const href = preferred.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    const abs = absolutize(href, base);
    if (abs) return abs;
  }
  const guid = block.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
  if (guid) {
    const abs = absolutize(guid[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(), base);
    if (abs) return abs;
  }
  const about = block.match(/\brdf:about\s*=\s*["']([^"']+)["']/i);
  if (about) return absolutize(about[1], base);
  return '';
}

function pickDate(block) {
  const t = tagText(block, ['pubDate', 'published', 'updated', 'dc:date', 'date', 'dc:created', 'lastBuildDate']);
  if (!t) return null;
  const value = t.text.trim();
  let ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    // 2026-09-28 08:05 这类无时区的写法，按东八区解释
    const m = value.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const [, y, mo, d, h, mi, s] = m;
      ms = Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +(s || 0));
    }
  }
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  // 明显的脏数据（早于 2000 年或晚于现在 3 天）直接丢弃
  const now = Date.now();
  if (date.getTime() < Date.UTC(2000, 0, 1) || date.getTime() > now + 3 * 864e5) return null;
  return date;
}

function parseFeed(xml, feed) {
  const head = xml.slice(0, 4000);
  const isAtom = /<feed[\s>]/i.test(head) && !/<rss[\s>]/i.test(head);
  const container = isAtom ? 'entry' : 'item';
  const re = new RegExp(`<${container}\\b[^>]*>([\\s\\S]*?)<\\/${container}>`, 'gi');
  const blocks = [...xml.matchAll(re)].map((m) => m[1]);
  if (!blocks.length) throw new Error('未解析到条目');

  return blocks
    .map((block) => {
      const title = tagText(block, ['title']);
      if (!title || title.text.length < 4) return null;
      const summarySource =
        tagText(block, ['description', 'content:encoded', 'summary', 'content', 'excerpt'])?.text || '';
      const link = pickLink(block, feed.url);
      const published = pickDate(block);
      const imageRaw =
        tagAttr(block, ['media:content', 'media:thumbnail', 'enclosure']) ||
        block.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i)?.[1] ||
        '';
      return {
        title: title.text.slice(0, 300),
        summary: summarySource.slice(0, 400),
        link,
        image: absolutize(imageRaw, feed.url),
        published: published ? published.toISOString() : null,
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------- 归一化

function dayKey(date) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[【】\[\]（）()「」《》"'“”‘’·—\-–_:：,，.。!！?？|/\\]/g, '');
}

function itemId(feedName, link, title) {
  const basis = (link || '') + '|' + normalizeTitle(title);
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 8 || b.length < 8) return 0;
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 2; i += 1) out.add(s.slice(i, i + 3));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / (ga.size + gb.size - hit);
}

// ---------------------------------------------------------------- 并发控制

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const startedAt = Date.now();
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'feeds.json'), 'utf8'));
  const catById = new Map(config.categories.map((c) => [c.id, c]));
  const defaultMax = config.defaultMax || 20;
  const now = new Date();
  const since = now.getTime() - WINDOW_HOURS * 3600 * 1000;

  // ---- 境外源开关：直连不通时就跳过它们，不做无谓的超时重试
  let overseas = (process.env.NEWS_OVERSEAS || 'auto').toLowerCase();
  let overseasHow = '环境变量指定';
  if (overseas === 'auto') {
    const { resolveOverseas, reexecWithProxy } = await import('./net.mjs');
    const decision = await resolveOverseas({ interactive: !CHECK_ONLY });
    overseas = decision.overseas;
    overseasHow = decision.how;
    if (decision.proxy) reexecWithProxy(decision.proxy);   // 带着代理环境变量重启本脚本
  }

  const overseasOn = overseas !== 'off';
  const activeFeeds = config.feeds.filter((f) => overseasOn || !f.needsProxy);
  const skippedFeeds = config.feeds.filter((f) => !overseasOn && f.needsProxy);

  console.log(`\n  日知录 · 抓取开始  ${now.toLocaleString('zh-CN', { timeZone: TZ })}`);
  console.log(`  信息源 ${activeFeeds.length} 个（配置共 ${config.feeds.length} 个）· 回溯窗口 ${WINDOW_HOURS} 小时`);
  if (skippedFeeds.length) {
    const names = skippedFeeds.map((f) => f.name);
    console.log(`  按「${overseasHow}」跳过 ${names.length} 个境外源：${names.slice(0, 6).join('、')}${names.length > 6 ? ' 等' : ''}`);
  }
  console.log('');

  const reports = await mapLimit(activeFeeds, CONCURRENCY, async (feed) => {
    const stamp = Date.now();
    try {
      const xml = await fetchText(feed.url);
      const raw = parseFeed(xml, feed);
      const feedSince = now.getTime() - (feed.windowHours || WINDOW_HOURS) * 3600 * 1000;
      // 无日期字段的源（如 Arts & Letters Daily）按原顺序赋予递减的合成时间
      const limited = raw
        .filter((it) => !isNoise(it.title, config.noisePatterns))
        .slice(0, feed.max || defaultMax)
        .map((it, index) => ({
          ...it,
          undated: !it.published,
          // 无日期字段的源：合成时间用于排序，但推到两小时前之后，避免抢占"最新"
          published: it.published || new Date(now.getTime() - 2 * 3600e3 - index * 20 * 60 * 1000).toISOString(),
        }));
      const fresh = limited.filter((it) => Date.parse(it.published) >= feedSince);
      const cost = Date.now() - stamp;
      if (CHECK_ONLY) {
        const mark = fresh.length ? '✓' : '·';
        console.log(`  ${mark} ${String(fresh.length).padStart(3)} 条  ${String(cost).padStart(5)}ms  ${feed.name}`);
        if (fresh[0]) console.log(`      └ ${fresh[0].title.slice(0, 62)}`);
      }
      return { feed, items: fresh, ok: true, ms: cost, rawCount: raw.length };
    } catch (err) {
      const cost = Date.now() - stamp;
      if (CHECK_ONLY) console.log(`  ✗   0 条  ${String(cost).padStart(5)}ms  ${feed.name}  → ${err.message}`);
      return { feed, items: [], ok: false, ms: cost, error: err.message };
    }
  });

  const okFeeds = reports.filter((r) => r.ok && r.items.length);
  const emptyFeeds = reports.filter((r) => r.ok && !r.items.length);
  const failed = reports.filter((r) => !r.ok);

  if (CHECK_ONLY) {
    console.log(
      `\n  体检完成：有效 ${okFeeds.length} / 空窗口 ${emptyFeeds.length} / 失败 ${failed.length}，` +
        `跳过 ${skippedFeeds.length}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
    );
    if (failed.length) {
      console.log('  需要处理的源：');
      for (const f of failed) console.log(`    - ${f.feed.name} (${f.feed.category}) → ${f.error}`);
      console.log('');
    }
    return;
  }

  // 汇总 + 归一化 + 去重
  const all = [];
  for (const report of reports) {
    for (const item of report.items) {
      const published = item.published ? new Date(item.published) : now;
      all.push({
        id: itemId(report.feed.name, item.link, item.title),
        title: item.title,
        summary: cleanupSummary(item.summary, item.title),
        link: item.link,
        image: item.image,
        source: report.feed.name,
        category: report.feed.category,
        lang: report.feed.lang || 'zh',
        region: report.feed.region || 'global',
        ...(item.undated ? { undated: true } : {}),
        published: published.toISOString(),
        norm: normalizeTitle(item.title),
      });
    }
  }

  all.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));

  const kept = [];
  for (const item of all) {
    if (kept.length >= 900) break;
    const twin = kept.find(
      (k) => k.norm === item.norm || (k.lang === item.lang && similarity(k.norm, item.norm) >= 0.72),
    );
    if (twin) {
      twin.alsoIn = twin.alsoIn || [];
      if (!twin.alsoIn.includes(item.source) && twin.alsoIn.length < 4) twin.alsoIn.push(item.source);
      continue;
    }
    kept.push(item);
  }

  const edition = dayKey(now);
  const counts = {};
  for (const item of kept) counts[item.category] = (counts[item.category] || 0) + 1;

  const payload = {
    date: edition,
    generatedAt: now.toISOString(),
    windowHours: WINDOW_HOURS,
    timezone: TZ,
    categories: config.categories,
    stats: {
      total: kept.length,
      rawTotal: all.length,
      sourcesConfigured: config.feeds.length,
      sourcesActive: activeFeeds.length,
      sourcesSkipped: skippedFeeds.length,
      overseas,
      sourcesOk: reports.filter((r) => r.ok).length,
      sourcesFailed: failed.length,
      counts,
      bySource: Object.fromEntries(
        [...new Set(kept.map((i) => i.source))].map((s) => [s, kept.filter((i) => i.source === s).length]),
      ),
    },
    items: kept.map(({ norm, ...rest }) => rest),
  };

  await fs.mkdir(NEWS_DIR, { recursive: true });
  await fs.writeFile(path.join(NEWS_DIR, `${edition}.json`), JSON.stringify(payload, null, 1), 'utf8');

  // 清理过期版本
  const existing = (await fs.readdir(NEWS_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const cutoff = dayKey(new Date(now.getTime() - RETENTION_DAYS * 864e5));
  for (const file of existing) {
    if (file.slice(0, 10) < cutoff) {
      await fs.rm(path.join(NEWS_DIR, file), { force: true });
      console.log(`  清理过期版本 ${file}`);
    }
  }

  // 生成日期索引
  const files = (await fs.readdir(NEWS_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  const days = [];
  for (const file of files) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(NEWS_DIR, file), 'utf8'));
      days.push({
        date: d.date,
        total: d.stats?.total ?? d.items?.length ?? 0,
        counts: d.stats?.counts || {},
        generatedAt: d.generatedAt,
      });
    } catch {
      /* 忽略损坏文件 */
    }
  }
  await fs.writeFile(
    path.join(DATA_DIR, 'days.json'),
    JSON.stringify({ updatedAt: now.toISOString(), days }, null, 1),
    'utf8',
  );

  await fs.writeFile(
    path.join(DATA_DIR, 'sources.json'),
    JSON.stringify(
      {
        updatedAt: now.toISOString(),
        overseas,
        skipped: skippedFeeds.map((f) => ({ name: f.name, category: f.category })),
        ok: reports.filter((r) => r.ok).map((r) => ({ name: r.feed.name, category: r.feed.category, count: r.items.length, ms: r.ms })),
        failed: failed.map((r) => ({ name: r.feed.name, category: r.feed.category, error: r.error })),
      },
      null,
      1,
    ),
    'utf8',
  );

  console.log(`  本期（${edition}）收录 ${kept.length} 条，去重合并 ${all.length - kept.length} 条`);
  for (const c of config.categories) {
    console.log(`    ${c.name.padEnd(4, '　')} ${String(counts[c.id] || 0).padStart(3)} 条`);
  }
  console.log(
    `  源状态：成功 ${reports.filter((r) => r.ok).length} / 失败 ${failed.length}` +
      `${skippedFeeds.length ? ` / 跳过 ${skippedFeeds.length}` : ''} · 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  if (failed.length) console.log(`  失败源：${failed.map((f) => f.feed.name).join('、')}`);
  console.log(`  写入 data/news/${edition}.json\n`);
}

export { fetchText, parseFeed, stripHtml, decodeBuffer, absolutize };

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error('\n  抓取失败：', err);
    process.exitCode = 1;
  });
}
