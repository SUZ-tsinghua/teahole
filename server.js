const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_HOURS = Number(process.env.TOKEN_TTL_HOURS) || 24;
const MAX_TOKENS_PER_DAY = Number(process.env.MAX_TOKENS_PER_DAY) || 5;
const SESSION_TTL_DAYS = 30;
const ROTATE_INTERVAL_MS = 10 * 60 * 1000;
const FEED_LIMIT = 200;
const PREVIEW_BYTES = 400;

const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: SESSION_TTL_DAYS * 24 * 3600 * 1000,
};

// Dummy bcrypt hash used when a login targets a nonexistent user, so
// response time is dominated by a constant-cost compare rather than
// short-circuiting — mitigates user-enumeration via timing.
const DUMMY_BCRYPT_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8VQZ7Lq9sQ3J/5J3zN1fT4eXaTb4.q';

if (!process.env.JWT_SECRET) {
  console.warn('[warn] JWT_SECRET not set — generated a random one. Sessions will not survive restart.');
}

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const Q = {
  findUserByName: db.prepare('SELECT id, password_hash, is_admin FROM users WHERE username = ?'),
  usernameExists: db.prepare('SELECT 1 FROM users WHERE username = ?'),
  insertUser:     db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  findUserQuota:  db.prepare('SELECT tokens_issued_date, tokens_issued_count FROM users WHERE id = ?'),
  bumpTokenCount: db.prepare('UPDATE users SET tokens_issued_date = ?, tokens_issued_count = ? WHERE id = ?'),
  insertToken:    db.prepare('INSERT INTO post_tokens (token_hash, expires_at) VALUES (?, ?)'),
  findToken:      db.prepare('SELECT expires_at FROM post_tokens WHERE token_hash = ?'),
  purgeTokens:    db.prepare('DELETE FROM post_tokens WHERE expires_at < ?'),
  listPosts:      db.prepare(
    `SELECT id, pseudonym, title,
            substr(content, 1, ${PREVIEW_BYTES}) AS content,
            length(content) > ${PREVIEW_BYTES} AS truncated,
            created_at
     FROM posts ORDER BY created_at DESC LIMIT ${FEED_LIMIT}`
  ),
  getPost:        db.prepare('SELECT id, pseudonym, title, content, created_at FROM posts WHERE id = ?'),
  listComments:   db.prepare('SELECT id, pseudonym, content, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC'),
  insertPost:     db.prepare('INSERT INTO posts (pseudonym, title, content, created_at) VALUES (?, ?, ?, ?)'),
  insertComment:  db.prepare('INSERT INTO comments (post_id, pseudonym, content, created_at) VALUES (?, ?, ?, ?)'),
  deletePost:     db.prepare('DELETE FROM posts WHERE id = ?'),
};

const claimTokenSlotTx = db.transaction((userId, today) => {
  const row = Q.findUserQuota.get(userId);
  if (!row) return { ok: false, reason: '用户不存在' };
  const count = row.tokens_issued_date === today ? row.tokens_issued_count : 0;
  if (count >= MAX_TOKENS_PER_DAY) return { ok: false, reason: '已达到今日令牌上限' };
  Q.bumpTokenCount.run(today, count + 1, userId);
  return { ok: true };
});

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function pseudonymFromHash(h) { return h.slice(0, 8); }
function todayUTC() { return new Date().toISOString().slice(0, 10); }

function requireSession(req, res, next) {
  const raw = req.cookies.session;
  if (!raw) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(raw, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: '会话无效或已过期' }); }
}

function parseId(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: '无效 ID' }); return null; }
  return id;
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return '请求格式错误';
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return '用户名需为 3–32 位字符（仅限 A-Z、a-z、0-9、_）';
  if (password.length < 8 || password.length > 128) return '密码长度需在 8–128 位之间';
  return null;
}

function sanitizeText(s, max) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function issueSession(res, userId, username, isAdmin) {
  const token = jwt.sign({ uid: userId, u: username, a: isAdmin }, JWT_SECRET, {
    expiresIn: `${SESSION_TTL_DAYS}d`,
  });
  res.cookie('session', token, SESSION_COOKIE_OPTS);
}

