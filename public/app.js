// ────────────────────────────────────────────────────────────────────────────
// FILE MAP — grep "SECTION:" (via the Grep tool / ripgrep) to jump.
// Keep in sync when adding large blocks.
//
//   SECTION: constants          storage keys, reaction kinds, regexes
//   SECTION: dom-helpers        $/$$/el/api and theme init
//   SECTION: token-state        getToken/setToken/clearToken + identity helpers
//   SECTION: reactions-state    myReactions local cache
//   SECTION: mention-state      inbox read-cursor + handle helpers
//   SECTION: formatting         fmtDate, fmtMeta, hueFromPseudonym
//   SECTION: view-routing       VIEW const, showReader, route sync, popstate
//   SECTION: token-ui           token chip + dialogs (mint/rotate)
//   SECTION: auth-form          login / register / send-code UI
//   SECTION: feed                feed list + channel filter bar
//   SECTION: saved-followed     saved-posts + followed-posts UI
//   SECTION: bulletins          bulletin list + admin dialog
//   SECTION: docs               shared-doc list/reader/editor
//   SECTION: compose-upload     image picker wiring for the composer
//   SECTION: poll               composer poll builder + reader renderer
//   SECTION: post-card          post preview card renderer
//   SECTION: search             search input + results
//   SECTION: compose            composer panel
//   SECTION: reader             thread view + actions
//   SECTION: comments           comment tree + reply/edit forms
//   SECTION: reactions-ui       reaction bar renderer
//   SECTION: mentions-dialog    mentions inbox
//   SECTION: markdown           renderMarkdown + mention chips + safe URLs
//   SECTION: syntax-highlight   fenced-code tokenizer (HL_RULES)
//   SECTION: math               KaTeX wrapper
//   SECTION: autocomplete       attachMentionAutocomplete (@ / # popups)
//   SECTION: sidebar+init       resizable sidebar + startup wiring
// ────────────────────────────────────────────────────────────────────────────

// SECTION: constants
const TOKEN_STORE_KEY = 'teahole.token';
const THEME_STORE_KEY = 'teahole.theme';
const MY_REACTIONS_KEY = 'teahole.myReactions';
const MY_VOTES_KEY = 'teahole.myVotes';
const MENTIONS_SEEN_KEY = 'teahole.mentionsSeen';
const HELP_SEEN_KEY = 'teahole.helpSeen';
const SIDEBAR_WIDTH_KEY = 'teahole.sidebarWidth';
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;
// Authoritative list lives on the server (REACTION_KIND_SET in server.js).
// Kept in sync manually — if you change one, change the other.
const REACTION_KINDS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const PSEUDONYM_RE = /^[a-f0-9]{8}$/;
const MENTION_IN_TEXT_RE = /@([A-Za-z0-9_]{3,32})|#(\d{1,10})/g;
const MAX_VISUAL_DEPTH = 4;
const MENTION_POLL_MS = 60_000;

// SECTION: dom-helpers
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

// Mobile sidebar drawer: hamburger toggle + backdrop dismissal.
$('#sidebar-toggle').addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  if (sb && sb.classList.contains('open')) closeSidebarDrawer();
  else openSidebarDrawer();
});
$('#sidebar-backdrop').addEventListener('click', () => closeSidebarDrawer());
window.addEventListener('resize', () => {
  if (!isMobileViewport()) closeSidebarDrawer();
});

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// SECTION: token-state
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
// SECTION: reactions-state
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

// "Did I vote?" mirrors the reactions hint above: a client-side flag, keyed
// by pseudonym, that gates the second roundtrip to fetch results. The server
// is still the only source of truth for whether results are revealed.
function myVoteFor(pseudonym, postId) {
  if (!pseudonym) return null;
  try {
    const all = JSON.parse(localStorage.getItem(MY_VOTES_KEY) || '{}');
    return (all[pseudonym] && all[pseudonym][postId]) || null;
  } catch { return null; }
}
function setMyVote(pseudonym, postId, optionId) {
  if (!pseudonym) return;
  let all;
  try { all = JSON.parse(localStorage.getItem(MY_VOTES_KEY) || '{}'); }
  catch { all = {}; }
  const byPost = all[pseudonym] || (all[pseudonym] = {});
  byPost[postId] = optionId;
  localStorage.setItem(MY_VOTES_KEY, JSON.stringify(all));
}

// SECTION: mention-state
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

// SECTION: formatting
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

// SECTION: view-routing
const VIEW = {
  EMPTY: 'empty-view', THREAD: 'thread-view', COMPOSE: 'compose-view',
  BULLETIN: 'bulletin-view', DOC: 'doc-view',
};
const viewNodes = Object.fromEntries(Object.values(VIEW).map((id) => [id, $('#' + id)]));
const readerNode = $('#reader');
let currentView = null;
let currentThread = null;
let currentComments = [];
let currentPostPseudonym = null;
let currentPostCanDelete = false;
let feedPosts = [];
let filterState = { kind: null, value: null };
let mentionPollTimer = null;
let lastMentions = [];
let channels = [];
let bulletins = [];
let currentBulletin = null;
// 'posts' shows the post feed; 'docs' shows the shared-doc list. Persists
// across channel/search filter changes, but not across reloads.
let feedMode = 'posts';
let currentDoc = null;
let savedIds = new Set();
let savedDocIds = new Set();
// Per-user channel prefs: Map<channelId, { pinned, muted }>
let channelPrefs = new Map();
let mutedExpanded = false;
let channelSearchQ = '';
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
  if (currentView !== which) {
    for (const id of Object.values(VIEW)) viewNodes[id].hidden = id !== which;
    currentView = which;
  }
  // Opening a view on mobile should retract the sidebar drawer if the user
  // navigated via a sidebar link.
  if (window.innerWidth <= 760) closeSidebarDrawer();
}

function isMobileViewport() {
  return window.innerWidth <= 760;
}

function openSidebarDrawer() {
  const sb = $('#sidebar');
  const bd = $('#sidebar-backdrop');
  const btn = $('#sidebar-toggle');
  if (!sb || !bd) return;
  sb.classList.add('open');
  bd.hidden = false;
  // Force reflow so the opacity transition runs from 0.
  void bd.offsetWidth;
  bd.classList.add('open');
  if (btn) btn.setAttribute('aria-expanded', 'true');
}

