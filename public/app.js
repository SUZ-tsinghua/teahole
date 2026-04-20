const TOKEN_STORE_KEY = 'anonforum.token';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};

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
function metaLine(pseudonym, createdAt) {
  return el('div', { className: 'meta', textContent: `${pseudonym} • ${fmtDate(createdAt)}` });
}

function renderTokenBox() {
  const box = $('#token-box');
  const t = getToken();
  if (!t) { box.textContent = '当前没有可用的发帖令牌。'; return; }
  const hrs = Math.max(0, Math.round((t.expires_at - Date.now()) / 3600000));
  box.innerHTML = '';
  box.appendChild(el('div', { textContent: t.token }));
  box.appendChild(el('div', {
    className: 'muted',
    textContent: `约 ${hrs} 小时后过期 — 帖子中显示的匿名 ID：${t.pseudonym}`,
  }));
}

async function refreshMe() {
  try {
    const me = await api('GET', '/api/me');
    $('#auth-view').hidden = true;
    $('#forum-view').hidden = false;
    $('#userbar').innerHTML = '';
    $('#userbar').append(
      el('span', { textContent: `@${me.username}${me.admin ? '（管理员）' : ''}` }),
      el('button', { textContent: '退出登录', onclick: logout }),
    );
    renderTokenBox();
    await loadFeed();
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
  } catch (err) {
    $('#token-err').textContent = err.message;
  }
});

function renderPostCard(p) {
  const preview = p.truncated ? p.content + '…' : p.content;
  return el('div', { className: 'post', onclick: () => openThread(p.id) }, [
    el('div', { className: 'post-title', textContent: p.title }),
    el('div', { className: 'post-preview', textContent: preview }),
    metaLine(p.pseudonym, p.created_at),
  ]);
}

$('#post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#post-err').textContent = '';
  const t = getToken();
  if (!t) { $('#post-err').textContent = '请先获取发帖令牌。'; return; }
  const f = e.target;
  try {
    const created = await api('POST', '/api/posts', {
      token: t.token, title: f.title.value, content: f.content.value,
    });
    f.reset();
    const feed = $('#feed');
    const emptyMsg = feed.querySelector('.muted');
    if (emptyMsg) emptyMsg.remove();
    feed.prepend(renderPostCard(created));
  } catch (err) {
    $('#post-err').textContent = err.message;
  }
});

async function loadFeed() {
  const feed = $('#feed');
  feed.innerHTML = '';
  const rows = await api('GET', '/api/posts');
  if (!rows.length) {
    feed.appendChild(el('div', { className: 'muted', textContent: '暂无帖子。' }));
    return;
  }
  for (const p of rows) feed.appendChild(renderPostCard(p));
}

let currentThread = null;

function renderComment(c) {
  return el('div', { className: 'comment' }, [
    metaLine(c.pseudonym, c.created_at),
    el('div', { className: 'comment-body', textContent: c.content }),
  ]);
}

async function openThread(id) {
  currentThread = id;
  const { post, comments } = await api('GET', `/api/posts/${id}`);
  $('#thread-card').hidden = false;
  $('#thread-title').textContent = post.title;
  $('#thread-meta').textContent = `${post.pseudonym} • ${fmtDate(post.created_at)}`;
  $('#thread-body').innerHTML = '';
  $('#thread-body').appendChild(el('div', { className: 'comment-body', textContent: post.content }));
  const box = $('#comments');
  box.innerHTML = '';
  if (!comments.length) {
    box.appendChild(el('div', { className: 'muted empty-comments', textContent: '暂无评论。' }));
  } else {
    for (const c of comments) box.appendChild(renderComment(c));
  }
  window.scrollTo({ top: $('#thread-card').offsetTop, behavior: 'smooth' });
}

$('#close-thread').addEventListener('click', () => {
  currentThread = null;
  $('#thread-card').hidden = true;
});

$('#comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#comment-err').textContent = '';
  if (currentThread == null) return;
  const t = getToken();
  if (!t) { $('#comment-err').textContent = '请先获取发帖令牌。'; return; }
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

refreshMe();
