const TOKEN_STORE_KEY = 'anonforum.token';
const THEME_STORE_KEY = 'anonforum.theme';
const MY_REACTIONS_KEY = 'anonforum.myReactions';
const MENTIONS_SEEN_KEY = 'anonforum.mentionsSeen';
const HELP_SEEN_KEY = 'anonforum.helpSeen';
const SIDEBAR_WIDTH_KEY = 'anonforum.sidebarWidth';
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;
// Authoritative list lives on the server (REACTION_KIND_SET in server.js).
// Kept in sync manually — if you change one, change the other.
const REACTION_KINDS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const PSEUDONYM_RE = /^[a-f0-9]{8}$/;
const MENTION_IN_TEXT_RE = /@([A-Za-z0-9_]{3,32})|#(\d{1,10})/g;
const MAX_VISUAL_DEPTH = 4;
const MENTION_POLL_MS = 60_000;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};

function applyTheme(t) {
  if (document.documentElement.getAttribute('data-theme') === t) return;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_STORE_KEY, t);
}
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function getToken() {
  try {
    const raw = localStorage.getItem(TOKEN_STORE_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t.token || !t.pseudonym || !t.expires_at || t.expires_at < Date.now()) return null;
    return { ...t, display_name: t.display_name || t.pseudonym };
  } catch {
    return null;
  }
}
function setToken(t) { localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify(t)); }
function clearToken() { localStorage.removeItem(TOKEN_STORE_KEY); }
function tokenDisplayName(t) { return t ? (t.display_name || t.pseudonym) : null; }
function tokenIdentityLabel(t) {
  if (!t) return '未领取令牌 — 点击获取';
  const displayName = tokenDisplayName(t);
  return displayName !== t.pseudonym ? `身份：@${displayName}` : `匿名 ID：${t.pseudonym}`;
}

// "Did I react?" is a client-only concept: the server never returns per-user
// reaction state. Keyed by pseudonym so rotating/losing the token drops it.
function myReactionsFor(pseudonym) {
  if (!pseudonym) return {};
  try {
    const all = JSON.parse(localStorage.getItem(MY_REACTIONS_KEY) || '{}');
    return all[pseudonym] || {};
  } catch { return {}; }
}
function setMyReaction(pseudonym, postId, kind, on) {
  if (!pseudonym) return;
  let all;
  try { all = JSON.parse(localStorage.getItem(MY_REACTIONS_KEY) || '{}'); }
  catch { all = {}; }
  const byPost = all[pseudonym] || (all[pseudonym] = {});
  const list = byPost[postId] || [];
  const next = on ? [...new Set([...list, kind])] : list.filter((k) => k !== kind);
  if (next.length) byPost[postId] = next; else delete byPost[postId];
  if (!Object.keys(byPost).length) delete all[pseudonym];
  localStorage.setItem(MY_REACTIONS_KEY, JSON.stringify(all));
}

// Mention-inbox read state is keyed by the inbox target: per-token for
// anonymous posts, per-username for public admin handles.
function getMentionSeen(key) {
  if (!key) return 0;
  try {
    const all = JSON.parse(localStorage.getItem(MENTIONS_SEEN_KEY) || '{}');
    return all[key] || 0;
  } catch { return 0; }
}
function setMentionSeen(key, ms) {
  if (!key) return;
  let all;
  try { all = JSON.parse(localStorage.getItem(MENTIONS_SEEN_KEY) || '{}'); }
  catch { all = {}; }
  all[key] = ms;
  localStorage.setItem(MENTIONS_SEEN_KEY, JSON.stringify(all));
}

function fmtDate(ms) { return new Date(ms).toLocaleString('zh-CN'); }
function fmtMeta(pseudonym, createdAt, editedAt) {
  const base = `${pseudonym} · ${fmtDate(createdAt)}`;
  return editedAt ? `${base} · 已编辑` : base;
}
// Deterministic hue in [0, 360) from either an 8-char pseudonym or a
// public admin username. The hue is inherited via a CSS custom property
// so author-colored text and borders cascade into inner `.meta` nodes
// without extra selectors.
function hueFromPseudonym(p) {
  if (typeof p !== 'string' || !p) return 140;
  if (PSEUDONYM_RE.test(p)) {
    const n = parseInt(p.slice(0, 6), 16);
    if (Number.isFinite(n)) return n % 360;
  }
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) % 360;
  return h;
}
function applyIdHue(node, pseudonym) {
  if (!node || !pseudonym) return;
  node.dataset.pseudonym = pseudonym;
  node.style.setProperty('--id-hue', String(hueFromPseudonym(pseudonym)));
}
function metaLine(pseudonym, createdAt, editedAt) {
  const node = el('div', { className: 'meta', textContent: fmtMeta(pseudonym, createdAt, editedAt) });
  applyIdHue(node, pseudonym);
  return node;
}

const VIEW = { EMPTY: 'empty-view', THREAD: 'thread-view', COMPOSE: 'compose-view', BULLETIN: 'bulletin-view' };
const viewNodes = Object.fromEntries(Object.values(VIEW).map((id) => [id, $('#' + id)]));
const readerNode = $('#reader');
let currentView = null;
let currentThread = null;
let currentComments = [];
let currentPostPseudonym = null;
let currentPostTags = [];
let currentPostCanDelete = false;
let feedPosts = [];
let filterState = { kind: null, value: null };
let mentionPollTimer = null;
let lastMentions = [];
let channels = [];
let bulletins = [];
let currentBulletin = null;
let savedIds = new Set();
// Per-user channel prefs: Map<channelId, { pinned, muted }>
let channelPrefs = new Map();
let mutedExpanded = false;
let followedIds = new Set();
let followedUnreadTotal = 0;
// channelId -> unread post count since last visit.
let channelUnread = new Map();
let isAdmin = false;
let currentUsername = null;
let adminHandles = [];
let adminHandleLookup = new Map();

function canonicalMentionHandle(handle) {
  if (typeof handle !== 'string') return null;
  const adminHandle = adminHandleLookup.get(handle.toLowerCase());
  if (adminHandle) return adminHandle;
  return PSEUDONYM_RE.test(handle) ? handle : null;
}

function currentMentionTarget(t = getToken()) {
  if (isAdmin && currentUsername) return currentUsername;
  return t ? tokenDisplayName(t) : null;
}

function mentionInboxKey(t = getToken()) {
  if (isAdmin && currentUsername) return `admin:${currentUsername.toLowerCase()}`;
  return t && t.pseudonym ? `token:${t.pseudonym}` : null;
}

function ownsAuthorKey(authorKey, t = getToken()) {
  return !!(authorKey && t && t.pseudonym === authorKey);
}

function canDeleteAuthor(authorKey, t = getToken()) {
  return isAdmin || ownsAuthorKey(authorKey, t);
}

function deleteRequestBody() {
  const t = getToken();
  if (t) return { token: t.token };
  return isAdmin ? {} : null;
}

function channelById(id) {
  if (id == null) return null;
  return channels.find((c) => c.id === id) || null;
}

function showReader(which) {
  if (currentView === which) return;
  for (const id of Object.values(VIEW)) viewNodes[id].hidden = id !== which;
  currentView = which;
  if (window.innerWidth <= 760) readerNode.classList.toggle('open', which !== VIEW.EMPTY);
}

function closeReader() {
  currentThread = null;
  currentBulletin = null;
  markActivePost(null);
  markActiveBulletin(null);
  showReader(VIEW.EMPTY);
  syncUrl(null);
}

const POST_PATH_RE = /^\/p\/(\d{1,10})$/;
const BULLETIN_PATH_RE = /^\/b\/(\d{1,10})$/;
function routeFromPath() {
  const p = POST_PATH_RE.exec(location.pathname);
  if (p) return { kind: 'post', id: parseInt(p[1], 10) };
  const b = BULLETIN_PATH_RE.exec(location.pathname);
  if (b) return { kind: 'bulletin', id: parseInt(b[1], 10) };
  return null;
}
function syncUrl(route) {
  const target = !route ? '/'
    : route.kind === 'bulletin' ? `/b/${route.id}`
    : `/p/${route.id}`;
  if (location.pathname === target) return;
  history.pushState(null, '', target);
}

function renderTokenChip() {
  const t = getToken();
  const chip = $('#token-toggle');
  const text = $('#token-chip-text');
  chip.classList.toggle('active', !!t);
  text.textContent = tokenIdentityLabel(t);
}

function renderTokenBox() {
  const box = $('#token-box');
  const t = getToken();
  box.innerHTML = '';
  if (!t) { box.textContent = '当前没有可用的发帖令牌。'; return; }
  const hrs = Math.max(0, Math.round((t.expires_at - Date.now()) / 3600000));
  box.appendChild(el('div', { textContent: t.token }));
  box.appendChild(el('div', {
    className: 'muted',
    textContent: `约 ${hrs} 小时后过期 · ${tokenIdentityLabel(t)}`,
  }));
}

