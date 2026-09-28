/* ============================================================
   日知录 · 前端逻辑
   数据来源：data/days.json、data/news/<date>.json、editorial/<date>.md
   ============================================================ */

const TZ = 'Asia/Shanghai';
const LS = {
  read: 'rzl:read',
  fav: 'rzl:fav',
  theme: 'rzl:theme',
};

const state = {
  days: [],
  date: null,
  data: null,
  editorials: [],
  cat: 'all',
  q: '',
  filters: { unread: false, fav: false, zh: false },
  limit: 40,
};

const el = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* -------------------------------------------------- 本地存储 */

function loadSet(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}
let readSet = loadSet(LS.read);
let favSet = loadSet(LS.fav);

const saveSet = (key, set) => localStorage.setItem(key, JSON.stringify([...set]));

/* -------------------------------------------------- 小工具 */

const dayKey = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relativeTime(iso) {
  const then = new Date(iso);
  const diff = Date.now() - then.getTime();
  const mins = Math.round(diff / 60000);
  const hhmm = then.toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  if (mins < -60) return `今天 ${hhmm}`;   // 源站把时间写到了未来，直接显示钟点
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 20) return `${hours} 小时前`;
  const today = dayKey(new Date());
  const day = dayKey(then);
  const yesterday = dayKey(new Date(Date.now() - 864e5));
  if (day === today) return `今天 ${hhmm}`;
  if (day === yesterday) return `昨天 ${hhmm}`;
  return then.toLocaleString('zh-CN', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace('/', '-');
}

function fullTime(iso) {
  return new Date(iso).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
}

const debounce = (fn, ms = 180) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/* -------------------------------------------------- 迷你 Markdown 渲染 */

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  return out;
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let quote = [];
  let inCode = false;
  let codeBuf = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      html.push(`<blockquote>${quote.map((q) => `<p>${inline(q)}</p>`).join('')}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (/^```/.test(line)) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushAll();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    if (!line.trim()) { flushAll(); continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushAll(); html.push('<hr>'); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushAll();
      const level = Math.min(h[1].length, 4);
      let content = h[2].trim();
      // 【标签】标题 → 标签徽章 + 标题
      const tagged = content.match(/^【([^】]{1,12})】\s*(.*)$/);
      if (tagged && level === 3) {
        content = `<span class="angle">${escapeHtml(tagged[1])}</span><span>${inline(tagged[2])}</span>`;
        html.push(`<h3>${content}</h3>`);
      } else {
        html.push(`<h${level}>${inline(content)}</h${level}>`);
      }
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushPara(); flushList();
      quote.push(line.replace(/^>\s?/, ''));
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara(); flushQuote();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { flushList(); html.push(`<${want}>`); list = want; }
      html.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }

    flushList(); flushQuote();
    para.push(line.trim());
  }
  flushAll();
  if (inCode && codeBuf.length) html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  return html.join('\n');
}

function parseFrontMatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

/* -------------------------------------------------- 数据加载 */

