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
const SEARCH_LIMIT = 50;
const SEARCH_MIN_CHARS = 3;
const MENTIONS_LIMIT = 50;
const RSS_LIMIT = 50;
const MAX_TAGS_PER_POST = 5;
const TAG_RE = /^[a-z0-9_-]{1,24}$/;
const CHANNEL_SLUG_RE = /^[a-z0-9_-]{1,32}$/;
const CHANNEL_NAME_MAX = 60;
const CHANNEL_DESC_MAX = 200;

const SESSION_COOKIE_BASE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
};

const SESSION_COOKIE_OPTS = {
  ...SESSION_COOKIE_BASE_OPTS,
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

// TRUST_PROXY=1 (or a CIDR list) if the server runs behind a reverse proxy
// so req.ip reflects the real client. Off by default.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

// Strict CSP: all scripts/styles/images are same-origin. No inline scripts
// (theme-init.js is a separate file so we don't need 'unsafe-inline').
// frame-ancestors 'none' also covers clickjacking, obsoletes X-Frame-Options.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function qualify(alias, col) {
  return alias ? `${alias}.${col}` : col;
}

function authorKeySql(alias = '') {
  const tokenHash = qualify(alias, 'token_hash');
  return `CASE WHEN ${tokenHash} IS NOT NULL THEN substr(${tokenHash}, 1, 8) END AS author_key`;
}

function postPreviewSql(alias = '') {
  const id = qualify(alias, 'id');
  const pseudonym = qualify(alias, 'pseudonym');
  const title = qualify(alias, 'title');
  const content = qualify(alias, 'content');
  const createdAt = qualify(alias, 'created_at');
  const editedAt = qualify(alias, 'edited_at');
  const channelId = qualify(alias, 'channel_id');
  return `${id}, ${pseudonym},
          ${authorKeySql(alias)},
          ${title},
          substr(${content}, 1, ${PREVIEW_BYTES}) AS content,
          length(${content}) > ${PREVIEW_BYTES} AS truncated,
          ${createdAt}, ${editedAt}, ${channelId}`;
}