let tokenQuota = { remaining: null, max: null, unlimited: false };

function renderTokenQuota() {
  const box = $('#token-quota');
  box.innerHTML = '';
  if (tokenQuota.unlimited) {
    box.append(
      el('span', { className: 'token-quota-label', textContent: '管理员身份：' }),
      el('strong', { className: 'token-quota-count', textContent: '无限轮换' }),
    );
    $('#new-token').disabled = false;
    $('#new-token').title = '';
    return;
  }
  if (tokenQuota.remaining == null) return;
  const exhausted = tokenQuota.remaining === 0;
  box.append(
    el('span', { className: 'token-quota-label', textContent: '今日剩余更换次数：' }),
    el('strong', {
      className: 'token-quota-count' + (exhausted ? ' is-zero' : ''),
      textContent: String(tokenQuota.remaining),
    }),
    el('span', { className: 'token-quota-max', textContent: ` / ${tokenQuota.max}` }),
  );
  $('#new-token').disabled = exhausted;
  $('#new-token').title = exhausted ? '今日令牌名额已用完，请明日再来' : '';
}

async function refreshQuota() {
  try {
    const me = await api('GET', '/api/me');
    tokenQuota = {
      remaining: me.tokens_remaining,
      max: me.max_tokens_per_day,
      unlimited: !!me.unlimited_tokens,
    };
  } catch {}
  renderTokenQuota();
}

function openDialog() {
  renderTokenBox();
  $('#token-err').textContent = '';
  $('#token-dialog').hidden = false;
  renderTokenQuota();
  refreshQuota();
}
function closeDialog() { $('#token-dialog').hidden = true; }
function closeMentionsDialog() { $('#mentions-dialog').hidden = true; }
function openConfirmRotate() {
  const t = getToken();
  const old = $('#confirm-rotate-old-pseudo');
  const displayName = tokenDisplayName(t);
  old.textContent = displayName ? `@${displayName}` : '—';
  if (displayName) applyIdHue(old, displayName); else { delete old.dataset.pseudonym; old.style.removeProperty('--id-hue'); }
  $('#confirm-rotate-err').textContent = '';
  $('#confirm-rotate-dialog').hidden = false;
}
function closeConfirmRotate() { $('#confirm-rotate-dialog').hidden = true; }

$('#token-toggle').addEventListener('click', openDialog);
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-close]');
  if (!t) return;
  const kind = t.dataset.close;
  if (kind === 'dialog') closeDialog();
  else if (kind === 'mentions') closeMentionsDialog();
  else if (kind === 'confirm-rotate') closeConfirmRotate();
  else if (kind === 'channel') closeChannelDialog();
  else if (kind === 'bulletin') closeBulletinDialog();
  else if (kind === 'followed') closeFollowedDialog();
  else if (kind === 'help') closeHelpDialog();
  else if (kind === 'reader') closeReader();
});

function openHelpDialog() {
  $('#help-dialog').hidden = false;
  try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch {}
}
function closeHelpDialog() { $('#help-dialog').hidden = true; }
$('#help-btn').addEventListener('click', openHelpDialog);

function openChannelDialog() {
  $('#channel-form').reset();
  $('#channel-err').textContent = '';
  $('#channel-dialog').hidden = false;
  $('#channel-form').slug.focus();
}
function closeChannelDialog() { $('#channel-dialog').hidden = true; }
$('#new-channel-btn').addEventListener('click', openChannelDialog);
$('#channel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#channel-err').textContent = '';
  try {
    await api('POST', '/api/channels', {
      slug: f.slug.value,
      name: f.name.value,
      description: f.description.value || null,
    });
    closeChannelDialog();
    await loadChannels();
  } catch (err) {
    $('#channel-err').textContent = err.message;
  }
});

async function refreshMe() {
  try {
    const me = await api('GET', '/api/me');
    tokenQuota = {
      remaining: me.tokens_remaining,
      max: me.max_tokens_per_day,
      unlimited: !!me.unlimited_tokens,
    };
    currentUsername = me.username;
    isAdmin = !!me.admin;
    adminHandles = Array.isArray(me.admin_handles) ? me.admin_handles : [];
    adminHandleLookup = new Map(adminHandles.map((h) => [h.toLowerCase(), h]));
    $('#new-channel-btn').hidden = !isAdmin;
    $('#auth-view').hidden = true;
    $('#forum-view').hidden = false;
    $('#userbar').innerHTML = '';
    $('#userbar').append(
      el('span', {
        className: 'user-pill',
        textContent: `@${me.username}${me.admin ? ' · 管理员' : ''}`,
      }),
      el('button', { textContent: '退出登录', onclick: logout }),
    );
    renderTokenChip();
    $('#new-bulletin-btn').hidden = !isAdmin;
    await loadChannels();
    await loadBulletins();
    await loadSavedIds();
    await loadChannelPrefs();
    await loadChannelUnread();
    await loadFollowed();
    await loadFeed();
    loadTags().catch(() => {});
    showReader(VIEW.EMPTY);
    const route = routeFromPath();
    if (route && route.kind === 'post') await openThread(route.id, { pushUrl: false });
    else if (route && route.kind === 'bulletin') await openBulletin(route.id, { pushUrl: false });
    schedulePollingMentions();
    refreshMentions({ silent: true }).catch(() => {});
    // Admins post under their username with no quota cost — auto-claim a
    // token on arrival so posting/reacting works without the dialog.
    if (isAdmin && !getToken()) issueNewToken($('#token-err')).catch(() => {});
    // First-time users see the onboarding dialog automatically.
    try {
      if (!localStorage.getItem(HELP_SEEN_KEY)) openHelpDialog();
    } catch {}
  } catch {
    currentUsername = null;
    isAdmin = false;
    adminHandles = [];
    adminHandleLookup = new Map();
    lastMentions = [];
    $('#auth-view').hidden = false;
    $('#forum-view').hidden = true;
    $('#userbar').innerHTML = '';
    $('#mention-dot').hidden = true;
    stopPollingMentions();
  }
}

async function logout() {
  await api('POST', '/api/logout');
  clearToken();
  stopPollingMentions();
  refreshMe();
}

async function authSubmit(endpoint) {
  $('#auth-err').textContent = '';
  const f = $('#login-form');
  try {
    await api('POST', endpoint, { username: f.username.value, password: f.password.value });
    f.reset();
    refreshMe();
  } catch (err) {
    $('#auth-err').textContent = err.message;
  }
}

$('#login-form').addEventListener('submit', (e) => { e.preventDefault(); authSubmit('/api/login'); });
$('#register-btn').addEventListener('click', () => authSubmit('/api/register'));

async function issueNewToken(errNode) {
  errNode.textContent = '';
  try {
    const r = await api('POST', '/api/token');
    setToken({
      token: r.token,
      pseudonym: r.pseudonym,
      display_name: r.display_name || r.pseudonym,
      expires_at: r.expires_at,
    });
    if (r.tokens_remaining != null) {
      tokenQuota = { remaining: r.tokens_remaining, max: r.max_tokens_per_day };
    }
    renderTokenBox();
    renderTokenChip();
    renderTokenQuota();
    refreshMentions({ silent: true }).catch(() => {});
    return true;
  } catch (err) {
    errNode.textContent = err.message;
    // Refresh on error so 429 (quota reached elsewhere) shows the true count.
    refreshQuota();
    return false;
  }
}

$('#new-token').addEventListener('click', () => {
  // First-time issuance, or admins whose identity stays @username, have
  // nothing to lose on rotation — skip the confirm dialog.
  if (!getToken() || isAdmin) { issueNewToken($('#token-err')); return; }
  openConfirmRotate();
});

$('#confirm-rotate-yes').addEventListener('click', async () => {
  const ok = await issueNewToken($('#confirm-rotate-err'));
  if (ok) closeConfirmRotate();
});

// --- Feed + filters ---

function renderFilterBar() {
  const bar = $('#filter-bar');
  bar.innerHTML = '';
  const label = $('#feed-label');
  if (!filterState.kind) {
    bar.hidden = true;
    label.textContent = '动态';
  } else {
    bar.hidden = false;
    let text, sub;
    if (filterState.kind === 'tag') {
      text = `筛选标签：#${filterState.value}`;
      sub = '动态 · 标签';
    } else if (filterState.kind === 'channel') {
      const ch = channelById(filterState.value);
      text = `频道：${ch ? ch.name : '—'}`;
      sub = '动态 · 频道';
    } else if (filterState.kind === 'saved') {
      text = '仅显示我收藏的';
      sub = '动态 · 收藏';
    } else {
      text = `搜索：${filterState.value}`;
      sub = '动态 · 搜索';
    }
    label.textContent = sub;
    bar.append(
      el('span', { className: 'filter-text', textContent: text }),
      el('button', { className: 'link-btn', type: 'button', textContent: '清除', onclick: clearFilter }),
    );
  }
  renderChannelList();
}