async function fetchJson(path, { fresh = false } = {}) {
  const url = fresh ? `${path}?t=${Date.now()}` : path;
  const res = await fetch(url, { cache: fresh ? 'reload' : 'default' });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function boot({ fresh = false } = {}) {
  const index = await fetchJson('data/days.json', { fresh });
  state.days = index.days || [];
  if (!state.days.length) {
    renderMissing('还没有任何一期数据。请先在项目目录运行 <code>npm run fetch</code> 抓取新闻。');
    return;
  }
  const hashDate = decodeURIComponent(location.hash.replace(/^#\/?/, '').split('/')[0] || '');
  const hashCat = decodeURIComponent(location.hash.replace(/^#\/?/, '').split('/')[1] || '');
  const wanted = state.days.some((d) => d.date === hashDate) ? hashDate : state.days[0].date;
  if (hashCat) state.cat = hashCat;
  await loadDate(wanted);
}

async function loadDate(date) {
  state.limit = 40;
  state.date = date;
  location.hash = `#/${date}${state.cat !== 'all' ? '/' + state.cat : ''}`;
  const [data, sources] = await Promise.all([
    fetchJson(`data/news/${date}.json`),
    fetchJson('data/sources.json').catch(() => null),
  ]);
  state.data = data;
  state.sources = sources;
  await loadEditorial(date);
  render();
}

async function loadEditorial(date) {
  // 一共四份：两大栏 × 两小栏
  //   主编专栏   云端版 <日期>.md        精修版 <日期>.codex.md
  //   境外要闻   云端版 <日期>.world.md  精修版 <日期>.world.codex.md
  const SOURCES = [
    { group: 'main', key: 'codex', path: `editorial/${date}.codex.md` },
    { group: 'main', key: 'cloud', path: `editorial/${date}.md` },
    { group: 'world', key: 'codex', path: `editorial/${date}.world.codex.md` },
    { group: 'world', key: 'cloud', path: `editorial/${date}.world.md` },
  ];
  const found = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.path);
      if (!res.ok) continue;
      const md = await res.text();
      const { meta, body } = parseFrontMatter(md);
      const html = renderMarkdown(body);
      const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const editor = meta.editor || (src.key === 'cloud' ? '云端主编' : 'Codex');
      found.push({
        group: src.group,
        key: src.key,
        editor,
        label: /codex/i.test(editor) ? '主编精修' : '云端版',
        updated: meta.updated || '',
        title: titleMatch ? titleMatch[1].trim() : '',
        html: titleMatch ? html.replace(titleMatch[0], '') : html,
      });
    } catch {
      /* 这一版不存在，跳过 */
    }
  }
  state.editorials = found;
}

/* 折叠状态存在本地：哪个版本收起来，下次打开还是收起来 */
function loadCollapseState() {
  try {
    return JSON.parse(localStorage.getItem('rzl:collapse') || '{}');
  } catch {
    return {};
  }
}

function saveCollapseState(next) {
  localStorage.setItem('rzl:collapse', JSON.stringify(next));
}

/* -------------------------------------------------- 今日速览（自动要目） */

function buildBriefing(items, cats) {
  const catRank = Object.fromEntries(cats.map((c, i) => [c.id, i]));
  // 要目只收"公共议题"：剔除赛事、娱乐、活动预告与无摘要的通稿残片
  const NOT_NEWSWORTHY = /亚运会|奥运会|世界杯|全运会|夺金|金牌|夺冠|锦标赛|公开赛|联赛|半决赛|决赛|球赛|演出|演唱会|音乐节|综艺|票房|剧组|开售|预售|发布会|直播预告|报名|｜/;
  const pool = items.filter((it) =>
    it.category !== 'society' &&
    !NOT_NEWSWORTHY.test(it.title) &&
    (it.summary?.length || 0) >= 30);

  const scored = pool.map((it) => {
    const ageHours = (Date.now() - Date.parse(it.published)) / 3600000;
    const recency = Math.sqrt(Math.max(0, 30 - ageHours) / 30);   // 时效开方，避免"刚发布"碾压一切
    const crossSource = (it.alsoIn?.length || 0) * 1.1;           // 多家跟进 = 当日真正的公共议题
    const weight = 1 - (catRank[it.category] ?? 3) * 0.07;
    const zhBonus = it.lang === 'zh' ? 0.3 : 0;
    return { it, score: recency * 2 + crossSource + weight + zhBonus };
  }).sort((a, b) => b.score - a.score);

  const norm = (s) => s.toLowerCase().replace(/[\s\u3000]+/g, '')
    .replace(/[【】\[\]（）()「」《》"'“”‘’·—\-–_:：,，.。!！?？|/\\]/g, '');
  const trigrams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 2; i += 1) out.add(s.slice(i, i + 3));
    return out;
  };
  const tooSimilar = (a, b) => {
    if (a === b) return true;
    if (a.length < 8 || b.length < 8) return false;
    const ga = trigrams(a);
    const gb = trigrams(b);
    let hit = 0;
    for (const g of ga) if (gb.has(g)) hit += 1;
    return hit / (ga.size + gb.size - hit) >= 0.45;
  };

  /** 英文标题按实词重合度判重（同一事件被两家媒体用不同措辞报道时，三元组法会漏掉） */
  const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'as', 'by',
    'with', 'from', 'is', 'are', 'was', 'were', 'be', 'it', 'its', 'that', 'this', 'said', 'says',
    'after', 'over', 'into', 'will', 'has', 'have', 'had', 'not', 'but', 'or', 'his', 'her', 'their']);
  const contentWords = (s) => new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
  const wordOverlap = (a, b) => {
    if (a.size < 4 || b.size < 4) return 0;
    let hit = 0;
    for (const w of a) if (b.has(w)) hit += 1;
    return hit / Math.min(a.size, b.size);
  };

  const picked = [];
  const pickedTitles = [];
  const pickedWords = [];
  const perCat = {};
  const perSource = new Set();
  for (const { it } of scored) {
    const n = perCat[it.category] || 0;
    if (n >= 2) continue;
    if (perSource.has(it.source)) continue;   // 同一家媒体只出一题，逼出跨源多样性
    if (it.title.length < 8) continue;
    const key = norm(it.title);
    if (pickedTitles.some((t) => tooSimilar(t, key))) continue;   // 同一事件只出现一次
    const words = contentWords(it.title);
    if (pickedWords.some((w) => wordOverlap(w, words) >= 0.55)) continue;
    perCat[it.category] = n + 1;
    perSource.add(it.source);
    pickedTitles.push(key);
    pickedWords.push(words);
    picked.push(it);
    if (picked.length >= 9) break;
  }
  return picked;
}