function closeSidebarDrawer() {
  const sb = $('#sidebar');
  const bd = $('#sidebar-backdrop');
  const btn = $('#sidebar-toggle');
  if (!sb || !bd) return;
  if (!sb.classList.contains('open')) return;
  sb.classList.remove('open');
  bd.classList.remove('open');
  const hideBackdrop = () => { bd.hidden = true; };
  setTimeout(hideBackdrop, 220);
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function closeReader() {
  currentThread = null;
  currentBulletin = null;
  currentDoc = null;
  clearTimeout(docPreviewTimer);
  markActivePost(null);
  markActiveBulletin(null);
  markActiveDoc(null);
  showReader(VIEW.EMPTY);
  syncUrl(null);
}

const POST_PATH_RE = /^\/p\/(\d{1,10})$/;
const BULLETIN_PATH_RE = /^\/b\/(\d{1,10})$/;
const DOC_PATH_RE = /^\/d\/(\d{1,10})$/;
function routeFromPath() {
  const p = POST_PATH_RE.exec(location.pathname);
  if (p) return { kind: 'post', id: parseInt(p[1], 10) };
  const b = BULLETIN_PATH_RE.exec(location.pathname);
  if (b) return { kind: 'bulletin', id: parseInt(b[1], 10) };
  const d = DOC_PATH_RE.exec(location.pathname);
  if (d) return { kind: 'doc', id: parseInt(d[1], 10) };
  return null;
}
function syncUrl(route) {
  const target = !route ? '/'
    : route.kind === 'bulletin' ? `/b/${route.id}`
    : route.kind === 'doc' ? `/d/${route.id}`
    : `/p/${route.id}`;
  if (location.pathname === target) return;
  history.pushState(null, '', target);
}

// SECTION: token-ui
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
$('#channel-search').addEventListener('input', (e) => {
  channelSearchQ = e.target.value;
  renderChannelList();
});
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
    renderComposeButton();
    renderFeedTabs();
    showReader(VIEW.EMPTY);
    const route = routeFromPath();
    if (route && route.kind === 'post') await openThread(route.id, { pushUrl: false });
    else if (route && route.kind === 'bulletin') await openBulletin(route.id, { pushUrl: false });
    else if (route && route.kind === 'doc') await openDoc(route.id, { pushUrl: false });
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

let sendCodeCooldownIv = null;

// SECTION: auth-form
function stopSendCodeCooldown() {
  if (sendCodeCooldownIv) {
    clearInterval(sendCodeCooldownIv);
    sendCodeCooldownIv = null;
  }
  const btn = $('#send-code-btn');
  btn.textContent = '发送';
  btn.disabled = false;
}

function setAuthMode(mode) {
  const f = $('#login-form');
  f.dataset.mode = mode;
  const register = mode === 'register';
  $('#code-row').hidden = !register;
  const confirm = $('#password-confirm');
  confirm.hidden = !register;
  confirm.required = register;
  $('#auth-submit').textContent = register ? '创建账号' : '登录';
  $('#register-btn').textContent = register ? '返回登录' : '注册';
  f.password.autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-err').textContent = '';
  $('#auth-info').textContent = '';
  stopSendCodeCooldown();
}

async function authSubmit() {
  $('#auth-err').textContent = '';
  const f = $('#login-form');
  const mode = f.dataset.mode || 'login';
  try {
    if (mode === 'register') {
      await api('POST', '/api/register', {
        email: f.email.value,
        password: f.password.value,
        password_confirm: f.password_confirm.value,
        code: f.code.value,
      });
    } else {
      await api('POST', '/api/login', {
        email: f.email.value,
        password: f.password.value,
      });
    }
    f.reset();
    setAuthMode('login');
    refreshMe();
  } catch (err) {
    $('#auth-err').textContent = err.message;
  }
}

async function sendCode() {
  const f = $('#login-form');
  const btn = $('#send-code-btn');
  $('#auth-err').textContent = '';
  $('#auth-info').textContent = '';
  if (!f.email.value) {
    $('#auth-err').textContent = '请先填写邮箱';
    return;
  }
  btn.disabled = true;
  try {
    await api('POST', '/api/send-code', { email: f.email.value });
    $('#auth-info').textContent = '验证码已发送，请查收邮箱（10 分钟内有效）';
    // Mirror the server's 60s per-email throttle in the UI.
    stopSendCodeCooldown();
    let left = 60;
    btn.textContent = `${left}s`;
    btn.disabled = true;
    sendCodeCooldownIv = setInterval(() => {
      left -= 1;
      if (left <= 0) stopSendCodeCooldown();
      else btn.textContent = `${left}s`;
    }, 1000);
  } catch (err) {
    $('#auth-err').textContent = err.message;
    btn.disabled = false;
  }
}

$('#login-form').addEventListener('submit', (e) => { e.preventDefault(); authSubmit(); });
$('#register-btn').addEventListener('click', () => {
  const cur = $('#login-form').dataset.mode || 'login';
  setAuthMode(cur === 'register' ? 'login' : 'register');
});
$('#send-code-btn').addEventListener('click', sendCode);

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

// SECTION: feed
// --- Feed + filters ---

function renderFilterBar() {
  const bar = $('#filter-bar');
  bar.innerHTML = '';
  const label = $('#feed-label');
  const base = feedMode === 'docs' ? '共享文档' : '动态';
  if (!filterState.kind) {
    bar.hidden = true;
    label.textContent = base;
  } else {
    bar.hidden = false;
    let text, sub;
    if (filterState.kind === 'channel') {
      const ch = channelById(filterState.value);
      text = `频道：${ch ? ch.name : '—'}`;
      sub = `${base} · 频道`;
    } else if (filterState.kind === 'saved') {
      text = '仅显示我收藏的';
      sub = `${base} · 收藏`;
    } else {
      text = `搜索：${filterState.value}`;
      sub = `${base} · 搜索`;
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
  if (feedMode === 'docs') await loadDocs();
  else await loadFeed();
}

async function loadFeed() {
  const feed = $('#feed');
  feed.innerHTML = '';
  let rows;
  try {
    if (filterState.kind === 'search') {
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
      : filterState.kind === 'saved'
      ? '还没有收藏任何帖子。'
      : '还没有帖子。做第一个发帖的人吧。';
    feed.appendChild(el('div', { className: 'feed-empty', textContent: msg }));
    return;
  }
  for (const p of rows) feed.appendChild(renderPostCard(p));
  if (currentThread != null) markActivePost(currentThread);
}

async function filterByChannel(channelId) {
  filterState = { kind: 'channel', value: channelId };
  $('#search-input').value = '';
  $('#search-clear').hidden = true;
  markChannelSeen(channelId).catch(() => {});
  renderFilterBar();
  if (feedMode === 'docs') await loadDocs();
  else await loadFeed();
  showReader(VIEW.EMPTY);
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
    el('span', { className: 'channel-hash', textContent: pref.pinned ? '📌' : '§' }),
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
  const q = channelSearchQ.trim().toLowerCase();
  const matches = (ch) => !q || ch.name.toLowerCase().includes(q) || ch.slug.toLowerCase().includes(q);
  const activeId = filterState.kind === 'channel' ? filterState.value : null;
  const opts = { adminCanDelete: isAdmin };
  const pinned = [], normal = [], muted = [];
  for (const ch of channels) {
    if (!matches(ch)) continue;
    const pref = channelPrefFor(ch.id);
    if (pref.pinned) pinned.push(ch);
    else if (pref.muted) muted.push(ch);
    else normal.push(ch);
  }
  if (q && !pinned.length && !normal.length && !muted.length) {
    box.appendChild(el('div', { className: 'muted channel-empty', textContent: '没有匹配的频道' }));
    return;
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

// SECTION: saved-followed
// --- Saved posts (account-scoped reader state) ---

async function loadSavedIds() {
  try {
    const r = await api('GET', '/api/saved');
    savedIds = new Set(r.ids);
  } catch {
    savedIds = new Set();
  }
  try {
    const r = await api('GET', '/api/saved-docs');
    savedDocIds = new Set(r.ids);
  } catch {
    savedDocIds = new Set();
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

async function toggleSavedDoc(docId) {
  const wasSaved = savedDocIds.has(docId);
  try {
    await api(wasSaved ? 'DELETE' : 'POST', `/api/saved-docs/${docId}`);
    if (wasSaved) savedDocIds.delete(docId); else savedDocIds.add(docId);
    renderDocActions(currentDocRow);
    if (filterState.kind === 'saved' && feedMode === 'docs') await loadDocs();
  } catch (err) {
    alert(err.message);
  }
}

async function filterBySaved() {
  filterState = { kind: 'saved', value: null };
  $('#search-input').value = '';
  $('#search-clear').hidden = true;
  renderFilterBar();
  if (feedMode === 'docs') await loadDocs();
  else await loadFeed();
  showReader(VIEW.EMPTY);
}

// SECTION: bulletins
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

// SECTION: docs
// --- Shared docs: wiki-style markdown pages tied to a channel ---
//
// Privacy mirror of posts: the server stores created_token_hash only as
// a delete gate and nulls it out via rotate() when the token expires.
// Anyone with a valid posting token may edit; last_editor_pseudonym is
// displayed but never joined back to any user row.
//
// Edit UX: the doc view is a single surface. Read mode renders
// markdown; edit mode swaps the rendered body for a textarea with a
// live preview pane next to it (stacked on narrow viewports). There is
// no separate compose screen — "新建文档" opens an empty doc in edit
// mode on the same surface.

// Shape of the in-memory doc row the reader/editor works with. null id
// means this is a draft that hasn't been POSTed yet.
let currentDocRow = null;
let isDocEditing = false;
let docPreviewTimer = null;

// Single path for flipping the feed mode. All callers go through here
// so the tab, header label, compose button, pane visibility, and the
// list fetch stay in lock-step.
function setFeedMode(mode, { reload = true } = {}) {
  if (mode !== 'posts' && mode !== 'docs') mode = 'posts';
  const changed = feedMode !== mode;
  if (changed) clearTimeout(docPreviewTimer);
  feedMode = mode;
  for (const btn of $$('#feed-tabs .feed-tab')) {
    btn.classList.toggle('is-active', btn.dataset.mode === mode);
  }
  renderFeedTabs();
  renderComposeButton();
  renderFilterBar();
  if (reload && changed) {
    if (mode === 'docs') loadDocs().catch(() => {});
    else loadFeed().catch(() => {});
  }
}


function renderFeedTabs() {
  const feedNode = $('#feed');
  const docsNode = $('#docs-feed');
  if (feedMode === 'docs') {
    feedNode.hidden = true;
    docsNode.hidden = false;
  } else {
    feedNode.hidden = false;
    docsNode.hidden = true;
  }
}

function renderComposeButton() {
  const btn = $('#compose-btn');
  if (!btn) return;
  btn.innerHTML = '';
  const plus = el('span', { className: 'plus', textContent: '＋' });
  const label = el('span', {
    textContent: feedMode === 'docs' ? ' 新建文档' : ' 发新帖',
  });
  btn.append(plus, label);
}

async function loadDocs() {
  const box = $('#docs-feed');
  if (!box) return;
  box.innerHTML = '';
  let rows;
  try {
    if (filterState.kind === 'saved') {
      const r = await api('GET', '/api/saved-docs');
      savedDocIds = new Set(r.ids);
      rows = r.docs;
    } else if (filterState.kind === 'search') {
      rows = await api('GET', `/api/docs?q=${encodeURIComponent(filterState.value)}`);
    } else if (filterState.kind === 'channel') {
      const ch = channelById(filterState.value);
      if (!ch) { clearFilter(); return; }
      rows = await api('GET', `/api/docs?channel=${encodeURIComponent(ch.slug)}`);
    } else {
      rows = await api('GET', '/api/docs');
    }
  } catch (err) {
    box.appendChild(el('div', { className: 'feed-empty', textContent: err.message }));
    return;
  }
  if (!rows.length) {
    const hint = filterState.kind === 'saved'
      ? '还没有收藏任何共享文档。'
      : filterState.kind === 'search'
      ? '没有匹配的共享文档。'
      : filterState.kind === 'channel'
      ? '该频道还没有共享文档。点击「新建文档」起个头。'
      : '还没有共享文档。课程笔记、申请指南、选课评价…都可以写在这里。';
    box.appendChild(el('div', { className: 'feed-empty', textContent: hint }));
    return;
  }
  for (const d of rows) box.appendChild(renderDocCard(d));
  if (currentDoc != null) markActiveDoc(currentDoc);
}

function renderDocCard(d) {
  const titleRow = el('div', { className: 'post-title-row' }, [
    el('span', { className: 'id-badge id-badge--doc', textContent: '📄' }),
    el('span', { className: 'post-title', textContent: d.title }),
  ]);
  const children = [titleRow];
  const ch = channelById(d.channel_id);
  if (ch) {
    const badge = el('button', {
      type: 'button', className: 'channel-badge small', textContent: ch.name, title: ch.description || ch.name,
    });
    badge.addEventListener('click', (e) => { e.stopPropagation(); filterByChannel(ch.id); });
    children.push(badge);
  }
  const lastTs = d.updated_at || d.created_at;
  const editor = d.last_editor_pseudonym || d.created_pseudonym;
  const metaLineEl = el('div', { className: 'meta doc-meta' });
  applyIdHue(metaLineEl, editor);
  metaLineEl.textContent =
    `@${editor} · ${d.updated_at ? '最近编辑于' : '创建于'} ${fmtDate(lastTs)}`;
  children.push(metaLineEl);
  const node = el('div', { className: 'post doc-card' }, children);
  node.dataset.docId = d.id;
  node.addEventListener('click', () => openDoc(d.id));
  return node;
}

function markActiveDoc(id) {
  const wanted = id == null ? null : String(id);
  for (const n of $$('.doc-card')) {
    n.classList.toggle('active', n.dataset.docId === wanted);
  }
}

function syncDocsFeedTab() {
  // Keep the docs tab visually/logically active whenever the doc view
  // is the surface — so "返回" lands in the docs list, not posts feed.
  if (feedMode !== 'docs') setFeedMode('docs');
}

async function openDoc(id, { pushUrl = true } = {}) {
  currentDoc = id;
  currentThread = null;
  currentBulletin = null;
  markActivePost(null);
  markActiveBulletin(null);
  markActiveDoc(id);
  syncDocsFeedTab();
  if (pushUrl) syncUrl({ kind: 'doc', id });
  let row;
  try {
    row = await api('GET', `/api/docs/${id}`);
  } catch (err) {
    currentDocRow = null;
    isDocEditing = false;
    renderDocView({ errorMessage: err.message || '未找到', fallbackId: id });
    return;
  }
  currentDocRow = row;
  isDocEditing = false;
  renderDocView();
  showReader(VIEW.DOC);
  readerNode.scrollTo({ top: 0, behavior: 'instant' });
}

// Open the doc surface with an unsaved draft, pre-entered in edit mode.
// Used by the "新建文档" button. No URL push until the first save.
function openNewDoc() {
  currentDoc = null;
  currentDocRow = {
    id: null,
    channel_id: (filterState.kind === 'channel' ? filterState.value : null),
    title: '',
    content: '',
    created_pseudonym: null,
    last_editor_pseudonym: null,
    created_at: null,
    updated_at: null,
  };
  isDocEditing = true;
  currentThread = null;
  currentBulletin = null;
  markActivePost(null);
  markActiveBulletin(null);
  markActiveDoc(null);
  syncDocsFeedTab();
  renderDocView();
  showReader(VIEW.DOC);
  const titleInput = $('#doc-title-input');
  if (titleInput) titleInput.focus();
}

// Single renderer shared by read and edit modes — DOM stays stable so
// there's no page-level switch when the user enters/leaves edit.
function renderDocView(opts = {}) {
  const row = currentDocRow;
  const errEl = $('#doc-err');
  if (errEl) errEl.textContent = '';

  if (opts.errorMessage || !row) {
    $('#doc-title').textContent = opts.fallbackId != null
      ? `文档 #${opts.fallbackId}` : '文档';
    $('#doc-title').hidden = false;
    $('#doc-title-input').hidden = true;
    $('#doc-meta').textContent = '';
    $('#doc-body').innerHTML = '';
    $('#doc-body').hidden = false;
    $('#doc-body').appendChild(el('p', { className: 'muted', textContent: opts.errorMessage || '未找到' }));
    $('#doc-editor').hidden = true;
    $('#doc-editor-toolbar').hidden = true;
    $('#doc-channel').hidden = true;
    $('#doc-channel-picker').hidden = true;
    $('#doc-actions').hidden = true;
    return;
  }

  const titleEl = $('#doc-title');
  const titleInput = $('#doc-title-input');
  const body = $('#doc-body');
  const editor = $('#doc-editor');
  const toolbar = $('#doc-editor-toolbar');
  const channelChip = $('#doc-channel');
  const channelPicker = $('#doc-channel-picker');
  const meta = $('#doc-meta');

  if (isDocEditing) {
    titleEl.hidden = true;
    titleInput.hidden = false;
    titleInput.value = row.title || '';
    body.hidden = true;
    editor.hidden = false;
    toolbar.hidden = false;
    const textarea = $('#doc-editor-input');
    textarea.value = row.content || '';
    renderDocPreview(textarea.value);
    // Only show the channel picker for new docs (channel is fixed once created).
    if (row.id == null) {
      channelChip.hidden = true;
      channelPicker.hidden = false;
      renderDocChannelSelect(row.channel_id);
    } else {
      channelPicker.hidden = true;
      renderDocChannel(row.channel_id);
    }
  } else {
    titleEl.hidden = false;
    titleInput.hidden = true;
    titleEl.textContent = row.title;
    body.hidden = false;
    body.innerHTML = '';
    body.appendChild(renderMarkdown(row.content || ''));
    editor.hidden = true;
    toolbar.hidden = true;
    channelPicker.hidden = true;
    renderDocChannel(row.channel_id);
  }

  meta.innerHTML = '';
  if (row.id == null) {
    meta.textContent = '新文档尚未发布';
  } else {
    const lastEditor = row.last_editor_pseudonym || row.created_pseudonym;
    applyIdHue(meta, lastEditor);
    const parts = [`创建者 @${row.created_pseudonym}`, fmtDate(row.created_at)];
    if (row.updated_at) parts.push(`最近编辑 @${lastEditor} · ${fmtDate(row.updated_at)}`);
    meta.textContent = parts.join(' · ');
  }

  renderDocActions(row);
}

function renderDocChannelSelect(selected) {
  const sel = $('#doc-channel-select');
  if (!sel) return;
  sel.innerHTML = '';
  sel.appendChild(el('option', { value: '', textContent: '（无）' }));
  for (const ch of channels) {
    sel.appendChild(el('option', { value: String(ch.id), textContent: ch.name }));
  }
  if (selected != null) sel.value = String(selected);
}

function renderDocPreview(text) {
  const box = $('#doc-editor-preview');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(renderMarkdown(text || ''));
}

function scheduleDocPreview() {
  clearTimeout(docPreviewTimer);
  docPreviewTimer = setTimeout(() => {
    const ta = $('#doc-editor-input');
    if (ta && !$('#doc-editor').hidden) renderDocPreview(ta.value);
  }, 150);
}

function renderDocChannel(channelId) {
  const box = $('#doc-channel');
  if (!box) return;
  box.innerHTML = '';
  const ch = channelById(channelId);
  if (!ch) { box.hidden = true; return; }
  box.hidden = false;
  const chip = el('button', {
    type: 'button', className: 'channel-badge', textContent: ch.name,
    title: ch.description || ch.name,
  });
  chip.addEventListener('click', () => {
    setFeedMode('docs', { reload: false });
    filterByChannel(ch.id);
  });
  box.appendChild(chip);
}

function renderDocActions(row) {
  const box = $('#doc-actions');
  box.innerHTML = '';
  const buttons = [];
  const t = getToken();
  if (isDocEditing) {
    const save = el('button', { type: 'button', className: 'ghost small', textContent: row.id == null ? '发布' : '保存' });
    save.addEventListener('click', () => saveDoc());
    buttons.push(save);
    const cancel = el('button', { type: 'button', className: 'ghost small', textContent: '取消' });
    cancel.addEventListener('click', () => cancelDocEdit());
    buttons.push(cancel);
  } else {
    if (row.id != null) {
      const saved = savedDocIds.has(row.id);
      const saveBtn = el('button', {
        type: 'button',
        className: 'ghost small' + (saved ? ' is-saved' : ''),
        textContent: saved ? '★ 已收藏' : '☆ 收藏',
      });
      saveBtn.addEventListener('click', () => toggleSavedDoc(row.id));
      buttons.push(saveBtn);
    }
    // Anyone with a valid posting token can edit; admin always can.
    if (t || isAdmin) {
      const edit = el('button', { type: 'button', className: 'ghost small', textContent: '编辑' });
      edit.addEventListener('click', () => enterDocEdit());
      buttons.push(edit);
    }
    // Delete gate: creator (while token is live) OR admin. The server
    // checks for real — we only show the button when it would succeed.
    const ownsCreator = t && t.pseudonym === row.created_pseudonym;
    if (row.id != null && (isAdmin || ownsCreator)) {
      const del = el('button', { type: 'button', className: 'ghost small danger', textContent: '删除' });
      del.addEventListener('click', () => deleteDoc(row));
      buttons.push(del);
    }
  }
  if (!buttons.length) { box.hidden = true; return; }
  box.hidden = false;
  box.append(...buttons);
}

function enterDocEdit() {
  if (!currentDocRow) return;
  const t = getToken();
  if (!t && !isAdmin) { openDialog(); return; }
  isDocEditing = true;
  renderDocView();
  const ta = $('#doc-editor-input');
  if (ta) { ta.focus(); ta.scrollTop = 0; }
}

function cancelDocEdit() {
  if (currentDocRow && currentDocRow.id == null) {
    // New draft with no server row — drop it and go back to the list.
    currentDocRow = null;
    isDocEditing = false;
    closeReader();
    return;
  }
  isDocEditing = false;
  renderDocView();
}

// The "version" we compare against on the server. Docs that have never
// been edited have updated_at = NULL, so we fall back to created_at so
// there's always a finite number to round-trip.
function docVersion(row) {
  return row && (row.updated_at || row.created_at);
}

async function saveDoc() {
  if (!currentDocRow) return;
  const errEl = $('#doc-err');
  errEl.textContent = '';
  const t = getToken();
  if (!t) { errEl.textContent = '请先获取发帖令牌。'; openDialog(); return; }
  const title = ($('#doc-title-input').value || '').trim();
  const content = ($('#doc-editor-input').value || '').trim();
  if (!title) { errEl.textContent = '标题不能为空。'; return; }
  if (!content) { errEl.textContent = '内容不能为空。'; return; }
  const isNew = currentDocRow.id == null;
  const body = { token: t.token, title, content };
  if (isNew) {
    const rawCh = $('#doc-channel-select').value;
    body.channel_id = rawCh ? parseInt(rawCh, 10) : null;
  } else {
    body.expected_version = docVersion(currentDocRow);
  }
  try {
    const row = isNew
      ? await api('POST', '/api/docs', body)
      : await api('PUT', `/api/docs/${currentDocRow.id}`, body);
    currentDocRow = row;
    currentDoc = row.id;
    isDocEditing = false;
    syncUrl({ kind: 'doc', id: row.id });
    renderDocView();
    if (feedMode === 'docs') loadDocs().catch(() => {});
  } catch (err) {
    if (err.status === 409 && err.data && err.data.latest) {
      handleDocConflict(err.data.latest, title, content);
    } else {
      errEl.textContent = err.message;
    }
  }
}

// Optimistic-lock conflict: someone else saved between fetch and save.
// Rebase onto the server's latest so the user can see what changed, and
// keep their draft below as a markdown blockquote so nothing is lost.
function handleDocConflict(latest, draftTitle, draftContent) {
  currentDocRow = latest;
  currentDoc = latest.id;
  isDocEditing = true;
  renderDocView();
  const titleInput = $('#doc-title-input');
  const textarea = $('#doc-editor-input');
  if (draftTitle && draftTitle !== latest.title) titleInput.value = draftTitle;
  const quoted = draftContent
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  textarea.value = `${latest.content}\n\n---\n\n> **你的未保存草稿：**\n${quoted}`;
  renderDocPreview(textarea.value);
  $('#doc-err').textContent =
    '有人在你之前编辑了这份文档。上方已载入最新版本，你的未保存草稿保留在末尾的引用块里 — 合并后重新保存。';
}

async function deleteDoc(row) {
  if (!confirm(`删除共享文档「${row.title}」？此操作不可撤销。`)) return;
  const body = deleteRequestBody();
  if (!body) { openDialog(); return; }
  try {
    await api('DELETE', `/api/docs/${row.id}`, body);
    currentDoc = null;
    currentDocRow = null;
    isDocEditing = false;
    closeReader();
    if (feedMode === 'docs') await loadDocs();
  } catch (err) {
    alert(err.message);
  }
}

$('#doc-editor-input').addEventListener('input', scheduleDocPreview);

$('#doc-image-btn').addEventListener('click', () => {
  const status = $('#doc-image-status');
  status.textContent = '';
  const picker = el('input', {
    type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true,
  });
  document.body.appendChild(picker);
  picker.addEventListener('change', async () => {
    const file = picker.files && picker.files[0];
    picker.remove();
    if (!file) return;
    if (!getToken() && !isAdmin) { $('#doc-err').textContent = '请先获取发帖令牌。'; openDialog(); return; }
    status.textContent = '上传中…';
    try {
      const url = await uploadImage(file);
      const ta = $('#doc-editor-input');
      insertAtCursor(ta, `![](${url})\n`);
      renderDocPreview(ta.value);
      status.textContent = '已插入到正文。EXIF 已被剥离。';
    } catch (err) {
      status.textContent = err.message;
    }
  });
  picker.click();
});

for (const btn of $$('#feed-tabs .feed-tab')) {
  btn.addEventListener('click', () => setFeedMode(btn.dataset.mode));
}

// SECTION: compose-upload
// Image uploads: content-addressed, no user_id storage. The server
// strips EXIF via sharp, resizes to max 1600px wide, and emits WebP
// (except for PNGs, which stay PNG to preserve transparency).
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

// SECTION: post-card
function renderPostCard(p) {
  const titleChildren = [
    el('span', { className: 'id-badge', textContent: `#${p.id}` }),
    el('span', { className: 'post-title', textContent: p.title }),
  ];
  if (p.hit_in_comment && !p.hit_in_post) {
    titleChildren.push(el('span', { className: 'hit-badge', title: '匹配在评论里', textContent: '评论命中' }));
  }
  const titleRow = el('div', { className: 'post-title-row' }, titleChildren);
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

// SECTION: search
// --- Search ---

// `#<id>` or a bare positive integer is treated as a direct post lookup
// rather than an FTS query — the search input doubles as a jump-to-post box.
const POST_ID_SEARCH_RE = /^#?(\d{1,10})$/;

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) { clearFilter(); return; }
  // `#<id>` is always a post-id jump regardless of which tab is active —
  // docs use their own `@<pseudonym>`-style mentions but don't have a
  // short numeric shortcut.
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
  renderFilterBar();
  if (feedMode === 'docs') await loadDocs();
  else await loadFeed();
  showReader(VIEW.EMPTY);
});
$('#search-input').addEventListener('input', () => {
  $('#search-clear').hidden = !$('#search-input').value;
});
$('#search-clear').addEventListener('click', clearFilter);

// SECTION: compose
// --- Compose post ---

$('#compose-btn').addEventListener('click', () => {
  if (feedMode === 'docs') openNewDoc();
  else openCompose();
});

function openCompose() {
  const f = $('#post-form');
  f.reset();
  renderComposeChannels();
  resetPollBuilder();
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

$('#post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#post-err').textContent = '';
  const t = getToken();
  if (!t) { $('#post-err').textContent = '请先获取发帖令牌。'; openDialog(); return; }
  const f = e.target;
  const rawCh = f.channel_id && f.channel_id.value;
  const channel_id = rawCh ? parseInt(rawCh, 10) : null;
  const poll = collectPollInput();
  if (poll && poll.error) { $('#post-err').textContent = poll.error; return; }
  try {
    const created = await api('POST', '/api/posts', {
      token: t.token, title: f.title.value, content: f.content.value, channel_id,
      poll: poll ? poll.value : null,
    });
    f.reset();
    resetPollBuilder();
    const feed = $('#feed');
    const emptyMsg = feed.querySelector('.feed-empty');
    if (emptyMsg) emptyMsg.remove();
    feedPosts.unshift(created);
    feed.prepend(renderPostCard(created));
    const ch = channelById(created.channel_id);
    if (ch) { ch.post_count = (ch.post_count || 0) + 1; renderChannelList(); }
    await openThread(created.id);
  } catch (err) {
    $('#post-err').textContent = err.message;
  }
});

// SECTION: poll
// --- Poll: composer builder + thread renderer ---
const POLL_OPTIONS_MIN = 2;
const POLL_OPTIONS_MAX = 10;

function resetPollBuilder() {
  const wrap = $('#poll-builder');
  const btn = $('#post-poll-btn');
  wrap.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = '🗳️ 添加投票';
  const form = $('#post-form');
  if (form && form.poll_question) form.poll_question.value = '';
  const box = $('#poll-options');
  box.innerHTML = '';
  for (let i = 0; i < POLL_OPTIONS_MIN; i++) box.appendChild(pollOptionRow(i));
  updatePollAddButton();
}

function pollOptionRow(i) {
  const input = el('input', {
    name: 'poll_option',
    type: 'text',
    placeholder: `选项 ${i + 1}`,
    maxLength: 80,
    autocomplete: 'off',
  });
  input.className = 'poll-option-input';
  const remove = el('button', {
    type: 'button', className: 'ghost small poll-option-remove', textContent: '×', title: '移除选项',
  });
  remove.addEventListener('click', () => {
    const box = $('#poll-options');
    if (box.children.length <= POLL_OPTIONS_MIN) return;
    row.remove();
    relabelPollOptions();
    updatePollAddButton();
  });
  const row = el('div', { className: 'poll-option-row' }, [input, remove]);
  return row;
}

function relabelPollOptions() {
  const box = $('#poll-options');
  [...box.children].forEach((row, i) => {
    const input = row.querySelector('input');
    if (input) input.placeholder = `选项 ${i + 1}`;
  });
}

function updatePollAddButton() {
  const box = $('#poll-options');
  $('#poll-add-option').disabled = box.children.length >= POLL_OPTIONS_MAX;
  const canRemove = box.children.length > POLL_OPTIONS_MIN;
  for (const row of box.children) {
    const btn = row.querySelector('.poll-option-remove');
    if (btn) btn.disabled = !canRemove;
  }
}

$('#post-poll-btn').addEventListener('click', () => {
  const wrap = $('#poll-builder');
  const btn = $('#post-poll-btn');
  const opening = wrap.hidden;
  wrap.hidden = !opening;
  btn.setAttribute('aria-expanded', String(opening));
  btn.textContent = opening ? '🗳️ 收起投票' : '🗳️ 添加投票';
  if (opening) {
    const q = $('#post-form').poll_question;
    if (q) q.focus();
  }
});

$('#poll-add-option').addEventListener('click', () => {
  const box = $('#poll-options');
  if (box.children.length >= POLL_OPTIONS_MAX) return;
  box.appendChild(pollOptionRow(box.children.length));
  updatePollAddButton();
});

$('#poll-remove').addEventListener('click', () => resetPollBuilder());

function collectPollInput() {
  const wrap = $('#poll-builder');
  if (wrap.hidden) return null;
  const form = $('#post-form');
  const question = form.poll_question ? form.poll_question.value.trim() : '';
  const options = [...$('#poll-options').querySelectorAll('input[name="poll_option"]')]
    .map((i) => i.value.trim())
    .filter(Boolean);
  if (!question) return { error: '投票问题不能为空' };
  const unique = [...new Set(options)];
  if (unique.length < POLL_OPTIONS_MIN) return { error: `投票至少需要 ${POLL_OPTIONS_MIN} 个不重复选项` };
  return { value: { question, options: unique } };
}

function renderPoll(poll) {
  const box = $('#thread-poll');
  box.innerHTML = '';
  if (!poll) { box.hidden = true; return; }
  box.hidden = false;

  box.appendChild(el('div', { className: 'poll-question', textContent: poll.question }));
  const hasToken = !!getToken();

  if (poll.voted) {
    const total = poll.total || 0;
    const countMap = new Map((poll.counts || []).map((c) => [c.option_id, c.votes]));
    const list = el('div', { className: 'poll-results' });
    for (const o of poll.options) {
      const votes = countMap.get(o.id) || 0;
      const pct = total > 0 ? Math.round((votes / total) * 1000) / 10 : 0;
      const labelRow = el('div', { className: 'poll-result-head' }, [
        el('span', { className: 'poll-result-label', textContent: o.label }),
        el('span', { className: 'poll-result-count', textContent: `${votes} 票 · ${pct}%` }),
      ]);
      const bar = el('div', { className: 'poll-bar' });
      const fill = el('div', { className: 'poll-bar-fill' });
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      const row = el('div', { className: 'poll-result-row' + (o.id === poll.my_option_id ? ' is-mine' : '') }, [labelRow, bar]);
      list.appendChild(row);
    }
    box.appendChild(list);
    box.appendChild(el('div', { className: 'poll-foot muted', textContent: `共 ${total} 票 · 你已投票，结果已揭晓。` }));
    return;
  }

  const form = el('form', { className: 'poll-vote-form' });
  const list = el('div', { className: 'poll-choices' });
  for (const o of poll.options) {
    const input = el('input', { type: 'radio', name: 'poll_choice', value: String(o.id) });
    input.required = true;
    const label = el('label', { className: 'poll-choice' }, [
      input,
      el('span', { className: 'poll-choice-label', textContent: o.label }),
    ]);
    list.appendChild(label);
  }
  form.appendChild(list);
  const submit = el('button', { type: 'submit', className: 'poll-vote-submit', textContent: '投票' });
  const hint = el('div', { className: 'muted poll-hint' });
  hint.textContent = hasToken
    ? '投票后才能看到每个选项的人数和比例。投票后无法更改。'
    : '请先领取发帖令牌才能投票。';
  if (!hasToken) submit.disabled = true;
  const actions = el('div', { className: 'poll-vote-actions' }, [submit, hint]);
  form.appendChild(actions);
  const err = el('div', { className: 'err poll-err' });
  form.appendChild(err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.textContent = '';
    const picked = form.querySelector('input[name="poll_choice"]:checked');
    if (!picked) { err.textContent = '请选择一个选项。'; return; }
    submitPollVote(parseInt(picked.value, 10), err).catch(() => {});
  });
  box.appendChild(form);
}

async function submitPollVote(optionId, errNode) {
  if (currentThread == null) return;
  const t = getToken();
  if (!t) { openDialog(); return; }
  const postId = currentThread;
  try {
    const r = await api('POST', `/api/posts/${postId}/vote`, { token: t.token, option_id: optionId });
    if (currentThread !== postId) return;
    setMyVote(t.pseudonym, postId, optionId);
    renderPoll(r.poll);
  } catch (err) {
    if (/令牌/.test(err.message)) { openDialog(); return; }
    if (errNode) errNode.textContent = err.message;
  }
}

// Reveal results when the local hint says we already voted on this poll
// from an earlier session. The server still gates whether counts come back.
async function refreshPollForCurrentThread() {
  const t = getToken();
  if (!t) return;
  const postId = currentThread;
  if (!myVoteFor(t.pseudonym, postId)) return;
  try {
    const r = await api('POST', `/api/posts/${postId}/vote`, { token: t.token });
    if (currentThread !== postId) return;
    if (r.poll && r.poll.voted) renderPoll(r.poll);
  } catch { /* ignore */ }
}

// SECTION: reader
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
    // Reload the thread so the tombstone view renders with comments intact.
    await openThread(gone, { pushUrl: false });
  } catch (err) {
    alert(err.message);
  }
}

async function openThread(id, { pushUrl = true } = {}) {
  currentThread = id;
  currentBulletin = null;
  currentDoc = null;
  markActiveBulletin(null);
  markActiveDoc(null);
  markActivePost(id);
  if (feedMode !== 'posts') setFeedMode('posts');
  if (pushUrl) syncUrl({ kind: 'post', id });
  let data;
  try {
    data = await api('GET', `/api/posts/${id}`);
  } catch (err) {
    renderMissingThread(id, err.message);
    return;
  }
  const { post, comments, reactions, poll } = data;
  const deleted = !!post.deleted_at;
  currentComments = comments.slice();
  currentPostPseudonym = deleted ? null : post.pseudonym;
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
  renderThreadActions();
  if (deleted) {
    $('#reactions').innerHTML = '';
    $('#reactions').hidden = true;
    renderPoll(null);
  } else {
    $('#reactions').hidden = false;
    renderReactions(reactions || Object.fromEntries(REACTION_KINDS.map((k) => [k, 0])));
    renderPoll(poll || null);
    refreshPollForCurrentThread().catch(() => {});
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
  currentPostCanDelete = false;
  renderPoll(null);
  $('#reactions').innerHTML = '';
  $('#reactions').hidden = false;
  $('#comment-form').hidden = false;
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
    currentDoc = null;
    markActivePost(null);
    markActiveBulletin(null);
    markActiveDoc(null);
    showReader(VIEW.EMPTY);
  } else if (route.kind === 'post' && route.id !== currentThread) {
    openThread(route.id, { pushUrl: false }).catch(() => {});
  } else if (route.kind === 'doc' && route.id !== currentDoc) {
    openDoc(route.id, { pushUrl: false }).catch(() => {});
  } else if (route.kind === 'bulletin' && route.id !== currentBulletin) {
    openBulletin(route.id, { pushUrl: false }).catch(() => {});
  }
});

// SECTION: comments
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

// SECTION: reactions-ui
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

// SECTION: mentions-dialog
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

// SECTION: markdown
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
    m = /^\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$(?!\w)/.exec(rest);
    if (m) {
      const span = el('span', { className: 'math-inline' });
      renderMathInto(span, m[1], false);
      parent.appendChild(span);
      i += m[0].length;
      continue;
    }
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
    const stop = /!?\[|[`*$]/.exec(inSlice);
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

// SECTION: syntax-highlight
// --- Syntax highlighting for fenced code blocks ---

const HL_LANG_ALIASES = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  ts: 'js', typescript: 'js', tsx: 'js',
  json: 'json', json5: 'json',
  py: 'py', python: 'py', python3: 'py',
  c: 'c', 'c++': 'c', cpp: 'c', cc: 'c', h: 'c', hpp: 'c', cxx: 'c',
  java: 'c', kotlin: 'c', kt: 'c', scala: 'c', swift: 'c',
  cs: 'c', 'c#': 'c', csharp: 'c', php: 'c',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', ksh: 'sh',
  sql: 'sql', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
};

const HL_RULES = {
  js: {
    rules: [
      ['com', /\/\/[^\n]*/y],
      ['com', /\/\*[\s\S]*?\*\//y],
      ['str', /`(?:[^`\\]|\\[\s\S])*`/y],
      ['str', /"(?:[^"\\\n]|\\[\s\S])*"/y],
      ['str', /'(?:[^'\\\n]|\\[\s\S])*'/y],
      ['num', /0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?/y],
      ['ident', /[A-Za-z_$][\w$]*/y],
      ['op', /[+\-*/%=<>!&|^~?:]+/y],
    ],
    keywords: new Set(['async','await','break','case','catch','class','const','continue','debugger','default','delete','do','else','export','extends','finally','for','from','function','if','import','in','instanceof','let','new','of','return','static','super','switch','this','throw','try','typeof','var','void','while','with','yield','as','enum','interface','type','public','private','protected','readonly','implements','declare','abstract','namespace','keyof','satisfies']),
    constants: new Set(['true','false','null','undefined','NaN','Infinity','globalThis']),
  },
  py: {
    rules: [
      ['com', /#[^\n]*/y],
      ['str', /[rRbBfFuU]{0,2}"""[\s\S]*?"""/y],
      ['str', /[rRbBfFuU]{0,2}'''[\s\S]*?'''/y],
      ['str', /[rRbBfFuU]{0,2}"(?:[^"\\\n]|\\[\s\S])*"/y],
      ['str', /[rRbBfFuU]{0,2}'(?:[^'\\\n]|\\[\s\S])*'/y],
      ['num', /0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?j?/y],
      ['ident', /[A-Za-z_][\w]*/y],
      ['op', /[+\-*/%=<>!&|^~?:@]+/y],
    ],
    keywords: new Set(['and','as','assert','async','await','break','class','continue','def','del','elif','else','except','finally','for','from','global','if','import','in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield','match','case']),
    constants: new Set(['True','False','None','self','cls','__name__','__init__']),
  },
  c: {
    rules: [
      ['com', /\/\/[^\n]*/y],
      ['com', /\/\*[\s\S]*?\*\//y],
      ['com', /#[^\n]*/y],
      ['str', /"(?:[^"\\\n]|\\[\s\S])*"/y],
      ['str', /'(?:[^'\\\n]|\\[\s\S])*'/y],
      ['num', /0[xX][0-9a-fA-F_]+[uUlLfF]*|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[uUlLfFdD]*/y],
      ['ident', /[A-Za-z_][\w]*/y],
      ['op', /[+\-*/%=<>!&|^~?:]+/y],
    ],
    keywords: new Set(['auto','break','case','char','const','continue','default','do','double','else','enum','extern','float','for','goto','if','inline','int','long','register','restrict','return','short','signed','sizeof','static','struct','switch','typedef','union','unsigned','void','volatile','while','bool','class','public','private','protected','virtual','new','delete','try','catch','throw','namespace','using','template','typename','explicit','friend','operator','mutable','final','override','abstract','extends','implements','interface','package','import']),
    constants: new Set(['true','false','TRUE','FALSE','NULL','nullptr','this','self']),
  },
  rust: {
    rules: [
      ['com', /\/\/[^\n]*/y],
      ['com', /\/\*[\s\S]*?\*\//y],
      ['str', /b?"(?:[^"\\\n]|\\[\s\S])*"/y],
      ['str', /b?'(?:[^'\\\n]|\\[\s\S])*'/y],
      ['num', /0[xX][0-9a-fA-F_]+(?:[iuf](?:8|16|32|64|128|size))?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:[iuf](?:8|16|32|64|128|size))?/y],
      ['ident', /[A-Za-z_][\w]*/y],
      ['op', /[+\-*/%=<>!&|^~?:]+/y],
    ],
    keywords: new Set(['as','async','await','break','const','continue','crate','dyn','else','enum','extern','fn','for','if','impl','in','let','loop','match','mod','move','mut','pub','ref','return','static','struct','super','trait','type','unsafe','use','where','while','yield','box']),
    constants: new Set(['true','false','None','Some','Ok','Err','self','Self']),
  },
  go: {
    rules: [
      ['com', /\/\/[^\n]*/y],
      ['com', /\/\*[\s\S]*?\*\//y],
      ['str', /`[^`]*`/y],
      ['str', /"(?:[^"\\\n]|\\[\s\S])*"/y],
      ['str', /'(?:[^'\\\n]|\\[\s\S])*'/y],
      ['num', /0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y],
      ['ident', /[A-Za-z_][\w]*/y],
      ['op', /[+\-*/%=<>!&|^~?:]+/y],
    ],
    keywords: new Set(['break','case','chan','const','continue','default','defer','else','fallthrough','for','func','go','goto','if','import','interface','map','package','range','return','select','struct','switch','type','var']),
    constants: new Set(['true','false','nil','iota']),
  },
  sql: {
    rules: [
      ['com', /--[^\n]*/y],
      ['com', /\/\*[\s\S]*?\*\//y],
      ['str', /'(?:[^'\\]|\\[\s\S]|'')*'/y],
      ['str', /"(?:[^"\\]|\\[\s\S])*"/y],
      ['num', /\d+(?:\.\d+)?/y],
      ['ident', /[A-Za-z_][\w]*/y],
      ['op', /[+\-*/%=<>!]+/y],
    ],
    keywords: new Set(['select','from','where','and','or','not','in','is','null','like','between','join','inner','left','right','outer','cross','on','group','by','order','asc','desc','limit','offset','having','union','all','distinct','insert','into','values','update','set','delete','create','table','drop','alter','add','column','primary','key','foreign','references','index','unique','constraint','default','cascade','as','with','case','when','then','else','end','exists','count','sum','avg','min','max','returning','conflict','do','nothing','begin','commit','rollback','transaction','if','pragma','integer','text','real','blob','numeric']),
    constants: new Set(['true','false','null','current_timestamp','current_date','current_time']),
    caseInsensitive: true,
  },
  sh: {
    rules: [
      ['com', /#[^\n]*/y],
      ['str', /"(?:[^"\\\n]|\\[\s\S])*"/y],
      ['str', /'[^'\n]*'/y],
      ['var', /\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[?$!#0-9]/y],
      ['num', /\d+/y],
      ['ident', /[A-Za-z_][\w.-]*/y],
      ['op', /[|&;<>()={}!]+/y],
    ],
    keywords: new Set(['if','then','else','elif','fi','case','esac','for','while','until','do','done','in','function','return','break','continue','exit','export','local','readonly','declare','unset','alias','source','trap','shift','set']),
    constants: new Set(['true','false']),
  },
  json: {
    rules: [
      ['str', /"(?:[^"\\\n]|\\[\s\S])*"/y],
      ['num', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
      ['ident', /[A-Za-z]+/y],
      ['op', /[{}[\],:]/y],
    ],
    keywords: new Set(),
    constants: new Set(['true','false','null']),
  },
  css: {
    rules: [
      ['com', /\/\*[\s\S]*?\*\//y],
      ['str', /"(?:[^"\\\n]|\\[\s\S])*"/y],
      ['str', /'(?:[^'\\\n]|\\[\s\S])*'/y],
      ['num', /#[0-9a-fA-F]{3,8}\b/y],
      ['num', /-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|vmin|vmax|s|ms|deg|rad|turn|fr|ch|ex)?/y],
      ['kw', /@[A-Za-z-]+/y],
      ['ident', /--?[A-Za-z_][\w-]*/y],
      ['ident', /[A-Za-z_][\w-]*/y],
      ['op', /[{}:;,()>~+*]+/y],
    ],
    keywords: new Set(['important','inherit','initial','unset','auto','none','normal','bold','italic']),
    constants: new Set(),
  },
};

function highlightInto(node, langRaw, code) {
  const cfg = HL_RULES[HL_LANG_ALIASES[(langRaw || '').toLowerCase()]];
  if (!cfg) { node.textContent = code; return; }
  const rules = cfg.rules;
  let pending = '';
  const flushPending = () => {
    if (pending) { node.appendChild(document.createTextNode(pending)); pending = ''; }
  };
  const appendTok = (type, s) => {
    if (type === 'text') { pending += s; return; }
    flushPending();
    node.appendChild(el('span', { className: `tok-${type}`, textContent: s }));
  };
  let i = 0;
  while (i < code.length) {
    let hitType = null, hitValue = null;
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r];
      const re = rule[1];
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m.index === i && m[0]) { hitType = rule[0]; hitValue = m[0]; break; }
    }
    if (hitValue === null) { pending += code[i]; i++; continue; }
    if (hitType === 'ident') {
      const probe = cfg.caseInsensitive ? hitValue.toLowerCase() : hitValue;
      if (cfg.keywords.has(probe)) hitType = 'kw';
      else if (cfg.constants.has(probe)) hitType = 'bool';
      else if (code[i + hitValue.length] === '(') hitType = 'fn';
      else hitType = 'text';
    }
    appendTok(hitType, hitValue);
    i += hitValue.length;
  }
  flushPending();
}

// SECTION: math
// --- LaTeX math via KaTeX ---

const KATEX_OPTS_INLINE = { throwOnError: false, displayMode: false, output: 'html', strict: 'ignore' };
const KATEX_OPTS_BLOCK  = { throwOnError: false, displayMode: true,  output: 'html', strict: 'ignore' };

function renderMathInto(node, expr, displayMode) {
  const k = window.katex;
  if (k && typeof k.render === 'function') {
    try {
      k.render(expr, node, displayMode ? KATEX_OPTS_BLOCK : KATEX_OPTS_INLINE);
      return;
    } catch (_) { /* fall through to text */ }
  }
  const wrap = displayMode ? '$$' : '$';
  node.textContent = wrap + expr + wrap;
}

function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  if (typeof text !== 'string' || !text) return frag;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```([A-Za-z0-9_+#-]*)\s*$/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++;
      const lang = fence[1] || '';
      const code = el('code');
      if (lang) code.className = `lang-${lang}`;
      highlightInto(code, lang, buf.join('\n'));
      frag.appendChild(el('pre', {}, [code]));
      continue;
    }
    if (line.startsWith('$$')) {
      const buf = [];
      let rest = line.slice(2);
      if (rest.endsWith('$$')) {
        buf.push(rest.slice(0, -2));
        i++;
      } else {
        buf.push(rest);
        i++;
        while (i < lines.length) {
          const ln = lines[i];
          const trimmed = ln.replace(/\s+$/, '');
          if (trimmed.endsWith('$$')) {
            buf.push(trimmed.slice(0, -2));
            i++;
            break;
          }
          buf.push(ln);
          i++;
        }
      }
      const wrap = el('div', { className: 'math-block' });
      renderMathInto(wrap, buf.join('\n').trim(), true);
      frag.appendChild(wrap);
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
           !/^\d+\.\s+/.test(lines[i]) && !lines[i].startsWith('$$')) {
      buf.push(lines[i]); i++;
    }
    // A line that starts with ``` but doesn't match the fence regex (e.g.
    // `\`\`\`1+1\`\`\``) would otherwise spin the outer loop forever, since
    // the guard above rejects it without advancing i.
    if (buf.length === 0) { buf.push(lines[i]); i++; }
    const p = el('p');
    renderInlineWithBreaks(buf.join('\n'), p);
    frag.appendChild(p);
  }
  return frag;
}

// SECTION: autocomplete
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

// SECTION: sidebar+init
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