async function clearFilter() {
  filterState = { kind: null, value: null };
  $('#search-input').value = '';
  $('#search-clear').hidden = true;
  renderFilterBar();
  await loadFeed();
}

async function loadFeed() {
  const feed = $('#feed');
  feed.innerHTML = '';
  let rows;
  try {
    if (filterState.kind === 'tag') {
      rows = await api('GET', `/api/posts?tag=${encodeURIComponent(filterState.value)}`);
    } else if (filterState.kind === 'search') {
      rows = await api('GET', `/api/search?q=${encodeURIComponent(filterState.value)}`);
    } else if (filterState.kind === 'channel') {
      const ch = channelById(filterState.value);
      if (!ch) { clearFilter(); return; }
      rows = await api('GET', `/api/posts?channel=${encodeURIComponent(ch.slug)}`);
    } else if (filterState.kind === 'saved') {
      const r = await api('GET', '/api/saved');
      savedIds = new Set(r.ids);
      rows = r.posts;
    } else {
      rows = await api('GET', '/api/posts');
    }
  } catch (err) {
    feed.appendChild(el('div', { className: 'feed-empty', textContent: err.message }));
    feedPosts = [];
    return;
  }
  feedPosts = rows;
  renderFilterBar();
  if (!rows.length) {
    const msg = filterState.kind === 'search'
      ? '没有匹配的帖子。'
      : filterState.kind === 'tag'
      ? '这个标签下还没有帖子。'
      : filterState.kind === 'saved'
      ? '还没有收藏任何帖子。'
      : '还没有帖子。做第一个发帖的人吧。';
    feed.appendChild(el('div', { className: 'feed-empty', textContent: msg }));
    return;
  }
  for (const p of rows) feed.appendChild(renderPostCard(p));
  if (currentThread != null) markActivePost(currentThread);
}

async function loadTags() {
  const cloud = $('#tag-cloud');
  cloud.innerHTML = '';
  let tags;
  try { tags = await api('GET', '/api/tags'); } catch { return; }
  if (!tags.length) return;
  for (const t of tags.slice(0, 12)) {
    const chip = el('button', { type: 'button', className: 'tag-chip', title: `${t.n} 篇` });
    chip.append(
      el('span', { textContent: `#${t.tag}` }),
      el('span', { className: 'tag-chip-count', textContent: String(t.n) }),
    );
    chip.addEventListener('click', () => filterByTag(t.tag));
    cloud.appendChild(chip);
  }
}

async function filterByTag(tag) {
  filterState = { kind: 'tag', value: tag };
  $('#search-input').value = '';
  $('#search-clear').hidden = true;
  await loadFeed();
}

async function filterByChannel(channelId) {
  filterState = { kind: 'channel', value: channelId };
  $('#search-input').value = '';
  $('#search-clear').hidden = true;
  markChannelSeen(channelId).catch(() => {});
  await loadFeed();
}

async function loadChannels() {
  try { channels = await api('GET', '/api/channels'); }
  catch { channels = []; }
  renderChannelList();
  renderComposeChannels();
}

async function loadChannelPrefs() {
  try {
    const rows = await api('GET', '/api/channel-prefs');
    channelPrefs = new Map(rows.map((r) => [r.channel_id, { pinned: !!r.pinned, muted: !!r.muted }]));
  } catch {
    channelPrefs = new Map();
  }
  renderChannelList();
}

async function loadChannelUnread() {
  try {
    const rows = await api('GET', '/api/channel-unread');
    channelUnread = new Map(rows.map((r) => [r.channel_id, r.unread]));
  } catch {
    channelUnread = new Map();
  }
  renderChannelList();
}

async function markChannelSeen(channelId) {
  try {
    await api('POST', `/api/channels/${channelId}/seen`);
    channelUnread.set(channelId, 0);
    renderChannelList();
  } catch {}
}

function channelPrefFor(id) {
  return channelPrefs.get(id) || { pinned: false, muted: false };
}

async function setChannelPref(channelId, next) {
  try {
    const r = await api('POST', `/api/channel-prefs/${channelId}`, next);
    if (r.pinned || r.muted) channelPrefs.set(channelId, { pinned: r.pinned, muted: r.muted });
    else channelPrefs.delete(channelId);
    renderChannelList();
  } catch (err) { alert(err.message); }
}