function resolveToken(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = hashToken(token);
  const row = Q.findToken.get(tokenHash);
  if (!row || row.expires_at < Date.now()) return null;
  return { tokenHash, pseudonym: pseudonymFromHash(tokenHash) };
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  const err = validateCredentials(username, password);
  if (err) return res.status(400).json({ error: err });
  if (Q.usernameExists.get(username)) return res.status(409).json({ error: '用户名已被占用' });

  const hash = await bcrypt.hash(password, 12);
  const info = Q.insertUser.run(username, hash, Date.now());
  issueSession(res, info.lastInsertRowid, username, false);
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '请求格式错误' });
  }
  const row = Q.findUserByName.get(username);
  const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_BCRYPT_HASH);
  if (!row || !ok) return res.status(401).json({ error: '用户名或密码错误' });
  issueSession(res, row.id, username, !!row.is_admin);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session', SESSION_COOKIE_OPTS);
  res.json({ ok: true });
});

app.get('/api/me', requireSession, (req, res) => {
  res.json({ username: req.user.u, admin: !!req.user.a });
});

// The only endpoint that knows who you are. It spends one of your daily
// slots and returns a fresh random token. The server stores only
// sha256(token) + expiry — never a link back to your user id.
app.post('/api/token', requireSession, (req, res) => {
  const claim = claimTokenSlotTx(req.user.uid, todayUTC());
  if (!claim.ok) return res.status(429).json({ error: claim.reason });

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = Date.now() + TOKEN_TTL_HOURS * 3600 * 1000;
  Q.insertToken.run(tokenHash, expiresAt);

  res.json({ token, pseudonym: pseudonymFromHash(tokenHash), expires_at: expiresAt });
});

app.get('/api/posts', requireSession, (req, res) => {
  const rows = Q.listPosts.all().map((r) => ({
    id: r.id,
    pseudonym: r.pseudonym,
    title: r.title,
    content: r.content,
    truncated: !!r.truncated,
    created_at: r.created_at,
  }));
  res.json(rows);
});

app.post('/api/posts', requireSession, (req, res) => {
  const { token, title, content } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const t = sanitizeText(title, 200);
  const c = sanitizeText(content, 10000);
  if (!t || !c) return res.status(400).json({ error: '标题和内容不能为空' });

  const createdAt = Date.now();
  const info = Q.insertPost.run(resolved.pseudonym, t, c, createdAt);
  res.json({
    id: info.lastInsertRowid,
    pseudonym: resolved.pseudonym,
    title: t,
    content: c,
    truncated: false,
    created_at: createdAt,
  });
});

app.get('/api/posts/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const post = Q.getPost.get(id);
  if (!post) return res.status(404).json({ error: '未找到' });
  const comments = Q.listComments.all(id);
  res.json({ post, comments });
});

app.post('/api/posts/:id/comments', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const { token, content } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const c = sanitizeText(content, 5000);
  if (!c) return res.status(400).json({ error: '评论内容不能为空' });

  const createdAt = Date.now();
  try {
    const info = Q.insertComment.run(id, resolved.pseudonym, c, createdAt);
    res.json({
      id: info.lastInsertRowid,
      pseudonym: resolved.pseudonym,
      content: c,
      created_at: createdAt,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return res.status(404).json({ error: '帖子不存在' });
    }
    throw err;
  }
});

// Admin-only moderation. Removes content; does not deanonymize.
app.delete('/api/posts/:id', requireSession, (req, res) => {
  if (!req.user.a) return res.status(403).json({ error: '仅限管理员操作' });
  const id = parseId(req, res); if (id == null) return;
  const info = Q.deletePost.run(id);
  if (info.changes === 0) return res.status(404).json({ error: '未找到' });
  res.json({ ok: true });
});

// Purges expired token hashes. Since plaintext was never stored and no
// user_id was ever attached to a post, this sweep plus the passage of
// today's calendar boundary is what makes old posts truly unlinkable.
function rotate() {
  const info = Q.purgeTokens.run(Date.now());
  if (info.changes > 0) console.log(`[rotate] purged ${info.changes} expired tokens`);
}
setInterval(rotate, ROTATE_INTERVAL_MS).unref();
rotate();

app.listen(PORT, () => {
  console.log(`anonforum listening on http://localhost:${PORT}`);
});