/* -------------------------------------------------- 渲染 */

function catMap() {
  return Object.fromEntries((state.data?.categories || []).map((c) => [c.id, c]));
}

function filteredItems() {
  const cats = catMap();
  const q = state.q.trim().toLowerCase();
  return (state.data?.items || []).filter((it) => {
    if (state.cat !== 'all' && it.category !== state.cat) return false;
    if (state.filters.unread && readSet.has(it.id)) return false;
    if (state.filters.fav && !favSet.has(it.id)) return false;
    if (state.filters.zh && it.lang !== 'zh') return false;
    if (q) {
      const hay = `${it.title} ${it.summary} ${it.source} ${cats[it.category]?.name || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  renderMasthead();
  renderTabs();
  renderEditorial();
  renderBriefing();
  renderList();
  renderFooter();
  renderStale();
}

function renderMasthead() {
  const idx = state.days.findIndex((x) => x.date === state.date);

  // 期数下拉框：历史每一期都能直接跳过去
  const pick = el('datePick');
  pick.innerHTML = state.days.map((d) => {
    const [, m, dd] = d.date.split('-');
    const weekday = new Date(`${d.date}T12:00:00+08:00`)
      .toLocaleDateString('zh-CN', { timeZone: TZ, weekday: 'short' });
    return `<option value="${d.date}">${Number(m)} 月 ${Number(dd)} 日 ${weekday} · ${d.total} 条</option>`;
  }).join('');
  pick.value = state.date;

  el('prevDay').disabled = idx >= state.days.length - 1;
  el('nextDay').disabled = idx <= 0;
  el('backLatest').hidden = idx <= 0;
}

function renderTabs() {
  const items = state.data?.items || [];
  const cats = state.data?.categories || [];
  const counts = {};
  for (const it of items) counts[it.category] = (counts[it.category] || 0) + 1;

  const tabs = [
    { id: 'all', name: '全部', color: 'var(--ink)' },
    ...cats.map((c) => ({ id: c.id, name: c.name, color: c.color })),
  ];

  el('tabs').innerHTML = tabs.map((t) => {
    const n = t.id === 'all' ? items.length : counts[t.id] || 0;
    return `<button class="tab" role="tab" data-cat="${t.id}" aria-selected="${state.cat === t.id}">
      <span style="color:${state.cat === t.id ? '' : t.color}">${t.name}</span>
      <span class="tab__count">${n}</span>
    </button>`;
  }).join('');
}

function renderEditorial() {
  const wrap = el('editorialWrap');
  const list = state.editorials || [];
  const saved = loadCollapseState();

  if (!list.length) {
    wrap.innerHTML = `<section class="colgroup">
      <div class="editorial" data-collapsed="false">
        <div class="editorial__head" role="note">
          <span class="editorial__badge">待撰写</span>
          <span class="editorial__meta">这一期还没有专栏</span>
        </div>
        <article class="editorial__body prose">
          <h1>专栏还没有写</h1>
          <blockquote><p>抓取只是把当天的原料摆上桌，真正把原料变成判断的那一步，由主编完成。</p></blockquote>
          <p>云端每天会写入 <code>editorial/${state.date}.md</code>（主编专栏）与 <code>editorial/${state.date}.world.md</code>（境外要闻）；电脑开着时，主编精修会另存为对应的 <code>.codex.md</code>。四份都会保留。</p>
        </article>
      </div>
    </section>`;
    return;
  }

  const GROUPS = [
    { id: 'main', title: '主编专栏', desc: '全部新闻的综合判断' },
    { id: 'world', title: '境外要闻', desc: '只归纳境外媒体的报道' },
  ];

  const byGroup = {};
  list.forEach((item) => {
    (byGroup[item.group] || (byGroup[item.group] = [])).push(item);
  });

  let rendered = 0;   // 用来决定默认展开哪一栏：只展开最靠前的那一栏
  wrap.innerHTML = GROUPS.map((group) => {
    const items = byGroup[group.id] || [];
    if (!items.length) return '';
    const inner = items.map((item) => {
      const colKey = `${item.group}:${item.key}`;
      const collapsed = colKey in saved ? saved[colKey] : rendered > 0;
      rendered += 1;
      const color = item.key === 'codex' ? 'var(--accent)' : '#1f5fbf';
      return `<section class="editorial" data-colkey="${colKey}" data-collapsed="${collapsed}" style="--cat:${color}">
        <button class="editorial__head" type="button" aria-expanded="${!collapsed}">
          <span class="editorial__badge">${escapeHtml(item.label)}</span>
          <span class="editorial__meta">主编：${escapeHtml(item.editor)}${item.updated ? ` · ${escapeHtml(item.updated)}` : ''}</span>
          <span class="editorial__toggle">${collapsed ? '展开 ▾' : '收起 ▴'}</span>
        </button>
        ${item.title ? `<h2 class="editorial__title">${item.title}</h2>` : ''}
        <article class="editorial__body prose">${item.html}</article>
      </section>`;
    }).join('');
    return `<section class="colgroup">
      <div class="colgroup__head">
        <h2 class="colgroup__title">${group.title}</h2>
        <span class="colgroup__desc">${group.desc}</span>
      </div>
      ${inner}
    </section>`;
  }).join('');
}

function renderBriefing() {
  const items = buildBriefing(state.data?.items || [], state.data?.categories || []);
  const section = el('briefingSection');
  if (items.length < 4) { section.hidden = true; return; }
  section.hidden = false;
  el('briefingList').innerHTML = items.map((it) => `
    <li>
      <div class="briefing__item">
        <a href="${escapeHtml(it.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a>
        <span class="briefing__src">${escapeHtml(it.source)}</span>
      </div>
    </li>`).join('');
}

function renderList() {
  const cats = catMap();
  const all = filteredItems();
  const shown = all.slice(0, state.limit);

  el('streamTitle').textContent =
    state.cat === 'all' ? '全部报道' : (cats[state.cat]?.name || '全部') + '报道';
  el('resultCount').textContent = all.length
    ? `${all.length} 条${all.length > shown.length ? `（显示 ${shown.length}）` : ''}`
    : '';

  const unread = all.filter((i) => !readSet.has(i.id)).length;
  el('list').innerHTML = shown.map((it) => {
    const cat = cats[it.category] || { name: it.category, color: 'var(--accent)' };
    const isRead = readSet.has(it.id);
    const isFav = favSet.has(it.id);
    const also = it.alsoIn?.length ? `<span class="card__also">另有 ${it.alsoIn.length} 家跟进</span>` : '';
    const timeLabel = it.undated ? '—' : relativeTime(it.published);
    const timeTitle = it.undated ? '该来源未提供发布时间' : fullTime(it.published);
    const summary = it.summary
      ? `<p class="card__summary">${escapeHtml(it.summary)}</p>`
      : '';
    return `<article class="card" data-id="${it.id}" data-read="${isRead}" style="--cat:${cat.color}">
      <div class="card__meta">
        <span class="card__cat">${escapeHtml(cat.name)}</span>
        <span class="card__source">${escapeHtml(it.source)}</span>
        <span class="card__time" title="${timeTitle}">${timeLabel}</span>
        ${also}
      </div>
      <h3 class="card__title"><a href="${escapeHtml(it.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a></h3>
      ${summary}
      <div class="card__actions">
        <button class="linklike" data-act="read" aria-pressed="${isRead}">${isRead ? '✓ 已读' : '标记已读'}</button>
        <button class="linklike" data-act="fav" aria-pressed="${isFav}">${isFav ? '★ 已收藏' : '☆ 收藏'}</button>
        <a class="card__open" href="${escapeHtml(it.link)}" target="_blank" rel="noopener noreferrer">查看原文 ↗</a>
      </div>
    </article>`;
  }).join('');

  el('loadmore').hidden = shown.length >= all.length;
  el('empty').hidden = all.length > 0;
  if (!all.length) {
    el('empty').innerHTML = state.filters.fav
      ? '还没有收藏任何报道。点开一条，按下 ☆ 收藏，之后可以在这里集中回看。'
      : state.filters.unread
        ? '这个板块的报道都已经读完了。'
        : '没有匹配的报道，换个关键词或切换板块试试。';
  }
  el('resultCount').textContent += all.length && unread !== all.length ? ` · 未读 ${unread}` : '';
}

function renderFooter() {
  const d = state.data;
  if (!d) return;
  const s = d.stats || {};
  const failed = state.sources?.failed?.length || 0;
  const skipped = s.sourcesSkipped ?? 0;
  const active = s.sourcesActive ?? s.sourcesConfigured ?? 0;
  const notes = [];
  if (failed) notes.push(`${failed} 个源本次不可用`);
  if (skipped) notes.push(`${skipped} 个境外源未参与（抓取时未开启代理）`);
  el('sourceNote').textContent =
    `本期收录 ${s.total ?? 0} 条报道，来自 ${Object.keys(s.bySource || {}).length} 家媒体；` +
    `信息源连通 ${s.sourcesOk ?? 0}/${active}${notes.length ? `（${notes.join('，')}）` : ''}。`;
  el('generatedAt').textContent = `生成时间 ${fullTime(d.generatedAt)}`;
  el('windowNote').textContent = `覆盖最近 ${d.windowHours || 24} 小时`;
}

function renderStale() {
  const box = el('stale');
  if (!state.data) { box.hidden = true; return; }
  const ageHours = (Date.now() - Date.parse(state.data.generatedAt)) / 3600000;
  const isLatest = state.date === state.days[0]?.date;
  if (isLatest && ageHours > 14) {
    box.hidden = false;
    box.innerHTML = `这一期是 ${Math.round(ageHours)} 小时前生成的数据，可能已经不是最新。` +
      `在项目目录运行 <code>npm run fetch</code> 即可更新。`;
  } else {
    box.hidden = true;
  }
}

function renderMissing(message) {
  el('list').innerHTML = '';
  el('empty').hidden = false;
  el('empty').innerHTML = message;
}

/* -------------------------------------------------- 交互 */

function goto(offset) {
  const idx = state.days.findIndex((x) => x.date === state.date);
  const next = state.days[idx + offset];
  if (next) loadDate(next.date);
}

function bind() {
  el('prevDay').addEventListener('click', () => goto(1));   // days 按时间倒序
  el('nextDay').addEventListener('click', () => goto(-1));
  el('datePick').addEventListener('change', (e) => {
    if (e.target.value && e.target.value !== state.date) loadDate(e.target.value);
  });
  el('backLatest').addEventListener('click', () => loadDate(state.days[0].date));
  el('brandHome').addEventListener('click', (e) => { e.preventDefault(); loadDate(state.days[0].date); });

  // 专栏折叠：点标题栏或大标题都能收放，状态记在本地
  el('editorialWrap').addEventListener('click', (e) => {
    const hit = e.target.closest('.editorial__head') || e.target.closest('.editorial__title');
    if (!hit) return;
    const section = hit.closest('.editorial');
    if (!section) return;
    const next = section.dataset.collapsed !== 'true';
    section.dataset.collapsed = String(next);
    section.querySelector('.editorial__head')?.setAttribute('aria-expanded', String(!next));
    const toggle = section.querySelector('.editorial__toggle');
    if (toggle) toggle.textContent = next ? '展开 ▾' : '收起 ▴';
    const saved = loadCollapseState();
    saved[section.dataset.colkey] = next;
    saveCollapseState(saved);
  });

  el('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.cat = btn.dataset.cat;
    state.limit = 40;
    location.hash = `#/${state.date}${state.cat !== 'all' ? '/' + state.cat : ''}`;
    renderTabs();
    renderList();
  });

  el('search').addEventListener('input', debounce((e) => {
    state.q = e.target.value;
    state.limit = 40;
    el('searchClear').hidden = !state.q;
    renderList();
  }, 140));

  el('searchClear').addEventListener('click', () => {
    el('search').value = '';
    state.q = '';
    el('searchClear').hidden = true;
    renderList();
  });

  $$('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.filter;
      state.filters[key] = !state.filters[key];
      chip.setAttribute('aria-pressed', String(state.filters[key]));
      state.limit = 40;
      renderList();
    });
  });

  el('list').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;

    if (act === 'fav') {
      favSet.has(id) ? favSet.delete(id) : favSet.add(id);
      saveSet(LS.fav, favSet);
      renderList();
      return;
    }
    if (act === 'read') {
      readSet.has(id) ? readSet.delete(id) : readSet.add(id);
      saveSet(LS.read, readSet);
      renderList();
      return;
    }
    if (e.target.closest('.card__open') || e.target.closest('.card__title a')) {
      if (!readSet.has(id)) {
        readSet.add(id);
        saveSet(LS.read, readSet);
        card.dataset.read = 'true';
        const btn = card.querySelector('[data-act="read"]');
        if (btn) { btn.textContent = '✓ 已读'; btn.setAttribute('aria-pressed', 'true'); }
      }
    }
  });

  el('loadmoreBtn').addEventListener('click', () => {
    state.limit += 40;
    renderList();
  });

  el('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(LS.theme, next);
    document.querySelector('meta[name="theme-color"]')
      .setAttribute('content', next === 'dark' ? '#131418' : '#faf7f2');
  });

  el('refreshBtn').addEventListener('click', async () => {
    el('refreshBtn').textContent = '…';
    try {
      await boot({ fresh: true });
      await loadDate(state.date);
    } finally {
      el('refreshBtn').textContent = '⟳';
    }
  });

  el('toTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  window.addEventListener('scroll', () => {
    el('toTop').hidden = window.scrollY < 600;
    el('masthead').classList.toggle('masthead--compact', window.scrollY > 220);
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) { e.preventDefault(); el('search').focus(); }
    if (typing && e.key === 'Escape') { el('search').blur(); }
    if (!typing && e.key === 'ArrowLeft') goto(1);
    if (!typing && e.key === 'ArrowRight') goto(-1);
  });

  window.addEventListener('hashchange', () => {
    const [date, cat] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
    if (date && date !== state.date) loadDate(date);
    else if (cat && cat !== state.cat) {
      state.cat = cat;
      state.limit = 40;
      renderTabs();
      renderList();
    }
  });
}

/* -------------------------------------------------- 启动 */

document.documentElement.dataset.theme = localStorage.getItem(LS.theme) || 'light';
bind();
boot().catch((err) => {
  renderMissing(`数据载入失败：${escapeHtml(err.message)}<br>请确认已运行 <code>npm run serve</code> 通过本地服务器打开本页（直接双击 HTML 文件无法读取数据）。`);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('assets/sw.js').catch(() => {});
  });
}
