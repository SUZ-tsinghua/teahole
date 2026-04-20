const TOKEN_STORE_KEY = 'anonforum.token';
const THEME_STORE_KEY = 'anonforum.theme';
const MY_REACTIONS_KEY = 'anonforum.myReactions';
const REACTION_KINDS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

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
  syncUrl(null);
}

const POST_PATH_RE = /^\/p\/(\d{1,10})$/;
function postIdFromPath() {
  const m = POST_PATH_RE.exec(location.pathname);
  return m ? parseInt(m[1], 10) : null;
}
function syncUrl(id) {
  const target = id == null ? '/' : `/p/${id}`;
  if (location.pathname === target) return;
  history.pushState({ postId: id }, '', target);
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
    const initialId = postIdFromPath();
    if (initialId != null) await openThread(initialId, { pushUrl: false });
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
  const titleRow = el('div', { className: 'post-title-row' }, [
    el('span', { className: 'id-badge', textContent: `#${p.id}` }),
    el('span', { className: 'post-title', textContent: p.title }),
  ]);
  const node = el('div', { className: 'post' }, [
    titleRow,
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
  feedPosts = rows;
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
    feedPosts.unshift(created);
    feed.prepend(renderPostCard(created));
    await openThread(created.id);
  } catch (err) {
    $('#post-err').textContent = err.message;
  }
});

let currentThread = null;
let currentComments = [];
let currentPostPseudonym = null;
let currentReactions = null;
const MAX_VISUAL_DEPTH = 4;
const MENTION_RE = /@([a-f0-9]{8})|#(\d{1,10})/g;
let feedPosts = [];