const Q = {
  findUserByName:  db.prepare('SELECT id, username, password_hash, is_admin FROM users WHERE username = ? COLLATE NOCASE'),
  usernameExists:  db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE'),
  isUserAdmin:     db.prepare('SELECT is_admin FROM users WHERE id = ?'),
  listAdminHandles: db.prepare('SELECT username FROM users WHERE is_admin = 1 ORDER BY username COLLATE NOCASE ASC'),
  insertUser:      db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  findUserQuota:   db.prepare('SELECT tokens_issued_date, tokens_issued_count FROM users WHERE id = ?'),
  bumpTokenCount:  db.prepare('UPDATE users SET tokens_issued_date = ?, tokens_issued_count = ? WHERE id = ?'),
  insertToken:     db.prepare('INSERT INTO post_tokens (token_hash, expires_at) VALUES (?, ?)'),
  findToken:       db.prepare('SELECT expires_at FROM post_tokens WHERE token_hash = ?'),
  purgeTokens:     db.prepare('DELETE FROM post_tokens WHERE expires_at < ?'),
  purgeMentions:   db.prepare('DELETE FROM mentions WHERE created_at < ?'),
  purgeRevoked:    db.prepare('DELETE FROM revoked_sessions WHERE expires_at < ?'),
  findRevoked:     db.prepare('SELECT 1 FROM revoked_sessions WHERE jti = ?'),
  insertRevoked:   db.prepare('INSERT OR IGNORE INTO revoked_sessions (jti, expires_at) VALUES (?, ?)'),
  // Clear author-edit fingerprints once the token they reference is gone.
  // Otherwise `posts.token_hash` / `comments.token_hash` outlive the purge
  // and become a permanent per-author linker in the DB.
  orphanPostHashes: db.prepare(
    `UPDATE posts SET token_hash = NULL
     WHERE token_hash IS NOT NULL
       AND token_hash NOT IN (SELECT token_hash FROM post_tokens)`
  ),
  orphanCmtHashes: db.prepare(
    `UPDATE comments SET token_hash = NULL
     WHERE token_hash IS NOT NULL
       AND token_hash NOT IN (SELECT token_hash FROM post_tokens)`
  ),
  listPosts:       db.prepare(
    `SELECT ${postPreviewSql()}
     FROM posts WHERE deleted_at IS NULL
     ORDER BY created_at DESC LIMIT ${FEED_LIMIT}`
  ),
  listPostsByTag:  db.prepare(
    `SELECT ${postPreviewSql('p')}
     FROM posts p JOIN post_tags pt ON pt.post_id = p.id
     WHERE pt.tag = ? AND p.deleted_at IS NULL
     ORDER BY p.created_at DESC LIMIT ${FEED_LIMIT}`
  ),
  listPostsByChannel: db.prepare(
    `SELECT ${postPreviewSql()}
     FROM posts WHERE channel_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT ${FEED_LIMIT}`
  ),
  listPostsForRss: db.prepare(
    `SELECT id, pseudonym, title, content, created_at FROM posts
     WHERE deleted_at IS NULL
     ORDER BY created_at DESC LIMIT ${RSS_LIMIT}`
  ),
  getPost:         db.prepare(
    `SELECT id, pseudonym,
            ${authorKeySql()},
            title, content, created_at, edited_at, deleted_at, token_hash, channel_id
     FROM posts WHERE id = ?`
  ),
  listComments:    db.prepare(
    `SELECT id, parent_id, pseudonym,
            ${authorKeySql()},
            content, created_at, edited_at
     FROM comments WHERE post_id = ? ORDER BY created_at ASC`
  ),
  getComment:      db.prepare(
    `SELECT id, post_id, pseudonym,
            ${authorKeySql()},
            content, token_hash
     FROM comments WHERE id = ?`
  ),
  getCommentPost:  db.prepare('SELECT post_id FROM comments WHERE id = ?'),
  insertPost:      db.prepare('INSERT INTO posts (pseudonym, title, content, created_at, token_hash, channel_id) VALUES (?, ?, ?, ?, ?, ?)'),
  insertComment:   db.prepare('INSERT INTO comments (post_id, parent_id, pseudonym, content, created_at, token_hash) VALUES (?, ?, ?, ?, ?, ?)'),
  updateComment:   db.prepare('UPDATE comments SET content = ?, edited_at = ? WHERE id = ? AND token_hash IS NOT NULL AND token_hash = ?'),
  // Post-delete is a tombstone: blank the visible content and set
  // deleted_at, but leave the row so child comments aren't cascade-deleted.
  // token_hash is cleared so the post can't be "resurrected" via edit.
  softDeletePost:  db.prepare(
    `UPDATE posts SET title = '', content = '', deleted_at = ?, token_hash = NULL
     WHERE id = ? AND deleted_at IS NULL`
  ),
  softDeleteOwnPost: db.prepare(
    `UPDATE posts SET title = '', content = '', deleted_at = ?, token_hash = NULL
     WHERE id = ? AND deleted_at IS NULL AND token_hash IS NOT NULL AND token_hash = ?`
  ),
  clearReactionsForPost: db.prepare('DELETE FROM reactions WHERE post_id = ?'),
  deleteComment:   db.prepare('DELETE FROM comments WHERE id = ?'),
  deleteOwnCmt:    db.prepare('DELETE FROM comments WHERE id = ? AND token_hash IS NOT NULL AND token_hash = ?'),
  postExists:      db.prepare('SELECT 1 FROM posts WHERE id = ?'),
  isPostAlive:     db.prepare('SELECT 1 FROM posts WHERE id = ? AND deleted_at IS NULL'),
  findReaction:    db.prepare('SELECT 1 FROM reactions WHERE post_id = ? AND token_hash = ? AND kind = ?'),
  insertReaction:  db.prepare('INSERT INTO reactions (post_id, token_hash, kind, created_at) VALUES (?, ?, ?, ?)'),
  deleteReaction:  db.prepare('DELETE FROM reactions WHERE post_id = ? AND token_hash = ? AND kind = ?'),
  countReactions:  db.prepare('SELECT kind, COUNT(*) AS n FROM reactions WHERE post_id = ? GROUP BY kind'),
  insertPostTag:   db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)'),
  clearPostTags:   db.prepare('DELETE FROM post_tags WHERE post_id = ?'),
  listPostTags:    db.prepare('SELECT tag FROM post_tags WHERE post_id = ? ORDER BY tag ASC'),
  listAllTags:     db.prepare(
    'SELECT tag, COUNT(*) AS n FROM post_tags GROUP BY tag ORDER BY n DESC, tag ASC'
  ),
  insertMention:   db.prepare('INSERT INTO mentions (target_pseudonym, post_id, comment_id, created_at) VALUES (?, ?, ?, ?)'),
  listMentions:    db.prepare(
    `SELECT m.id, m.post_id, m.comment_id, m.created_at,
            p.title AS post_title,
            COALESCE(c.pseudonym, p.pseudonym) AS sender_pseudonym,
            substr(COALESCE(c.content, p.content), 1, 200) AS snippet
     FROM mentions m
     JOIN posts p ON p.id = m.post_id
     LEFT JOIN comments c ON c.id = m.comment_id
     WHERE m.target_pseudonym = ? AND m.created_at > ? AND p.deleted_at IS NULL
     ORDER BY m.created_at DESC LIMIT ${MENTIONS_LIMIT}`
  ),
  searchPosts:     db.prepare(
    `SELECT ${postPreviewSql('p')},
            bm25(posts_fts) AS rank
     FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid
     WHERE posts_fts MATCH ? AND p.deleted_at IS NULL
     ORDER BY rank LIMIT ${SEARCH_LIMIT}`
  ),
  listChannels:    db.prepare(
    `SELECT c.id, c.slug, c.name, c.description, c.created_at,
            (SELECT COUNT(*) FROM posts p WHERE p.channel_id = c.id AND p.deleted_at IS NULL) AS post_count
     FROM channels c ORDER BY c.created_at ASC`
  ),
  getChannelBySlug: db.prepare('SELECT id, slug, name, description FROM channels WHERE slug = ?'),
  getChannelById:   db.prepare('SELECT id, slug, name, description FROM channels WHERE id = ?'),
  insertChannel:    db.prepare('INSERT INTO channels (slug, name, description, created_at) VALUES (?, ?, ?, ?)'),
  deleteChannel:    db.prepare('DELETE FROM channels WHERE id = ?'),
  listBulletins:    db.prepare(
    'SELECT id, author_username, title, content, created_at, updated_at FROM bulletins ORDER BY created_at DESC LIMIT 50'
  ),
  getBulletin:      db.prepare(
    'SELECT id, author_username, title, content, created_at, updated_at FROM bulletins WHERE id = ?'
  ),
  insertBulletin:   db.prepare(
    'INSERT INTO bulletins (author_username, title, content, created_at) VALUES (?, ?, ?, ?)'
  ),
  updateBulletin:   db.prepare(
    'UPDATE bulletins SET title = ?, content = ?, updated_at = ? WHERE id = ?'
  ),
  deleteBulletin:   db.prepare('DELETE FROM bulletins WHERE id = ?'),
};