function makeChannelPillButton(ch, activeId, opts = {}) {
  const pref = channelPrefFor(ch.id);
  const unread = channelUnread.get(ch.id) || 0;
  const btn = el('button', { type: 'button', className: 'channel-pill' });
  if (activeId === ch.id) btn.classList.add('is-active');
  if (pref.pinned) btn.classList.add('is-pinned');
  if (pref.muted) btn.classList.add('is-muted');
  if (unread > 0 && !pref.muted) btn.classList.add('has-unread');
  btn.title = ch.description || ch.name;
  btn.append(
    el('span', { className: 'channel-hash', textContent: pref.pinned ? '📌' : '#' }),
    el('span', { className: 'channel-name', textContent: ch.name }),
  );
  if (unread > 0 && !pref.muted) {
    btn.appendChild(el('span', {
      className: 'channel-unread-badge',
      textContent: unread > 99 ? '99+' : String(unread),
    }));
  } else {
    btn.appendChild(el('span', { className: 'channel-count', textContent: String(ch.post_count || 0) }));
  }
  btn.addEventListener('click', () => filterByChannel(ch.id));

  const pinBtn = el('span', {
    className: 'channel-pref-btn' + (pref.pinned ? ' is-on' : ''),
    title: pref.pinned ? '取消置顶' : '置顶频道',
    textContent: pref.pinned ? '📌' : '⇡',
  });
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setChannelPref(ch.id, { pinned: !pref.pinned, muted: pref.muted && !pref.pinned ? false : pref.muted });
  });
  btn.appendChild(pinBtn);

  const muteBtn = el('span', {
    className: 'channel-pref-btn' + (pref.muted ? ' is-on' : ''),
    title: pref.muted ? '取消静音' : '静音频道',
    textContent: pref.muted ? '🔕' : '🔔',
  });
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setChannelPref(ch.id, { pinned: pref.pinned && pref.muted ? false : pref.pinned, muted: !pref.muted });
  });
  btn.appendChild(muteBtn);

  if (opts.adminCanDelete && ch.slug !== 'general') {
    const del = el('span', { className: 'channel-del', title: '删除频道', textContent: '×' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除频道「${ch.name}」？该频道下的帖子会回到默认分区，不会被删除。`)) return;
      try {
        await api('DELETE', `/api/channels/${ch.id}`);
        if (filterState.kind === 'channel' && filterState.value === ch.id) {
          filterState = { kind: null, value: null };
        }
        await loadChannels();
        await loadFeed();
      } catch (err) { alert(err.message); }
    });
    btn.appendChild(del);
  }
  return btn;
}

function renderChannelList() {
  const box = $('#channel-list');
  if (!box) return;
  box.innerHTML = '';
  if (!channels.length) {
    box.appendChild(el('div', { className: 'muted channel-empty', textContent: '暂无频道' }));
    return;
  }
  const activeId = filterState.kind === 'channel' ? filterState.value : null;
  const opts = { adminCanDelete: isAdmin };
  const pinned = [], normal = [], muted = [];
  for (const ch of channels) {
    const pref = channelPrefFor(ch.id);
    if (pref.pinned) pinned.push(ch);
    else if (pref.muted) muted.push(ch);
    else normal.push(ch);
  }
  for (const ch of pinned) box.appendChild(makeChannelPillButton(ch, activeId, opts));
  for (const ch of normal) box.appendChild(makeChannelPillButton(ch, activeId, opts));
  if (muted.length) {
    const header = el('button', {
      type: 'button',
      className: 'channel-muted-header',
      textContent: mutedExpanded ? `▾ 静音 (${muted.length})` : `▸ 静音 (${muted.length})`,
    });
    header.addEventListener('click', () => {
      mutedExpanded = !mutedExpanded;
      renderChannelList();
    });
    box.appendChild(header);
    if (mutedExpanded) {
      for (const ch of muted) box.appendChild(makeChannelPillButton(ch, activeId, opts));
    }
  }
}

function renderComposeChannels() {
  const sel = $('#compose-channel');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  if (!channels.length) {
    sel.appendChild(el('option', { value: '', textContent: '（无可用频道）' }));
    return;
  }
  for (const ch of channels) {
    sel.appendChild(el('option', { value: String(ch.id), textContent: ch.name }));
  }
  if (prev && channels.some((c) => String(c.id) === prev)) sel.value = prev;
}

// --- Saved posts (account-scoped reader state) ---

async function loadSavedIds() {
  try {
    const r = await api('GET', '/api/saved');
    savedIds = new Set(r.ids);
  } catch {
    savedIds = new Set();
  }
}

let lastFollowedPosts = [];
async function loadFollowed() {
  try {
    const r = await api('GET', '/api/followed');
    followedIds = new Set(r.ids);
    lastFollowedPosts = r.posts || [];
    followedUnreadTotal = lastFollowedPosts.reduce((n, p) => n + (p.unread || 0), 0);
  } catch {
    followedIds = new Set();
    lastFollowedPosts = [];
    followedUnreadTotal = 0;
  }
  renderFollowedBadge();
}

function renderFollowedBadge() {
  const dot = $('#followed-badge');
  if (!dot) return;
  if (followedUnreadTotal > 0) {
    dot.hidden = false;
    dot.textContent = followedUnreadTotal > 99 ? '99+' : String(followedUnreadTotal);
  } else {
    dot.hidden = true;
  }
}

async function toggleFollow(postId) {
  const wasFollowed = followedIds.has(postId);
  try {
    await api(wasFollowed ? 'DELETE' : 'POST', `/api/followed/${postId}`);
    if (wasFollowed) followedIds.delete(postId); else followedIds.add(postId);
    await loadFollowed();
    renderThreadActions();
  } catch (err) {
    alert(err.message);
  }
}

async function markFollowedSeen(postId) {
  if (!followedIds.has(postId)) return;
  try {
    await api('POST', `/api/followed/${postId}`);
    await loadFollowed();
  } catch {}
}

function openFollowedDialog() {
  const box = $('#followed-list');
  box.innerHTML = '';
  if (!lastFollowedPosts.length) {
    box.appendChild(el('div', { className: 'muted', textContent: '还没有关注任何帖子。' }));
  } else {
    for (const p of lastFollowedPosts) box.appendChild(renderFollowedItem(p));
  }
  $('#followed-dialog').hidden = false;
}
function closeFollowedDialog() { $('#followed-dialog').hidden = true; }

function renderFollowedItem(p) {
  const title = el('div', { className: 'mention-head' });
  title.appendChild(el('span', { className: 'mention-sender', textContent: `#${p.post_id}` }));
  title.appendChild(el('span', { textContent: ' ' + p.title }));
  if (p.unread > 0) {
    title.appendChild(el('span', { className: 'follow-unread', textContent: `${p.unread} 条新评论` }));
  }
  const foot = el('div', { className: 'meta', textContent: `${p.pseudonym} · ${fmtDate(p.created_at)}` });
  applyIdHue(foot, p.pseudonym);
  const item = el('div', { className: 'mention-item-card' + (p.unread > 0 ? ' has-unread' : '') }, [title, foot]);
  item.addEventListener('click', () => {
    closeFollowedDialog();
    openThread(p.post_id).catch(() => {});
  });
  return item;
}

$('#followed-btn').addEventListener('click', () => {
  loadFollowed().finally(() => openFollowedDialog());
});

async function toggleSaved(postId) {
  const wasSaved = savedIds.has(postId);
  try {
    await api(wasSaved ? 'DELETE' : 'POST', `/api/saved/${postId}`);
    if (wasSaved) savedIds.delete(postId); else savedIds.add(postId);
    renderThreadActions();
    if (filterState.kind === 'saved') await loadFeed();
  } catch (err) {
    alert(err.message);
  }
}

async function filterBySaved() {
  filterState = { kind: 'saved', value: null };
  $('#search-input').value = '';
  $('#search-clear').hidden = true;
  await loadFeed();
}

// --- Bulletins ---

async function loadBulletins() {
  try { bulletins = await api('GET', '/api/bulletins'); }
  catch { bulletins = []; }
  renderBulletinList();
}

function renderBulletinList() {
  const box = $('#bulletin-list');
  if (!box) return;
  box.innerHTML = '';
  if (!bulletins.length) {
    box.appendChild(el('div', { className: 'muted bulletin-empty', textContent: '暂无公告' }));
    return;
  }
  for (const b of bulletins) {
    const btn = el('button', { type: 'button', className: 'bulletin-pill' });
    btn.dataset.bulletinId = String(b.id);
    btn.title = b.title;
    btn.append(
      el('span', { className: 'bulletin-title-text', textContent: b.title }),
      el('span', { className: 'bulletin-author', textContent: `@${b.author_username}` }),
    );
    btn.addEventListener('click', () => openBulletin(b.id));
    if (currentBulletin === b.id) btn.classList.add('is-active');
    box.appendChild(btn);
  }
}

function markActiveBulletin(id) {
  const wanted = id == null ? null : String(id);
  for (const n of $$('.bulletin-pill')) {
    n.classList.toggle('is-active', n.dataset.bulletinId === wanted);
  }
}

async function openBulletin(id, { pushUrl = true } = {}) {
  currentBulletin = id;
  currentThread = null;
  markActivePost(null);
  markActiveBulletin(id);
  if (pushUrl) syncUrl({ kind: 'bulletin', id });
  let row;
  try {
    row = await api('GET', `/api/bulletins/${id}`);
  } catch (err) {
    $('#bulletin-title').textContent = `公告 #${id}`;
    $('#bulletin-meta').textContent = '';
    $('#bulletin-body').innerHTML = '';
    $('#bulletin-body').appendChild(el('p', { className: 'muted', textContent: err.message || '未找到' }));
    $('#bulletin-actions').hidden = true;
    showReader(VIEW.BULLETIN);
    return;
  }
  $('#bulletin-title').textContent = row.title;
  const meta = $('#bulletin-meta');
  meta.textContent = `@${row.author_username} · ${fmtDate(row.created_at)}${row.updated_at ? ' · 已编辑' : ''}`;
  applyIdHue(meta, row.author_username);
  $('#bulletin-body').innerHTML = '';
  $('#bulletin-body').appendChild(renderMarkdown(row.content));
  renderBulletinActions(row);
  showReader(VIEW.BULLETIN);
  readerNode.scrollTo({ top: 0, behavior: 'instant' });
}

function renderBulletinActions(row) {
  const box = $('#bulletin-actions');
  box.innerHTML = '';
  if (!isAdmin) { box.hidden = true; return; }
  box.hidden = false;
  const edit = el('button', { type: 'button', className: 'ghost small', textContent: '编辑' });
  edit.addEventListener('click', () => openBulletinDialog(row));
  const del = el('button', { type: 'button', className: 'ghost small danger', textContent: '删除' });
  del.addEventListener('click', async () => {
    if (!confirm(`删除公告「${row.title}」？`)) return;
    try {
      await api('DELETE', `/api/bulletins/${row.id}`);
      bulletins = bulletins.filter((b) => b.id !== row.id);
      renderBulletinList();
      closeReader();
    } catch (err) { alert(err.message); }
  });
  box.append(edit, del);
}

function openBulletinDialog(existing) {
  const f = $('#bulletin-form');
  f.reset();
  $('#bulletin-err').textContent = '';
  $('#bulletin-dialog-title').textContent = existing ? '编辑公告' : '新建公告';
  $('#bulletin-submit').textContent = existing ? '保存' : '发布公告';
  f.dataset.editingId = existing ? String(existing.id) : '';
  if (existing) {
    f.title.value = existing.title;
    f.content.value = existing.content;
  }
  $('#bulletin-dialog').hidden = false;
  f.title.focus();
}
function closeBulletinDialog() { $('#bulletin-dialog').hidden = true; }

$('#new-bulletin-btn').addEventListener('click', () => openBulletinDialog(null));
$('#saved-filter-btn').addEventListener('click', () => filterBySaved());

// Image uploads: content-addressed, no user_id storage. The server
// strips EXIF via sharp before writing to disk.
async function uploadImage(file) {
  const t = getToken();
  const body = new FormData();
  body.append('image', file);
  if (t) body.append('token', t.token);
  const res = await fetch('/api/uploads', { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.url;
}

function insertAtCursor(textarea, text) {
  const v = textarea.value;
  const start = textarea.selectionStart ?? v.length;
  const end = textarea.selectionEnd ?? v.length;
  textarea.value = v.slice(0, start) + text + v.slice(end);
  const pos = start + text.length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
}

$('#post-image-btn').addEventListener('click', () => {
  const status = $('#post-image-status');
  status.textContent = '';
  const picker = el('input', {
    type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true,
  });
  document.body.appendChild(picker);
  picker.addEventListener('change', async () => {
    const file = picker.files && picker.files[0];
    picker.remove();
    if (!file) return;
    if (!getToken() && !isAdmin) { $('#post-err').textContent = '请先获取发帖令牌。'; openDialog(); return; }
    status.textContent = '上传中…';
    try {
      const url = await uploadImage(file);
      const ta = $('#post-form').querySelector('textarea[name=content]');
      insertAtCursor(ta, `![](${url})\n`);
      status.textContent = '已插入到正文。EXIF 已被剥离。';
    } catch (err) {
      status.textContent = err.message;
    }
  });
  picker.click();
});

$('#bulletin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#bulletin-err').textContent = '';
  const editingId = f.dataset.editingId ? parseInt(f.dataset.editingId, 10) : null;
  const body = { title: f.title.value, content: f.content.value };
  try {
    const row = editingId
      ? await api('PUT', `/api/bulletins/${editingId}`, body)
      : await api('POST', '/api/bulletins', body);
    const existingIdx = bulletins.findIndex((b) => b.id === row.id);
    if (existingIdx >= 0) bulletins[existingIdx] = row;
    else bulletins.unshift(row);
    renderBulletinList();
    closeBulletinDialog();
    await openBulletin(row.id, { pushUrl: true });
  } catch (err) {
    $('#bulletin-err').textContent = err.message;
  }
});

function renderPostCard(p) {
  const titleRow = el('div', { className: 'post-title-row' }, [
    el('span', { className: 'id-badge', textContent: `#${p.id}` }),
    el('span', { className: 'post-title', textContent: p.title }),
  ]);
  const preview = p.truncated ? p.content + '…' : p.content;
  const children = [titleRow];
  const ch = channelById(p.channel_id);
  if (ch) {
    const badge = el('button', {
      type: 'button', className: 'channel-badge small', textContent: ch.name, title: ch.description || ch.name,
    });
    badge.addEventListener('click', (e) => { e.stopPropagation(); filterByChannel(ch.id); });
    children.push(badge);
  }
  children.push(
    el('div', { className: 'post-preview', textContent: preview }),
    metaLine(p.pseudonym, p.created_at, p.edited_at),
  );
  if (p.tags && p.tags.length) {
    const tagRow = el('div', { className: 'card-tags' });
    for (const tag of p.tags) {
      const chip = el('button', { type: 'button', className: 'tag-pill', textContent: `#${tag}` });
      chip.addEventListener('click', (e) => { e.stopPropagation(); filterByTag(tag); });
      tagRow.appendChild(chip);
    }
    children.push(tagRow);
  }
  const node = el('div', { className: 'post' }, children);
  node.dataset.postId = p.id;
  node.addEventListener('click', () => openThread(p.id));
  return node;
}

function markActivePost(id) {
  const wanted = id == null ? null : String(id);
  for (const n of $$('.post')) {
    n.classList.toggle('active', n.dataset.postId === wanted);
  }
}

// --- Search ---

// `#<id>` or a bare positive integer is treated as a direct post lookup
// rather than an FTS query — the search input doubles as a jump-to-post box.
const POST_ID_SEARCH_RE = /^#?(\d{1,10})$/;

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) { clearFilter(); return; }
  const idMatch = POST_ID_SEARCH_RE.exec(q);
  if (idMatch) {
    const id = parseInt(idMatch[1], 10);
    if (id > 0) {
      $('#search-clear').hidden = false;
      await openThread(id);
      return;
    }
  }
  filterState = { kind: 'search', value: q };
  $('#search-clear').hidden = false;
  await loadFeed();
});
$('#search-input').addEventListener('input', () => {
  $('#search-clear').hidden = !$('#search-input').value;
});
$('#search-clear').addEventListener('click', clearFilter);