function knownPseudonyms() {
  const set = new Set();
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

function renderTextWithMentions(text) {
  const frag = document.createDocumentFragment();
  MENTION_RE.lastIndex = 0;
  let last = 0, m;
  while ((m = MENTION_RE.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const p = m[1];
      const chip = el('a', { className: 'mention', href: '#', textContent: `@${p}` });
      chip.dataset.pseudonym = p;
      chip.addEventListener('click', (e) => { e.preventDefault(); jumpToPseudonym(p); });
      frag.appendChild(chip);
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

// Markdown renderer. Purpose-built, no deps. Emits a DocumentFragment built
// from real DOM nodes — never innerHTML on user content. Plain text runs are
// passed through renderTextWithMentions so @xxxxxxxx / #<id> chips still bind.
const SAFE_URL_RE = /^(https?:\/\/|\/p\/\d{1,10}(?:[?#].*)?$)/i;
function safeUrl(u) { return typeof u === 'string' && SAFE_URL_RE.test(u.trim()) ? u.trim() : null; }

// Inline tokens: code span, bold, italic, link. Emits nodes into parent,
// routing any leftover text through renderTextWithMentions (which also emits
// plain text when no mention is found, so this composes cleanly).
function renderInline(text, parent) {
  // Scan left-to-right, greedily matching the earliest special token.
  const push = (s) => { if (s) parent.appendChild(renderTextWithMentions(s)); };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // Inline code first — its content is opaque (no further markdown inside).
    let m = /^`([^`\n]+)`/.exec(rest);
    if (m) { parent.appendChild(el('code', { textContent: m[1] })); i += m[0].length; continue; }
    // Link: [text](url). Reject unsafe schemes — render as literal text.
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
    // Bold (**x**) before italic (*x*) so ** isn't eaten as two italics.
    m = /^\*\*([\s\S]+?)\*\*/.exec(rest);
    if (m && !/\n/.test(m[1])) { const b = el('strong'); renderInline(m[1], b); parent.appendChild(b); i += m[0].length; continue; }
    m = /^\*([^*\n]+?)\*/.exec(rest);
    if (m) { const it = el('em'); renderInline(m[1], it); parent.appendChild(it); i += m[0].length; continue; }
    // Advance to the next potential special char so we batch plain runs.
    const next = rest.slice(1).search(/[`*\[]/);
    const chunk = next < 0 ? rest : rest.slice(0, next + 1);
    push(chunk);
    i += chunk.length;
  }
}

// Render inline content with single-newline -> <br> behaviour.
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
    // Fenced code block.
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume closing ```
      const code = el('code', { textContent: buf.join('\n') });
      if (fence[1]) code.className = `lang-${fence[1]}`;
      frag.appendChild(el('pre', {}, [code]));
      continue;
    }
    // Blank line separator.
    if (line.trim() === '') { i++; continue; }
    // Headers.
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const tag = `h${h[1].length}`;
      const node = el(tag);
      renderInline(h[2].trim(), node);
      frag.appendChild(node);
      i++;
      continue;
    }
    // Blockquote: consecutive "> " lines joined into one block.
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      const node = el('blockquote');
      renderInlineWithBreaks(buf.join('\n'), node);
      frag.appendChild(node);
      continue;
    }
    // Unordered list.
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
    // Ordered list.
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
    // Paragraph: consume until blank line or block-starting line.
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

function renderComment(c, depth) {
  const d = Math.min(depth, MAX_VISUAL_DEPTH);
  const body = el('div', { className: 'comment-body' });
  body.appendChild(renderMarkdown(c.content));
  const replyBtn = el('button', { className: 'link-btn', type: 'button', textContent: '回复' });
  replyBtn.addEventListener('click', () => toggleReplyForm(node, c));

  const actions = el('div', { className: 'comment-actions' }, [replyBtn]);
  const node = el('div', { className: 'comment' }, [
    metaLine(c.pseudonym, c.created_at),
    body,
    actions,
  ]);
  node.dataset.commentId = c.id;
  node.dataset.pseudonym = c.pseudonym;
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

function renderReactions() {
  const box = $('#reactions');
  box.innerHTML = '';
  if (currentThread == null || !currentReactions) return;
  const t = getToken();
  const mine = new Set(t ? (myReactionsFor(t.pseudonym)[currentThread] || []) : []);
  for (const kind of REACTION_KINDS) {
    const count = currentReactions[kind] || 0;
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
    currentReactions = r.reactions;
    setMyReaction(t.pseudonym, postId, kind, !wasMine);
    renderReactions();
  } catch (err) {
    if (/令牌/.test(err.message)) openDialog();
  }
}

async function openThread(id, { pushUrl = true } = {}) {
  currentThread = id;
  markActivePost(id);
  if (pushUrl) syncUrl(id);
  let data;
  try {
    data = await api('GET', `/api/posts/${id}`);
  } catch (err) {
    renderMissingThread(id, err.message);
    return;
  }
  const { post, comments, reactions } = data;
  currentComments = comments.slice();
  currentPostPseudonym = post.pseudonym;
  currentReactions = reactions || Object.fromEntries(REACTION_KINDS.map((k) => [k, 0]));
  $('#thread-title').innerHTML = '';
  $('#thread-title').append(
    el('span', { className: 'id-badge id-badge--lg', textContent: `#${post.id}` }),
    el('span', { textContent: post.title }),
  );
  $('#thread-meta').dataset.pseudonym = post.pseudonym;
  $('#thread-meta').textContent = fmtMeta(post.pseudonym, post.created_at);
  $('#thread-body').innerHTML = '';
  $('#thread-body').appendChild(renderMarkdown(post.content));
  renderReactions();
  const box = $('#comments');
  box.innerHTML = '';
  if (!comments.length) {
    box.appendChild(el('div', { className: 'empty-comments', textContent: '还没有评论。' }));
  } else {
    renderCommentTree(box, comments);
  }
  $('#comment-err').textContent = '';
  $('#comment-form').reset();
  showReader(VIEW.THREAD);
  readerNode.scrollTo({ top: 0, behavior: 'instant' });
}

function renderMissingThread(id, message) {
  currentComments = [];
  currentPostPseudonym = null;
  currentReactions = null;
  $('#reactions').innerHTML = '';
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
  const id = postIdFromPath();
  if (id == null) {
    currentThread = null;
    markActivePost(null);
    showReader(VIEW.EMPTY);
  } else if (id !== currentThread) {
    openThread(id, { pushUrl: false }).catch(() => {});
  }
});

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
      items = knownPseudonyms()
        .filter((p) => p.startsWith(q))
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

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#token-dialog').hidden) { closeDialog(); return; }
  if (currentView !== VIEW.EMPTY) closeReader();
});

refreshMe();