const REACTION_KINDS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const REACTION_KIND_SET = new Set(REACTION_KINDS);
const PSEUDONYM_RE = /^[a-f0-9]{8}$/;
const MENTION_IN_CONTENT_RE = /@([A-Za-z0-9_]{3,32})/g;

function extractMentionTargets(text) {
  if (typeof text !== 'string') return [];
  const adminHandles = new Map(
    Q.listAdminHandles.all().map((row) => [row.username.toLowerCase(), row.username])
  );
  const set = new Set();
  let m;
  MENTION_IN_CONTENT_RE.lastIndex = 0;
  while ((m = MENTION_IN_CONTENT_RE.exec(text))) {
    const raw = m[1];
    const adminHandle = adminHandles.get(raw.toLowerCase());
    if (adminHandle) {
      set.add(adminHandle);
    } else if (PSEUDONYM_RE.test(raw)) {
      set.add(raw);
    }
  }
  return [...set];
}

function reactionCountsFor(postId) {
  const out = Object.fromEntries(REACTION_KINDS.map((k) => [k, 0]));
  for (const r of Q.countReactions.all(postId)) {
    if (REACTION_KIND_SET.has(r.kind)) out[r.kind] = r.n;
  }
  return out;
}

function tagsFor(postId) {
  return Q.listPostTags.all(postId).map((r) => r.tag);
}

function mapPostPreview(r) {
  return {
    id: r.id,
    pseudonym: r.pseudonym,
    author_key: r.author_key,
    title: r.title,
    content: r.content,
    truncated: !!r.truncated,
    created_at: r.created_at,
    edited_at: r.edited_at,
    channel_id: r.channel_id,
  };
}