// --- Compose post ---

$('#compose-btn').addEventListener('click', openCompose);

function openCompose() {
  const f = $('#post-form');
  f.reset();
  renderComposeChannels();
  $('.compose-hint').textContent = isAdmin
    ? '管理员发言会直接显示用户名；其他令牌能力仍按 24 小时窗口管理。'
    : '服务器只记录令牌的哈希，无法把帖子和你连起来。';
  $('#post-submit').textContent = isAdmin ? '公开发布' : '匿名发布';
  // Preselect the channel we're filtering on, so the new post lands there.
  if (filterState.kind === 'channel' && channelById(filterState.value)) {
    f.channel_id.value = String(filterState.value);
  }
  $('#post-err').textContent = '';
  currentThread = null;
  markActivePost(null);
  showReader(VIEW.COMPOSE);
  f.title.focus();
}

function parseTagsInput(raw) {
  if (!raw) return [];
  return [...new Set(raw.trim().toLowerCase().split(/\s+/).filter(Boolean))];
}

$('#post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#post-err').textContent = '';
  const t = getToken();
  if (!t) { $('#post-err').textContent = '请先获取发帖令牌。'; openDialog(); return; }
  const f = e.target;
  const tags = parseTagsInput(f.tags.value);
  const rawCh = f.channel_id && f.channel_id.value;
  const channel_id = rawCh ? parseInt(rawCh, 10) : null;
  try {
    const created = await api('POST', '/api/posts', {
      token: t.token, title: f.title.value, content: f.content.value, tags, channel_id,
    });
    f.reset();
    const feed = $('#feed');
    const emptyMsg = feed.querySelector('.feed-empty');
    if (emptyMsg) emptyMsg.remove();
    feedPosts.unshift(created);
    feed.prepend(renderPostCard(created));
    loadTags().catch(() => {});
    const ch = channelById(created.channel_id);
    if (ch) { ch.post_count = (ch.post_count || 0) + 1; renderChannelList(); }
    await openThread(created.id);
  } catch (err) {
    $('#post-err').textContent = err.message;
  }
});

// --- Thread view ---

function knownMentionHandles() {
  const set = new Set();
  for (const handle of adminHandles) set.add(handle);
  if (currentPostPseudonym) set.add(currentPostPseudonym);
  for (const c of currentComments) set.add(c.pseudonym);
  return [...set];
}

function flashTarget(node) {
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.remove('flash');
  // Force reflow so re-adding the class restarts the animation.
  void node.offsetWidth;
  node.classList.add('flash');
}

function jumpToPseudonym(p) {
  const comment = $(`.comment[data-pseudonym="${p}"]`);
  if (comment) { flashTarget(comment); return; }
  if (p === currentPostPseudonym) flashTarget($('#thread-meta'));
}

function renderThreadTags() {
  const box = $('#thread-tags');
  box.innerHTML = '';
  if (!currentPostTags.length) { box.hidden = true; return; }
  box.hidden = false;
  for (const tag of currentPostTags) {
    const chip = el('button', { type: 'button', className: 'tag-pill', textContent: `#${tag}` });
    chip.addEventListener('click', () => filterByTag(tag));
    box.appendChild(chip);
  }
}

function renderThreadChannel(channelId) {
  const box = $('#thread-channel');
  if (!box) return;
  box.innerHTML = '';
  const ch = channelById(channelId);
  if (!ch) { box.hidden = true; return; }
  box.hidden = false;
  const chip = el('button', {
    type: 'button', className: 'channel-badge', textContent: ch.name,
    title: ch.description || ch.name,
  });
  chip.addEventListener('click', () => filterByChannel(ch.id));
  box.appendChild(chip);
}

function renderThreadActions() {
  const box = $('#thread-actions');
  box.innerHTML = '';
  const buttons = [];
  if (currentThread != null) {
    const save = el('button', {
      id: 'thread-save', type: 'button', className: 'ghost small',
    });
    const saved = savedIds.has(currentThread);
    save.classList.toggle('is-saved', saved);
    save.textContent = saved ? '★ 已收藏' : '☆ 收藏';
    save.addEventListener('click', () => toggleSaved(currentThread));
    buttons.push(save);
  }
  if (currentThread != null) {
    const followed = followedIds.has(currentThread);
    const follow = el('button', {
      type: 'button', className: 'ghost small' + (followed ? ' is-followed' : ''),
      textContent: followed ? '🔔 已关注' : '🔕 关注',
    });
    follow.addEventListener('click', () => toggleFollow(currentThread));
    buttons.push(follow);
  }
  if (currentPostCanDelete) {
    const del = el('button', { type: 'button', className: 'ghost small danger', textContent: '删除' });
    del.addEventListener('click', () => deletePost());
    buttons.push(del);
  }
  if (!buttons.length) { box.hidden = true; return; }
  box.hidden = false;
  box.append(...buttons);
}

async function deletePost() {
  if (currentThread == null) return;
  if (!confirm('删除这个帖子？正文会被清空，评论仍会保留。')) return;
  const body = deleteRequestBody();
  if (!body) { openDialog(); return; }
  try {
    await api('DELETE', `/api/posts/${currentThread}`, body);
    const gone = currentThread;
    // Remove from feed cache + DOM (deleted posts are hidden from the feed).
    feedPosts = feedPosts.filter((p) => p.id !== gone);
    const card = $(`.post[data-post-id="${gone}"]`);
    if (card) card.remove();
    loadTags().catch(() => {});
    // Reload the thread so the tombstone view renders with comments intact.
    await openThread(gone, { pushUrl: false });
  } catch (err) {
    alert(err.message);
  }
}

