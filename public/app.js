const TOKEN_STORE_KEY = 'anonforum.token';
const THEME_STORE_KEY = 'anonforum.theme';

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
    return t;
  } catch {
    return null;
  }
}
function setToken(t) { localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify(t)); }
function clearToken() { localStorage.removeItem(TOKEN_STORE_KEY); }

function fmtDate(ms) { return new Date(ms).toLocaleString('zh-CN'); }
function fmtMeta(pseudonym, createdAt) { return `${pseudonym} · ${fmtDate(createdAt)}`; }
function metaLine(pseudonym, createdAt) {
  return el('div', { className: 'meta', textContent: fmtMeta(pseudonym, createdAt) });
}

const VIEW = { EMPTY: 'empty-view', THREAD: 'thread-view', COMPOSE: 'compose-view' };
const viewNodes = Object.fromEntries(Object.values(VIEW).map((id) => [id, $('#' + id)]));
const readerNode = $('#reader');
let currentView = null;

function showReader(which) {
  if (currentView === which) return;
  for (const id of Object.values(VIEW)) viewNodes[id].hidden = id !== which;
  currentView = which;
  if (window.innerWidth <= 760) readerNode.classList.toggle('open', which !== VIEW.EMPTY);
}

function closeReader() {
  currentThread = null;
  markActivePost(null);
  showReader(VIEW.EMPTY);
}

function renderTokenChip() {
  const t = getToken();
  const chip = $('#token-toggle');
  const text = $('#token-chip-text');
  chip.classList.toggle('active', !!t);
  text.textContent = t ? `匿名 ID：${t.pseudonym}` : '未领取令牌 — 点击获取';
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
    textContent: `约 ${hrs} 小时后过期 · 匿名 ID：${t.pseudonym}`,
  }));
}

function openDialog() {
  renderTokenBox();
  $('#token-err').textContent = '';
  $('#token-dialog').hidden = false;
}
function closeDialog() { $('#token-dialog').hidden = true; }

$('#token-toggle').addEventListener('click', openDialog);
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-close]');
  if (!t) return;
  const kind = t.dataset.close;
  if (kind === 'dialog') closeDialog();
  else if (kind === 'reader') closeReader();
});

async function refreshMe() {
  try {
    const me = await api('GET', '/api/me');
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
    await loadFeed();
    showReader(VIEW.EMPTY);
  } catch {
    $('#auth-view').hidden = false;
    $('#forum-view').hidden = true;
    $('#userbar').innerHTML = '';
  }
}

async function logout() {
  await api('POST', '/api/logout');
  clearToken();
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

$('#new-token').addEventListener('click', async () => {
  $('#token-err').textContent = '';
  try {
    const r = await api('POST', '/api/token');
    setToken({ token: r.token, pseudonym: r.pseudonym, expires_at: r.expires_at });
    renderTokenBox();
    renderTokenChip();
  } catch (err) {
    $('#token-err').textContent = err.message;
  }
});

function renderPostCard(p) {
  const preview = p.truncated ? p.content + '…' : p.content;
  const node = el('div', { className: 'post' }, [
    el('div', { className: 'post-title', textContent: p.title }),
    el('div', { className: 'post-preview', textContent: preview }),
    metaLine(p.pseudonym, p.created_at),
  ]);
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

async function loadFeed() {
  const feed = $('#feed');
  feed.innerHTML = '';
  const rows = await api('GET', '/api/posts');
  if (!rows.length) {
    feed.appendChild(el('div', { className: 'feed-empty', textContent: '还没有帖子。做第一个发帖的人吧。' }));
    return;
  }
  for (const p of rows) feed.appendChild(renderPostCard(p));
}

$('#compose-btn').addEventListener('click', () => {
  currentThread = null;
  markActivePost(null);
  $('#post-err').textContent = '';
  $('#post-form').reset();
  showReader(VIEW.COMPOSE);
  $('#post-form [name=title]').focus();
});

$('#post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#post-err').textContent = '';
  const t = getToken();
  if (!t) { $('#post-err').textContent = '请先获取发帖令牌。'; openDialog(); return; }
  const f = e.target;
  try {
    const created = await api('POST', '/api/posts', {
      token: t.token, title: f.title.value, content: f.content.value,
    });
    f.reset();
    const feed = $('#feed');
    const emptyMsg = feed.querySelector('.feed-empty');
    if (emptyMsg) emptyMsg.remove();
    feed.prepend(renderPostCard(created));
    await openThread(created.id);
  } catch (err) {
    $('#post-err').textContent = err.message;
  }
});

let currentThread = null;

function renderComment(c) {
  return el('div', { className: 'comment' }, [
    metaLine(c.pseudonym, c.created_at),
    el('div', { className: 'comment-body', textContent: c.content }),
  ]);
}

async function openThread(id) {
  currentThread = id;
  markActivePost(id);
  const { post, comments } = await api('GET', `/api/posts/${id}`);
  $('#thread-title').textContent = post.title;
  $('#thread-meta').textContent = fmtMeta(post.pseudonym, post.created_at);
  $('#thread-body').textContent = post.content;
  const box = $('#comments');
  box.innerHTML = '';
  if (!comments.length) {
    box.appendChild(el('div', { className: 'empty-comments', textContent: '还没有评论。' }));
  } else {
    for (const c of comments) box.appendChild(renderComment(c));
  }
  $('#comment-err').textContent = '';
  $('#comment-form').reset();
  showReader(VIEW.THREAD);
  readerNode.scrollTo({ top: 0, behavior: 'instant' });
}

$('#comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#comment-err').textContent = '';
  if (currentThread == null) return;
  const t = getToken();
  if (!t) { $('#comment-err').textContent = '请先获取发帖令牌。'; openDialog(); return; }
  try {
    const created = await api('POST', `/api/posts/${currentThread}/comments`, {
      token: t.token, content: e.target.content.value,
    });
    e.target.reset();
    const box = $('#comments');
    const empty = box.querySelector('.empty-comments');
    if (empty) empty.remove();
    box.appendChild(renderComment(created));
  } catch (err) {
    $('#comment-err').textContent = err.message;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#token-dialog').hidden) { closeDialog(); return; }
  if (currentView !== VIEW.EMPTY) closeReader();
});

refreshMe();