// Attach tags to a batch of post rows without N+1. Builds one query per
// call; fine for FEED_LIMIT-sized lists.
function attachTags(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT post_id, tag FROM post_tags WHERE post_id IN (${placeholders}) ORDER BY tag ASC`
  );
  const byId = new Map(ids.map((id) => [id, []]));
  for (const { post_id, tag } of stmt.all(...ids)) byId.get(post_id).push(tag);
  for (const r of rows) r.tags = byId.get(r.id) || [];
  return rows;
}

const toggleReactionTx = db.transaction((postId, tokenHash, kind) => {
  if (Q.findReaction.get(postId, tokenHash, kind)) {
    Q.deleteReaction.run(postId, tokenHash, kind);
  } else {
    Q.insertReaction.run(postId, tokenHash, kind, Date.now());
  }
});

// Admins post non-anonymously under their username, so their rotations
// carry no "lose the old pseudonym" cost — they get unlimited free claims.
const claimTokenSlotTx = db.transaction((userId, today) => {
  const row = Q.findUserQuota.get(userId);
  if (!row) return { ok: false, reason: '用户不存在' };
  if (isLiveAdmin(userId)) return { ok: true, unlimited: true };
  const count = row.tokens_issued_date === today ? row.tokens_issued_count : 0;
  if (count >= MAX_TOKENS_PER_DAY) return { ok: false, reason: '已达到今日令牌上限' };
  Q.bumpTokenCount.run(today, count + 1, userId);
  return { ok: true };
});

function quotaFor(userId) {
  if (isLiveAdmin(userId)) return { remaining: null, max: null, unlimited: true };
  const row = Q.findUserQuota.get(userId);
  const today = todayUTC();
  const used = row && row.tokens_issued_date === today ? row.tokens_issued_count : 0;
  return {
    remaining: Math.max(0, MAX_TOKENS_PER_DAY - used),
    max: MAX_TOKENS_PER_DAY,
    unlimited: false,
  };
}

// Sets tags for a post atomically: replace, then re-insert. Also used by
// create + update flows.
const setPostTagsTx = db.transaction((postId, tags) => {
  Q.clearPostTags.run(postId);
  for (const tag of tags) Q.insertPostTag.run(postId, tag);
});

// Parse @pseudonym mentions out of text and record them against the
// target pseudonym. Idempotent: callers pre-clear before calling on an
// edit (see editPost/editComment paths). Runs inside one transaction.
const recordMentionsTx = db.transaction((targets, postId, commentId, createdAt) => {
  for (const t of targets) Q.insertMention.run(t, postId, commentId, createdAt);
});

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function pseudonymFromHash(h) { return h.slice(0, 8); }
function todayUTC() { return new Date().toISOString().slice(0, 10); }

// Simple in-memory rate limiter keyed by (endpoint, ip). Lazy eviction on
// read plus a periodic sweep bound memory. Not distributed — for multiple
// processes, front with a proxy that rate-limits.
const RATE_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map();

function rateLimit(key, limit, windowMs = RATE_WINDOW_MS) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const k = `${key}:${ip}`;
    const now = Date.now();
    let b = rateBuckets.get(k);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(k, b);
    }
    if (b.count >= limit) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    b.count++;
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (b.resetAt < now) rateBuckets.delete(k);
}, RATE_WINDOW_MS).unref();

function requireSession(req, res, next) {
  const raw = req.cookies.session;
  if (!raw) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(raw, JWT_SECRET);
    if (payload.jti && Q.findRevoked.get(payload.jti)) {
      return res.status(401).json({ error: '会话无效或已过期' });
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: '会话无效或已过期' });
  }
}

// Re-check admin against the users table. The JWT's `a` claim is a cache
// that can go stale for up to SESSION_TTL_DAYS after a demote; gate any
// destructive admin action behind a fresh DB check.
function isLiveAdmin(uid) {
  const row = Q.isUserAdmin.get(uid);
  return !!(row && row.is_admin);
}

function requireAdmin(req, res, next) {
  if (!req.user || !isLiveAdmin(req.user.uid)) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

function parseId(req, res, key = 'id') {
  const id = parseInt(req.params[key], 10);
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

// Tags: accept an optional array of strings. Lowercase, dedupe, cap at
// MAX_TAGS_PER_POST. Returns the cleaned array, or null on a bad shape.
function sanitizeTags(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const t = raw.trim().toLowerCase();
    if (!TAG_RE.test(t)) return null;
    seen.add(t);
    if (seen.size > MAX_TAGS_PER_POST) return null;
  }
  return [...seen];
}

function sanitizeTagParam(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return TAG_RE.test(t) ? t : null;
}

function sanitizeChannelSlug(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return CHANNEL_SLUG_RE.test(s) ? s : null;
}

// null means unclassified (rendered as the default channel client-side).
function resolveChannelInput(raw) {
  if (raw == null) return { ok: true, channelId: null };
  if (!Number.isInteger(raw) || raw <= 0) return { ok: false, error: '无效的频道' };
  const row = Q.getChannelById.get(raw);
  if (!row) return { ok: false, error: '频道不存在' };
  return { ok: true, channelId: row.id };
}

// Strip FTS5 operator syntax so user input is treated as literal tokens.
// The trigram tokenizer requires 3+ chars; shorter queries return nothing.
function sanitizeFtsQuery(q) {
  if (typeof q !== 'string') return null;
  const cleaned = q.replace(/["()*:^~+\\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < SEARCH_MIN_CHARS || cleaned.length > 200) return null;
  return cleaned;
}

function issueSession(res, userId, username, isAdmin) {
  const jti = crypto.randomBytes(12).toString('hex');
  const token = jwt.sign({ uid: userId, u: username, a: isAdmin, jti }, JWT_SECRET, {
    expiresIn: `${SESSION_TTL_DAYS}d`,
  });
  res.cookie('session', token, SESSION_COOKIE_OPTS);
}

function resolveToken(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = hashToken(token);
  const row = Q.findToken.get(tokenHash);
  if (!row || row.expires_at < Date.now()) return null;
  return { tokenHash, authorKey: pseudonymFromHash(tokenHash) };
}

function publicHandleFor(user, authorKey) {
  if (user && isLiveAdmin(user.uid)) return user.u;
  return authorKey;
}

// Recompute the mention pointers for a piece of content. Old mentions for
// this post/comment are cleared first so edits don't leave stale rows.
function recordMentionsForPost(postId, content, createdAt) {
  const targets = extractMentionTargets(content);
  if (targets.length) recordMentionsTx(targets, postId, null, createdAt);
}
function recordMentionsForComment(postId, commentId, content, createdAt) {
  const targets = extractMentionTargets(content);
  if (targets.length) recordMentionsTx(targets, postId, commentId, createdAt);
}
const clearMentionsForPost = db.prepare(
  'DELETE FROM mentions WHERE post_id = ? AND comment_id IS NULL'
);
const clearMentionsForComment = db.prepare(
  'DELETE FROM mentions WHERE comment_id = ?'
);

// Auth

app.post('/api/register', rateLimit('register', 5), async (req, res) => {
  const { username, password } = req.body || {};
  const err = validateCredentials(username, password);
  if (err) return res.status(400).json({ error: err });
  if (Q.usernameExists.get(username)) return res.status(409).json({ error: '用户名已被占用' });

  const hash = await bcrypt.hash(password, 12);
  let info;
  try {
    info = Q.insertUser.run(username, hash, Date.now());
  } catch (e) {
    // Catches the concurrent-register race: two requests passed the
    // usernameExists check and both tried to INSERT; the unique index
    // rejects the second one.
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: '用户名已被占用' });
    }
    throw e;
  }
  issueSession(res, info.lastInsertRowid, username, false);
  res.json({ ok: true });
});

app.post('/api/login', rateLimit('login', 10), async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '请求格式错误' });
  }
  const row = Q.findUserByName.get(username);
  const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_BCRYPT_HASH);
  if (!row || !ok) return res.status(401).json({ error: '用户名或密码错误' });
  // Use the DB's canonical casing, not whatever the client typed.
  issueSession(res, row.id, row.username, !!row.is_admin);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  // Best-effort revoke: if the cookie carries a verifiable JWT with a jti,
  // record it so the same cookie can't be replayed. Ignore decode failures
  // — clearing the cookie is enough for a cooperating client.
  const raw = req.cookies.session;
  if (raw) {
    try {
      const payload = jwt.verify(raw, JWT_SECRET);
      if (payload.jti && payload.exp) {
        Q.insertRevoked.run(payload.jti, payload.exp * 1000);
      }
    } catch {}
  }
  res.clearCookie('session', SESSION_COOKIE_BASE_OPTS);
  res.json({ ok: true });
});

app.get('/api/me', requireSession, (req, res) => {
  const q = quotaFor(req.user.uid);
  const admin = isLiveAdmin(req.user.uid);
  res.json({
    username: req.user.u,
    admin,
    admin_handles: Q.listAdminHandles.all().map((row) => row.username),
    tokens_remaining: q.remaining,
    max_tokens_per_day: q.max,
    unlimited_tokens: !!q.unlimited,
  });
});

// The only endpoint that knows who you are. It spends one of your daily
// slots and returns a fresh random token. The server stores only
// sha256(token) + expiry — never a link back to your user id.
app.post('/api/token', requireSession, (req, res) => {
  const claim = claimTokenSlotTx(req.user.uid, todayUTC());
  if (!claim.ok) return res.status(429).json({ error: claim.reason });

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const authorKey = pseudonymFromHash(tokenHash);
  const expiresAt = Date.now() + TOKEN_TTL_HOURS * 3600 * 1000;
  Q.insertToken.run(tokenHash, expiresAt);

  const q = quotaFor(req.user.uid);
  res.json({
    token,
    pseudonym: authorKey,
    display_name: publicHandleFor(req.user, authorKey),
    expires_at: expiresAt,
    tokens_remaining: q.remaining,
    max_tokens_per_day: q.max,
    unlimited_tokens: !!q.unlimited,
  });
});

// Feed. Supports optional ?tag=xyz or ?channel=<slug> filter (mutually
// exclusive — the client only sets one at a time). Tags are attached in batch.
app.get('/api/posts', requireSession, (req, res) => {
  let rows;
  const tagParam = req.query.tag;
  const chParam = req.query.channel;
  if (tagParam != null) {
    const tag = sanitizeTagParam(tagParam);
    if (!tag) return res.status(400).json({ error: '无效的标签' });
    rows = Q.listPostsByTag.all(tag);
  } else if (chParam != null) {
    const slug = sanitizeChannelSlug(chParam);
    if (!slug) return res.status(400).json({ error: '无效的频道' });
    const ch = Q.getChannelBySlug.get(slug);
    if (!ch) return res.status(404).json({ error: '频道不存在' });
    rows = Q.listPostsByChannel.all(ch.id);
  } else {
    rows = Q.listPosts.all();
  }
  rows = rows.map(mapPostPreview);
  attachTags(rows);
  res.json(rows);
});

app.post('/api/posts', requireSession, (req, res) => {
  const { token, title, content, tags, channel_id } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const publicHandle = publicHandleFor(req.user, resolved.authorKey);
  const t = sanitizeText(title, 200);
  const c = sanitizeText(content, 10000);
  if (!t || !c) return res.status(400).json({ error: '标题和内容不能为空' });
  const cleanTags = sanitizeTags(tags);
  if (cleanTags === null) return res.status(400).json({ error: '标签格式错误（最多 5 个，每个 1–24 位 a-z / 0-9 / - / _）' });
  const ch = resolveChannelInput(channel_id);
  if (!ch.ok) return res.status(400).json({ error: ch.error });

  const createdAt = Date.now();
  const info = Q.insertPost.run(publicHandle, t, c, createdAt, resolved.tokenHash, ch.channelId);
  if (cleanTags.length) setPostTagsTx(info.lastInsertRowid, cleanTags);
  recordMentionsForPost(info.lastInsertRowid, c, createdAt);

  res.json({
    id: info.lastInsertRowid,
    pseudonym: publicHandle,
    author_key: resolved.authorKey,
    title: t,
    content: c,
    truncated: false,
    created_at: createdAt,
    edited_at: null,
    tags: cleanTags,
    channel_id: ch.channelId,
  });
});

app.get('/api/posts/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const post = Q.getPost.get(id);
  if (!post) return res.status(404).json({ error: '未找到' });
  const comments = Q.listComments.all(id);
  // Strip token_hash from the outgoing shape — it's never sent to the client.
  const { token_hash, ...safePost } = post;
  res.json({
    post: safePost,
    comments,
    reactions: reactionCountsFor(id),
    tags: tagsFor(id),
  });
});

app.post('/api/posts/:id/reactions', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const { token, kind } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  if (!REACTION_KIND_SET.has(kind)) return res.status(400).json({ error: '不支持的表情' });
  if (!Q.isPostAlive.get(id)) {
    return res.status(Q.postExists.get(id) ? 410 : 404).json({ error: '帖子已删除或未找到' });
  }
  toggleReactionTx(id, resolved.tokenHash, kind);
  res.json({ reactions: reactionCountsFor(id) });
});

app.post('/api/posts/:id/comments', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const { token, content, parent_id } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const publicHandle = publicHandleFor(req.user, resolved.authorKey);
  const c = sanitizeText(content, 5000);
  if (!c) return res.status(400).json({ error: '评论内容不能为空' });
  if (!Q.isPostAlive.get(id)) {
    return res.status(Q.postExists.get(id) ? 410 : 404).json({ error: '帖子已删除或未找到' });
  }

  let parentId = null;
  if (parent_id != null) {
    if (!Number.isInteger(parent_id)) return res.status(400).json({ error: '无效的父评论' });
    const parent = Q.getCommentPost.get(parent_id);
    if (!parent || parent.post_id !== id) return res.status(400).json({ error: '父评论不属于该帖子' });
    parentId = parent_id;
  }

  const createdAt = Date.now();
  try {
    const info = Q.insertComment.run(id, parentId, publicHandle, c, createdAt, resolved.tokenHash);
    recordMentionsForComment(id, info.lastInsertRowid, c, createdAt);
    res.json({
      id: info.lastInsertRowid,
      parent_id: parentId,
      pseudonym: publicHandle,
      author_key: resolved.authorKey,
      content: c,
      created_at: createdAt,
      edited_at: null,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return res.status(404).json({ error: '帖子不存在' });
    }
    throw err;
  }
});

app.put('/api/posts/:pid/comments/:id', requireSession, (req, res) => {
  const postId = parseId(req, res, 'pid'); if (postId == null) return;
  const id = parseId(req, res); if (id == null) return;
  const { token, content } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const c = sanitizeText(content, 5000);
  if (!c) return res.status(400).json({ error: '评论内容不能为空' });

  const existing = Q.getComment.get(id);
  if (!existing || existing.post_id !== postId) return res.status(404).json({ error: '未找到' });

  const editedAt = Date.now();
  const info = Q.updateComment.run(c, editedAt, id, resolved.tokenHash);
  if (info.changes === 0) return res.status(403).json({ error: '只有作者可以编辑' });

  clearMentionsForComment.run(id);
  recordMentionsForComment(postId, id, c, editedAt);

  res.json({ id, pseudonym: existing.pseudonym, author_key: existing.author_key, content: c, edited_at: editedAt });
});

// Author OR admin can delete. Author uses token; admin uses their session.
// Soft-delete: tombstones the post (blanks title/content, sets deleted_at)
// while leaving the row so child comments aren't cascade-deleted. Tags,
// post-level mentions, and reaction rows are cleared.
function tombstonePost(id) {
  Q.clearPostTags.run(id);
  clearMentionsForPost.run(id);
  Q.clearReactionsForPost.run(id);
}

app.delete('/api/posts/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const { token } = req.body || {};
  const now = Date.now();
  if (isLiveAdmin(req.user.uid)) {
    const info = Q.softDeletePost.run(now, id);
    if (info.changes === 0) {
      return res.status(Q.postExists.get(id) ? 410 : 404).json({ error: '未找到' });
    }
    tombstonePost(id);
    return res.json({ ok: true });
  }
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const info = Q.softDeleteOwnPost.run(now, id, resolved.tokenHash);
  if (info.changes === 0) {
    const existed = Q.postExists.get(id);
    return res.status(existed ? 403 : 404).json({ error: existed ? '只有作者可以删除' : '未找到' });
  }
  tombstonePost(id);
  res.json({ ok: true });
});

app.delete('/api/posts/:pid/comments/:id', requireSession, (req, res) => {
  const postId = parseId(req, res, 'pid'); if (postId == null) return;
  const id = parseId(req, res); if (id == null) return;
  const { token } = req.body || {};
  const existing = Q.getComment.get(id);
  if (!existing || existing.post_id !== postId) return res.status(404).json({ error: '未找到' });
  if (isLiveAdmin(req.user.uid)) {
    Q.deleteComment.run(id);
    return res.json({ ok: true });
  }
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const info = Q.deleteOwnCmt.run(id, resolved.tokenHash);
  if (info.changes === 0) return res.status(403).json({ error: '只有作者可以删除' });
  res.json({ ok: true });
});

// Tags list. Used for the sidebar tag chips.
app.get('/api/tags', requireSession, (req, res) => {
  res.json(Q.listAllTags.all());
});

// Channels list with live post counts. Any logged-in user can read.
app.get('/api/channels', requireSession, (req, res) => {
  res.json(Q.listChannels.all());
});

// Channel creation carries no user_id, so this endpoint is privacy-neutral
// with respect to posts — the admin gate is just curation, not deanonymization.
app.post('/api/channels', requireSession, requireAdmin, (req, res) => {
  const { slug, name, description } = req.body || {};
  const cleanSlug = sanitizeChannelSlug(slug);
  if (!cleanSlug) return res.status(400).json({ error: 'slug 格式错误（1–32 位 a-z / 0-9 / - / _）' });
  const cleanName = sanitizeText(name, CHANNEL_NAME_MAX);
  if (!cleanName) return res.status(400).json({ error: '频道名称不能为空' });
  let cleanDesc = null;
  if (description != null && description !== '') {
    cleanDesc = sanitizeText(description, CHANNEL_DESC_MAX);
    if (!cleanDesc) return res.status(400).json({ error: `频道描述过长（上限 ${CHANNEL_DESC_MAX}）` });
  }
  try {
    const info = Q.insertChannel.run(cleanSlug, cleanName, cleanDesc, Date.now());
    res.json({
      id: info.lastInsertRowid,
      slug: cleanSlug,
      name: cleanName,
      description: cleanDesc,
      post_count: 0,
    });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'slug 已被占用' });
    }
    throw e;
  }
});

app.delete('/api/channels/:id', requireSession, requireAdmin, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const info = Q.deleteChannel.run(id);
  if (info.changes === 0) return res.status(404).json({ error: '频道不存在' });
  res.json({ ok: true });
});

// Bulletins: admin-curated notices. Any logged-in user can read; only
// live admins can create/edit/delete. Kept separate from `posts` so the
// anonymous-post privacy rules don't have to be reasoned about here.
app.get('/api/bulletins', requireSession, (req, res) => {
  res.json(Q.listBulletins.all());
});

app.get('/api/bulletins/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const row = Q.getBulletin.get(id);
  if (!row) return res.status(404).json({ error: '未找到' });
  res.json(row);
});

app.post('/api/bulletins', requireSession, requireAdmin, (req, res) => {
  const { title, content } = req.body || {};
  const t = sanitizeText(title, 200);
  const c = sanitizeText(content, 10000);
  if (!t || !c) return res.status(400).json({ error: '标题和内容不能为空' });
  const createdAt = Date.now();
  const info = Q.insertBulletin.run(req.user.u, t, c, createdAt);
  res.json({
    id: info.lastInsertRowid,
    author_username: req.user.u,
    title: t, content: c, created_at: createdAt, updated_at: null,
  });
});

app.put('/api/bulletins/:id', requireSession, requireAdmin, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const { title, content } = req.body || {};
  const t = sanitizeText(title, 200);
  const c = sanitizeText(content, 10000);
  if (!t || !c) return res.status(400).json({ error: '标题和内容不能为空' });
  const updatedAt = Date.now();
  const info = Q.updateBulletin.run(t, c, updatedAt, id);
  if (info.changes === 0) return res.status(404).json({ error: '未找到' });
  const row = Q.getBulletin.get(id);
  res.json(row);
});

app.delete('/api/bulletins/:id', requireSession, requireAdmin, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const info = Q.deleteBulletin.run(id);
  if (info.changes === 0) return res.status(404).json({ error: '未找到' });
  res.json({ ok: true });
});

// FTS5 search over post title+content. Trigram tokenizer = minimum 3 chars.
app.get('/api/search', requireSession, (req, res) => {
  const q = sanitizeFtsQuery(req.query.q);
  if (!q) {
    return res.status(400).json({
      error: `搜索词需为 ${SEARCH_MIN_CHARS} 位及以上`,
    });
  }
  const rows = Q.searchPosts.all(q).map(mapPostPreview);
  attachTags(rows);
  res.json(rows);
});

// @mention inbox for either the current token's pseudonym or, for admins,
// their public username. Rows still age out after TOKEN_TTL_HOURS.
app.post('/api/mentions', requireSession, (req, res) => {
  const { token } = req.body || {};
  const target = isLiveAdmin(req.user.uid)
    ? req.user.u
    : (() => {
        const resolved = resolveToken(token);
        return resolved && resolved.authorKey;
      })();
  if (!target) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const cutoff = Date.now() - TOKEN_TTL_HOURS * 3600 * 1000;
  const rows = Q.listMentions.all(target, cutoff);
  res.json({ mentions: rows, now: Date.now() });
});

// Session-gated RSS. Same content for every logged-in user — no per-user
// tailoring, no link back to who fetched it.
app.get('/api/feed.xml', requireSession, (req, res) => {
  const rows = Q.listPostsForRss.all();
  const host = req.get('host') || `localhost:${PORT}`;
  const proto = req.protocol || 'http';
  const base = `${proto}://${host}`;
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  const items = rows.map((r) => {
    const link = `${base}/p/${r.id}`;
    const snippet = r.content.length > 400 ? r.content.slice(0, 400) + '…' : r.content;
    return `
    <item>
      <title>${esc(r.title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="true">${esc(link)}</guid>
      <pubDate>${new Date(r.created_at).toUTCString()}</pubDate>
      <author>${esc(r.pseudonym)}@anonforum</author>
      <description>${esc(snippet)}</description>
    </item>`;
  }).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>匿名论坛</title>
    <link>${esc(base)}/</link>
    <description>Login-gated but unlinkable discussion platform</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>`;
  res.type('application/rss+xml; charset=utf-8').send(xml);
});

// Deep-link routes. We serve the SPA shell for any /p/<id> — the client
// fetches /api/posts/:id and renders a "not found" state if needed, so
// this handler does not leak whether `id` exists.
app.get('/p/:id(\\d+)', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Bulletins are admin-authored + public by design, but the same
// existence-oblivious rule applies so deep-link probes can't learn a
// bulletin's status before login.
app.get('/b/:id(\\d+)', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Purges expired token hashes, orphan author-edit fingerprints on posts
// and comments, and stale mention pointers. Nothing here is keyed by
// user_id, so this sweep plus the calendar boundary is what makes old
// posts truly unlinkable.
function rotate() {
  const now = Date.now();
  const mentionCutoff = now - TOKEN_TTL_HOURS * 3600 * 1000;
  const t = Q.purgeTokens.run(now);
  const ph = Q.orphanPostHashes.run();
  const ch = Q.orphanCmtHashes.run();
  const m = Q.purgeMentions.run(mentionCutoff);
  const r = Q.purgeRevoked.run(now);
  if (t.changes + m.changes + ph.changes + ch.changes + r.changes > 0) {
    console.log(
      `[rotate] purged ${t.changes} tokens, ${m.changes} mentions, ` +
      `${r.changes} revoked sessions, ` +
      `orphaned ${ph.changes} post / ${ch.changes} comment hashes`
    );
  }
}
setInterval(rotate, ROTATE_INTERVAL_MS).unref();
rotate();

app.listen(PORT, () => {
  console.log(`anonforum listening on http://localhost:${PORT}`);
});