async function openThread(id, { pushUrl = true } = {}) {
  currentThread = id;
  currentBulletin = null;
  markActiveBulletin(null);
  markActivePost(id);
  if (pushUrl) syncUrl({ kind: 'post', id });
  let data;
  try {
    data = await api('GET', `/api/posts/${id}`);
  } catch (err) {
    renderMissingThread(id, err.message);
    return;
  }
  const { post, comments, reactions, tags } = data;
  const deleted = !!post.deleted_at;
  currentComments = comments.slice();
  currentPostPseudonym = deleted ? null : post.pseudonym;
  currentPostTags = deleted ? [] : (tags || []);
  currentPostCanDelete = !deleted && canDeleteAuthor(post.author_key);

  $('#thread-title').innerHTML = '';
  $('#thread-title').append(
    el('span', { className: 'id-badge id-badge--lg', textContent: `#${post.id}` }),
    el('span', { textContent: deleted ? '[已删除]' : post.title }),
  );
  const meta = $('#thread-meta');
  meta.innerHTML = '';
  if (deleted) {
    delete meta.dataset.pseudonym;
    meta.style.removeProperty('--id-hue');
    meta.textContent = `已删除于 ${fmtDate(post.deleted_at)}`;
  } else {
    applyIdHue(meta, post.pseudonym);
    meta.textContent = fmtMeta(post.pseudonym, post.created_at, post.edited_at);
  }
  $('#thread-body').innerHTML = '';
  if (deleted) {
    $('#thread-body').appendChild(el('p', {
      className: 'muted',
      textContent: '该帖子已被作者删除。评论保留。',
    }));
  } else {
    $('#thread-body').appendChild(renderMarkdown(post.content));
  }
  renderThreadChannel(deleted ? null : post.channel_id);
  renderThreadTags();
  renderThreadActions();
  if (deleted) {
    $('#reactions').innerHTML = '';
    $('#reactions').hidden = true;
  } else {
    $('#reactions').hidden = false;
    renderReactions(reactions || Object.fromEntries(REACTION_KINDS.map((k) => [k, 0])));
  }
  const box = $('#comments');
  box.innerHTML = '';
  if (!comments.length) {
    box.appendChild(el('div', { className: 'empty-comments', textContent: '还没有评论。' }));
  } else {
    renderCommentTree(box, comments);
  }
  $('#comment-err').textContent = '';
  $('#comment-form').reset();
  $('#comment-form').hidden = deleted;
  showReader(VIEW.THREAD);
  readerNode.scrollTo({ top: 0, behavior: 'instant' });
  if (!deleted) markFollowedSeen(id).catch(() => {});
}

function renderMissingThread(id, message) {
  currentComments = [];
  currentPostPseudonym = null;
  currentPostTags = [];
  currentPostCanDelete = false;
  $('#reactions').innerHTML = '';
  $('#reactions').hidden = false;
  $('#comment-form').hidden = false;
  $('#thread-tags').innerHTML = '';
  $('#thread-tags').hidden = true;
  $('#thread-channel').innerHTML = '';
  $('#thread-channel').hidden = true;
  $('#thread-actions').innerHTML = '';
  $('#thread-actions').hidden = true;
  $('#thread-title').innerHTML = '';
  $('#thread-title').append(
    el('span', { className: 'id-badge id-badge--lg', textContent: `#${id}` }),
    el('span', { textContent: '帖子不存在' }),
  );
  $('#thread-meta').textContent = '';
  $('#thread-body').innerHTML = '';
  $('#thread-body').appendChild(el('p', { className: 'muted', textContent: message || '未找到该帖子。' }));
  $('#comments').innerHTML = '';
  $('#comment-err').textContent = '';
  $('#comment-form').reset();
  showReader(VIEW.THREAD);
  readerNode.scrollTo({ top: 0, behavior: 'instant' });
}

window.addEventListener('popstate', () => {
  if ($('#forum-view').hidden) return;
  const route = routeFromPath();
  if (!route) {
    currentThread = null;
    currentBulletin = null;
    markActivePost(null);
    markActiveBulletin(null);
    showReader(VIEW.EMPTY);
  } else if (route.kind === 'post' && route.id !== currentThread) {
    openThread(route.id, { pushUrl: false }).catch(() => {});
  } else if (route.kind === 'bulletin' && route.id !== currentBulletin) {
    openBulletin(route.id, { pushUrl: false }).catch(() => {});
  }
});

// --- Comments ---

function renderComment(c, depth) {
  const d = Math.min(depth, MAX_VISUAL_DEPTH);
  const body = el('div', { className: 'comment-body' });
  body.appendChild(renderMarkdown(c.content));
  const actions = el('div', { className: 'comment-actions' });
  const replyBtn = el('button', { className: 'link-btn', type: 'button', textContent: '回复' });
  replyBtn.addEventListener('click', () => toggleReplyForm(node, c));
  actions.appendChild(replyBtn);
  if (ownsAuthorKey(c.author_key)) {
    const editBtn = el('button', { className: 'link-btn', type: 'button', textContent: '编辑' });
    editBtn.addEventListener('click', () => startEditComment(node, c));
    actions.append(editBtn);
  }
  if (canDeleteAuthor(c.author_key)) {
    const delBtn = el('button', { className: 'link-btn danger', type: 'button', textContent: '删除' });
    delBtn.addEventListener('click', () => deleteComment(c));
    actions.append(delBtn);
  }
  const node = el('div', { className: 'comment' }, [
    metaLine(c.pseudonym, c.created_at, c.edited_at),
    body,
    actions,
  ]);
  node.dataset.commentId = c.id;
  applyIdHue(node, c.pseudonym);
  node.style.setProperty('--depth', d);
  if (d > 0) node.classList.add('nested');
  return node;
}

function toggleReplyForm(parentNode, parent) {
  const existing = parentNode.querySelector(':scope > .reply-form');
  if (existing) { existing.remove(); return; }
  const form = buildReplyForm(parent);
  parentNode.appendChild(form);
  const ta = form.querySelector('textarea');
  // Must attach after the textarea is in the DOM — the popup is inserted as
  // its next sibling, which needs a parentNode.
  attachMentionAutocomplete(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function buildReplyForm(parent) {
  const ta = el('textarea', {
    name: 'content', required: true, maxLength: 5000,
    placeholder: '写下你的回复...',
    value: `@${parent.pseudonym} `,
  });
  const err = el('div', { className: 'err' });
  const cancel = el('button', { type: 'button', className: 'ghost', textContent: '取消' });
  cancel.addEventListener('click', () => form.remove());
  const submit = el('button', { type: 'submit', textContent: '发表回复' });
  const actions = el('div', { className: 'form-actions' }, [cancel, submit]);
  const form = el('form', { className: 'inline-form reply-form' }, [ta, actions, err]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    await submitComment({ parentId: parent.id, content: ta.value, errNode: err, onDone: () => form.remove() });
  });
  return form;
}

function startEditComment(commentNode, c) {
  if (commentNode.querySelector(':scope > .edit-form')) return;
  const ta = el('textarea', {
    name: 'content', required: true, maxLength: 5000,
    value: c.content,
  });
  const err = el('div', { className: 'err' });
  const cancel = el('button', { type: 'button', className: 'ghost', textContent: '取消' });
  const submit = el('button', { type: 'submit', textContent: '保存' });
  const actions = el('div', { className: 'form-actions' }, [cancel, submit]);
  const form = el('form', { className: 'inline-form edit-form' }, [ta, actions, err]);
  const body = commentNode.querySelector(':scope > .comment-body');
  body.hidden = true;
  commentNode.insertBefore(form, body.nextSibling);
  cancel.addEventListener('click', () => {
    form.remove();
    body.hidden = false;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const t = getToken();
    if (!t) { err.textContent = '请先获取发帖令牌。'; openDialog(); return; }
    try {
      const updated = await api('PUT', `/api/posts/${currentThread}/comments/${c.id}`, {
        token: t.token, content: ta.value,
      });
      Object.assign(c, { content: updated.content, edited_at: updated.edited_at });
      const idx = currentComments.findIndex((x) => x.id === c.id);
      if (idx >= 0) currentComments[idx] = c;
      // Re-render body.
      body.innerHTML = '';
      body.appendChild(renderMarkdown(updated.content));
      commentNode.querySelector(':scope > .meta').textContent = fmtMeta(c.pseudonym, c.created_at, updated.edited_at);
      form.remove();
      body.hidden = false;
      flashTarget(commentNode);
    } catch (e2) {
      err.textContent = e2.message;
    }
  });
  attachMentionAutocomplete(ta);
  ta.focus();
}

async function deleteComment(c) {
  if (!confirm('删除这条评论？')) return;
  const body = deleteRequestBody();
  if (!body) { openDialog(); return; }
  try {
    await api('DELETE', `/api/posts/${currentThread}/comments/${c.id}`, body);
    currentComments = currentComments.filter((x) => x.id !== c.id);
    const node = $(`.comment[data-comment-id="${c.id}"]`);
    if (node) node.remove();
    const box = $('#comments');
    if (!currentComments.length) {
      box.innerHTML = '';
      box.appendChild(el('div', { className: 'empty-comments', textContent: '还没有评论。' }));
    }
  } catch (err) {
    alert(err.message);
  }
}

async function submitComment({ parentId, content, errNode, onDone }) {
  if (currentThread == null) return;
  const t = getToken();
  if (!t) { errNode.textContent = '请先获取发帖令牌。'; openDialog(); return; }
  try {
    const created = await api('POST', `/api/posts/${currentThread}/comments`, {
      token: t.token, content, parent_id: parentId ?? null,
    });
    currentComments.push(created);
    if (onDone) onDone();
    const box = $('#comments');
    const empty = box.querySelector('.empty-comments');
    if (empty) empty.remove();
    insertCommentIntoTree(created);
  } catch (err) {
    errNode.textContent = err.message;
  }
}

function insertCommentIntoTree(c) {
  const node = renderComment(c, depthOfComment(c));
  if (c.parent_id == null) {
    $('#comments').appendChild(node);
  } else {
    const parentNode = $(`.comment[data-comment-id="${c.parent_id}"]`);
    if (parentNode) {
      const children = ensureChildrenContainer(parentNode);
      children.appendChild(node);
    } else {
      $('#comments').appendChild(node);
    }
  }
  flashTarget(node);
}

function ensureChildrenContainer(parentNode) {
  let box = parentNode.querySelector(':scope > .replies');
  if (!box) {
    box = el('div', { className: 'replies' });
    parentNode.appendChild(box);
  }
  return box;
}

function depthOfComment(c) {
  const byId = new Map(currentComments.map((x) => [x.id, x]));
  let depth = 0, cur = c;
  while (cur && cur.parent_id != null && byId.has(cur.parent_id)) {
    depth++;
    cur = byId.get(cur.parent_id);
    if (depth > 50) break;
  }
  return depth;
}

function renderCommentTree(box, comments) {
  const ids = new Set(comments.map((c) => c.id));
  const kids = new Map();
  for (const c of comments) {
    const key = c.parent_id != null && ids.has(c.parent_id) ? c.parent_id : null;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(c);
  }
  const walk = (c, depth, parentNode) => {
    const node = renderComment(c, depth);
    parentNode.appendChild(node);
    const children = kids.get(c.id);
    if (children) {
      const container = ensureChildrenContainer(node);
      for (const k of children) walk(k, depth + 1, container);
    }
  };
  for (const r of kids.get(null) || []) walk(r, 0, box);
}

// --- Reactions ---

function renderReactions(counts) {
  const box = $('#reactions');
  box.innerHTML = '';
  if (currentThread == null || !counts) return;
  const t = getToken();
  const mine = new Set(t ? (myReactionsFor(t.pseudonym)[currentThread] || []) : []);
  for (const kind of REACTION_KINDS) {
    const count = counts[kind] || 0;
    const pill = el('button', { type: 'button', className: 'reaction-pill' });
    pill.appendChild(el('span', { className: 'reaction-emoji', textContent: kind }));
    pill.appendChild(el('span', {
      className: 'reaction-count' + (count === 0 ? ' is-zero' : ''),
      textContent: String(count),
    }));
    if (mine.has(kind)) pill.classList.add('is-mine');
    pill.addEventListener('click', () => toggleReaction(kind));
    box.appendChild(pill);
  }
}

async function toggleReaction(kind) {
  if (currentThread == null) return;
  const t = getToken();
  if (!t) { openDialog(); return; }
  const postId = currentThread;
  const wasMine = (myReactionsFor(t.pseudonym)[postId] || []).includes(kind);
  try {
    const r = await api('POST', `/api/posts/${postId}/reactions`, { token: t.token, kind });
    if (currentThread !== postId) return;
    setMyReaction(t.pseudonym, postId, kind, !wasMine);
    renderReactions(r.reactions);
  } catch (err) {
    if (/令牌/.test(err.message)) openDialog();
  }
}

// --- Mentions ---

async function refreshMentions({ silent = false, open = false } = {}) {
  const t = getToken();
  if (!t && !isAdmin) {
    lastMentions = [];
    $('#mention-dot').hidden = true;
    if (open) openMentionsDialog();
    return;
  }
  try {
    const r = await api('POST', '/api/mentions', t ? { token: t.token } : {});
    lastMentions = r.mentions;
    const seen = getMentionSeen(mentionInboxKey(t));
    const unread = lastMentions.filter((m) => m.created_at > seen).length;
    const dot = $('#mention-dot');
    dot.hidden = unread === 0;
    dot.textContent = unread > 99 ? '99+' : String(unread);
  } catch {
    if (!silent) throw new Error('无法刷新提醒');
  }
  if (open) openMentionsDialog();
}

function openMentionsDialog() {
  const t = getToken();
  const pseudo = $('#mentions-pseudo');
  const target = currentMentionTarget(t);
  pseudo.textContent = target ? `@${target}` : '—';
  if (target) applyIdHue(pseudo, target); else { delete pseudo.dataset.pseudonym; pseudo.style.removeProperty('--id-hue'); }
  const box = $('#mentions-list');
  box.innerHTML = '';
  if (!target) {
    box.appendChild(el('div', { className: 'muted', textContent: '需要先领取发帖令牌。' }));
  } else if (!lastMentions.length) {
    box.appendChild(el('div', { className: 'muted', textContent: '过去 24 小时内没有新的提醒。' }));
  } else {
    for (const m of lastMentions) box.appendChild(renderMentionItem(m));
  }
  $('#mentions-dialog').hidden = false;
  if (target) {
    setMentionSeen(mentionInboxKey(t), Date.now());
    $('#mention-dot').hidden = true;
  }
}

function renderMentionItem(m) {
  const where = m.comment_id ? '评论里' : '帖子里';
  const sender = el('span', { className: 'mention-sender', textContent: `@${m.sender_pseudonym}` });
  applyIdHue(sender, m.sender_pseudonym);
  const head = el('div', { className: 'mention-head' }, [
    sender,
    el('span', { className: 'muted', textContent: ` 在「${m.post_title}」的${where}提到你` }),
  ]);
  const snippet = el('div', { className: 'mention-snippet', textContent: m.snippet });
  const foot = el('div', { className: 'meta', textContent: fmtDate(m.created_at) });
  const item = el('div', { className: 'mention-item-card' }, [head, snippet, foot]);
  item.addEventListener('click', () => {
    closeMentionsDialog();
    openThread(m.post_id).catch(() => {});
  });
  return item;
}

$('#mentions-btn').addEventListener('click', () => {
  refreshMentions({ silent: true, open: true }).catch((e) => alert(e.message));
});

function schedulePollingMentions() {
  stopPollingMentions();
  mentionPollTimer = setInterval(() => {
    refreshMentions({ silent: true }).catch(() => {});
    loadFollowed().catch(() => {});
    loadChannelUnread().catch(() => {});
  }, MENTION_POLL_MS);
}
function stopPollingMentions() {
  if (mentionPollTimer) { clearInterval(mentionPollTimer); mentionPollTimer = null; }
}

// --- Markdown + mention chips ---

const SAFE_URL_RE = /^(https?:\/\/|\/p\/\d{1,10}(?:[?#].*)?$)/i;
const SAFE_IMG_URL_RE = /^\/api\/uploads\/[a-f0-9]{64}\.(jpg|png|webp)$/;
function safeUrl(u) { return typeof u === 'string' && SAFE_URL_RE.test(u.trim()) ? u.trim() : null; }
function safeImgUrl(u) { return typeof u === 'string' && SAFE_IMG_URL_RE.test(u.trim()) ? u.trim() : null; }

function renderTextWithMentions(text) {
  const frag = document.createDocumentFragment();
  MENTION_IN_TEXT_RE.lastIndex = 0;
  let last = 0, m;
  while ((m = MENTION_IN_TEXT_RE.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const raw = m[1];
      const target = canonicalMentionHandle(raw);
      if (!target) {
        frag.appendChild(document.createTextNode(m[0]));
      } else {
        const chip = el('a', { className: 'mention', href: '#', textContent: `@${raw}` });
        applyIdHue(chip, target);
        chip.addEventListener('click', (e) => { e.preventDefault(); jumpToPseudonym(target); });
        frag.appendChild(chip);
      }
    } else {
      const id = parseInt(m[2], 10);
      const chip = el('a', { className: 'mention post-ref', href: '#', textContent: `#${id}` });
      chip.dataset.postId = String(id);
      chip.addEventListener('click', (e) => { e.preventDefault(); openThread(id).catch(() => {}); });
      frag.appendChild(chip);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function renderInline(text, parent) {
  const push = (s) => { if (s) parent.appendChild(renderTextWithMentions(s)); };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m = /^`([^`\n]+)`/.exec(rest);
    if (m) { parent.appendChild(el('code', { textContent: m[1] })); i += m[0].length; continue; }
    m = /^!\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      const url = safeImgUrl(m[2]);
      if (url) {
        parent.appendChild(el('img', { src: url, alt: m[1] || '', className: 'md-img', loading: 'lazy' }));
      } else {
        push(m[0]);
      }
      i += m[0].length; continue;
    }
    m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      const url = safeUrl(m[2]);
      if (url) {
        const a = el('a', { href: url, rel: 'noopener noreferrer', target: '_blank' });
        renderInline(m[1], a);
        parent.appendChild(a);
      } else {
        push(m[0]);
      }
      i += m[0].length; continue;
    }
    m = /^\*\*([\s\S]+?)\*\*/.exec(rest);
    if (m && !/\n/.test(m[1])) { const b = el('strong'); renderInline(m[1], b); parent.appendChild(b); i += m[0].length; continue; }
    m = /^\*([^*\n]+?)\*/.exec(rest);
    if (m) { const it = el('em'); renderInline(m[1], it); parent.appendChild(it); i += m[0].length; continue; }
    // Stop a text chunk before the next markdown trigger. `!` must
    // detach from the chunk so the next iteration can spot `![`.
    const inSlice = rest.slice(1);
    const stop = /!?\[|[`*]/.exec(inSlice);
    if (!stop) { push(rest); i += rest.length; continue; }
    const chunk = rest.slice(0, stop.index + 1);
    push(chunk);
    i += chunk.length;
  }
}

function renderInlineWithBreaks(text, parent) {
  const lines = text.split('\n');
  lines.forEach((ln, idx) => {
    renderInline(ln, parent);
    if (idx < lines.length - 1) parent.appendChild(el('br'));
  });
}

function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  if (typeof text !== 'string' || !text) return frag;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++;
      const code = el('code', { textContent: buf.join('\n') });
      if (fence[1]) code.className = `lang-${fence[1]}`;
      frag.appendChild(el('pre', {}, [code]));
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const tag = `h${h[1].length}`;
      const node = el(tag);
      renderInline(h[2].trim(), node);
      frag.appendChild(node);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      const node = el('blockquote');
      renderInlineWithBreaks(buf.join('\n'), node);
      frag.appendChild(node);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const ul = el('ul');
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const li = el('li');
        renderInline(lines[i].replace(/^[-*]\s+/, ''), li);
        ul.appendChild(li);
        i++;
      }
      frag.appendChild(ul);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const ol = el('ol');
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const li = el('li');
        renderInline(lines[i].replace(/^\d+\.\s+/, ''), li);
        ol.appendChild(li);
        i++;
      }
      frag.appendChild(ol);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^```/.test(lines[i]) && !/^#{1,3}\s+/.test(lines[i]) &&
           !/^>\s?/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) &&
           !/^\d+\.\s+/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    const p = el('p');
    renderInlineWithBreaks(buf.join('\n'), p);
    frag.appendChild(p);
  }
  return frag;
}

// --- Autocomplete for @ and # ---

function attachMentionAutocomplete(textarea) {
  const pop = el('div', { className: 'mention-pop', hidden: true });
  textarea.parentNode && textarea.parentNode.insertBefore(pop, textarea.nextSibling);
  let items = [], active = 0, tokenStart = -1, kind = '@';

  const close = () => { pop.hidden = true; items = []; tokenStart = -1; };

  const matchTrigger = () => {
    const v = textarea.value;
    const caret = textarea.selectionStart;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = v[i];
      if (ch === '@' || ch === '#') {
        const prev = i === 0 ? ' ' : v[i - 1];
        if (/\s|[,.;:(\[{]/.test(prev) || i === 0) {
          return { start: i, kind: ch, query: v.slice(i + 1, caret).toLowerCase() };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
    }
    return null;
  };

  const render = (q) => {
    pop.innerHTML = '';
    if (kind === '@') {
      items = knownMentionHandles()
        .filter((p) => p.toLowerCase().startsWith(q))
        .slice(0, 6)
        .map((p) => ({ value: `@${p}`, label: `@${p}` }));
    } else {
      items = feedPosts
        .filter((p) => !q || String(p.id).startsWith(q) || p.title.toLowerCase().includes(q))
        .slice(0, 6)
        .map((p) => ({ value: `#${p.id}`, label: `#${p.id}`, sub: p.title }));
    }
    if (!items.length) { pop.hidden = true; return; }
    active = 0;
    items.forEach((it, i) => {
      const row = el('div', { className: 'mention-item' });
      row.append(el('span', { textContent: it.label }));
      if (it.sub) row.append(el('span', { className: 'mention-sub', textContent: it.sub }));
      if (i === active) row.classList.add('active');
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      pop.appendChild(row);
    });
    pop.hidden = false;
  };

  const pick = (i) => {
    const it = items[i];
    if (!it || tokenStart < 0) return;
    const v = textarea.value;
    const caret = textarea.selectionStart;
    const before = v.slice(0, tokenStart);
    const after = v.slice(caret);
    const insert = `${it.value} `;
    textarea.value = before + insert + after;
    const pos = before.length + insert.length;
    textarea.setSelectionRange(pos, pos);
    close();
    textarea.focus();
  };

  textarea.addEventListener('input', () => {
    const m = matchTrigger();
    if (!m) return close();
    tokenStart = m.start;
    kind = m.kind;
    render(m.query);
  });
  textarea.addEventListener('keydown', (e) => {
    if (pop.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = (active + 1) % items.length;
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active - 1 + items.length) % items.length;
      updateActive();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  textarea.addEventListener('blur', () => setTimeout(close, 120));
  const updateActive = () => {
    [...pop.children].forEach((n, i) => n.classList.toggle('active', i === active));
  };
}

const mainCommentForm = $('#comment-form');
attachMentionAutocomplete(mainCommentForm.querySelector('textarea'));
attachMentionAutocomplete($('#post-form').querySelector('input[name=title]'));
attachMentionAutocomplete($('#post-form').querySelector('textarea'));

mainCommentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errNode = $('#comment-err');
  errNode.textContent = '';
  await submitComment({
    parentId: null,
    content: e.target.content.value,
    errNode,
    onDone: () => e.target.reset(),
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#confirm-rotate-dialog').hidden) { closeConfirmRotate(); return; }
  if (!$('#channel-dialog').hidden) { closeChannelDialog(); return; }
  if (!$('#bulletin-dialog').hidden) { closeBulletinDialog(); return; }
  if (!$('#followed-dialog').hidden) { closeFollowedDialog(); return; }
  if (!$('#help-dialog').hidden) { closeHelpDialog(); return; }
  if (!$('#token-dialog').hidden) { closeDialog(); return; }
  if (!$('#mentions-dialog').hidden) { closeMentionsDialog(); return; }
  if (currentView !== VIEW.EMPTY) closeReader();
});

// --- Resizable sidebar (desktop only; mobile media query hides the bar) ---

(function setupSidebarResizer() {
  const resizer = $('#sidebar-resizer');
  if (!resizer) return;
  const layout = $('#forum-view');
  const clamp = (w) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
  const apply = (w) => layout.style.setProperty('--sidebar-w', `${clamp(w)}px`);
  try {
    const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    if (Number.isFinite(saved)) apply(saved);
  } catch {}

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const x = e.clientX - layout.getBoundingClientRect().left;
    apply(x);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('is-dragging');
    document.body.style.removeProperty('cursor');
    const w = parseInt(getComputedStyle(layout).getPropertyValue('--sidebar-w'), 10);
    if (Number.isFinite(w)) {
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)); } catch {}
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    resizer.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  // Keyboard: ←/→ to nudge by 16px when the resizer is focused.
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = parseInt(getComputedStyle(layout).getPropertyValue('--sidebar-w'), 10) || 300;
    const next = clamp(cur + (e.key === 'ArrowRight' ? 16 : -16));
    apply(next);
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next)); } catch {}
  });

  // Double-click resets to default.
  resizer.addEventListener('dblclick', () => {
    layout.style.removeProperty('--sidebar-w');
    try { localStorage.removeItem(SIDEBAR_WIDTH_KEY); } catch {}
  });
})();

refreshMe();
