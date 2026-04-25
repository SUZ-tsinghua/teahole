// ────────────────────────────────────────────────────────────────────────────
// FILE MAP — grep "SECTION:" to jump. Keep in sync when adding large blocks.
//
//   SECTION: config            env vars, limits, session-cookie options
//   SECTION: mail+allowlist    SMTP transport + dept allowlist reload
//   SECTION: express-setup     CSP, middleware, static, /healthz
//   SECTION: sql-helpers       qualify / authorKeySql / postPreviewSql
//   SECTION: Q                 all prepared statements (add queries HERE)
//   SECTION: derivations       reactionCountsFor, mapPostPreview, quotaFor
//   SECTION: auth-helpers      rateLimit, requireSession, requireAdmin
//   SECTION: validation        sanitizeText, parseEmail, validatePassword
//   SECTION: token-core        resolveToken — single path from token→pseudonym
//   SECTION: routes:auth       /api/send-code /register /login /logout /me
//   SECTION: routes:token      /api/token (mint posting token + quota)
//   SECTION: routes:posts      CRUD, reactions, comments, poll votes
//   SECTION: routes:uploads    image upload + serve
//   SECTION: routes:saved      saved-posts + saved-docs
//   SECTION: routes:channels   channel admin + per-user prefs
//   SECTION: routes:bulletins  bulletin CRUD
//   SECTION: routes:docs       shared-doc CRUD (wiki-style)
//   SECTION: routes:search     /api/search (FTS5)
//   SECTION: routes:mentions   /api/mentions + /api/feed.xml
//   SECTION: routes:spa        /p/:id /b/:id /d/:id deep-link catchalls
//   SECTION: rotate+listen     10-min token sweep + app.listen
// ────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const db = require('./db');

// SECTION: config

const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DEPT_ALLOWLIST_FILE =
  process.env.DEPT_ALLOWLIST_FILE || path.join(DATA_DIR, 'dept-allowlist.txt');

// SECTION: mail+allowlist
// With no GMAIL_USER / GMAIL_APP_PASSWORD we log the code instead of sending
// — keeps the local dev flow unblocked without a real mail account.
let mailTransport = null;
function getMailTransport() {
  if (mailTransport) return mailTransport;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  const nodemailer = require('nodemailer');
  mailTransport = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return mailTransport;
}

// Allowlist stores sha256(email) rather than raw emails so a process or
// disk dump doesn't hand over the roster. `/api/send-code` always replies
// ok:true regardless of allowlist outcome, so attackers can't enumerate
// the list by probing.
function loadAllowlist(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hashes = new Set();
  for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim().toLowerCase();
    if (!line) continue;
    hashes.add(hashToken(line));
  }
  return hashes;
}

let allowedEmailHashes = null;

// Fail-closed: no allowlist file = no one can register. The roster is
// the single gate; there is no domain fallback.
function isAllowedEmail(email) {
  if (allowedEmailHashes === null) return false;
  return allowedEmailHashes.has(hashToken(email));
}

// Login-time variant: lets a member who's rotated to a new address
// (graduation, alumni redirect…) keep access via a former allowlisted
// email even after the new one isn't on the roster. Q.* are bound by
// the time any request handler calls this.
function userHasAllowlistedEmail(uid) {
  if (allowedEmailHashes === null) return false;
  const cur = Q.getUserEmail.get(uid);
  if (cur && allowedEmailHashes.has(hashToken(cur.username))) return true;
  for (const row of Q.listUserEmailHistory.all(uid)) {
    if (allowedEmailHashes.has(hashToken(row.email))) return true;
  }
  return false;
}

async function sendVerificationEmail(to, code) {
  const transport = getMailTransport();
  if (!transport) {
    console.log(`[send-code] GMAIL_USER not set — dev code for ${to}: ${code}`);
    return;
  }
  const from = process.env.GMAIL_FROM || `茶园树洞 <${process.env.GMAIL_USER}>`;
  await transport.sendMail({
    from,
    to,
    subject: '茶园树洞 · 注册验证码',
    text:
      `你的验证码是 ${code}，10 分钟内有效。\n\n` +
      `如果不是你本人发起，请忽略这封邮件。`,
  });
}

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_HOURS = Number(process.env.TOKEN_TTL_HOURS) || 24;
const MAX_TOKENS_PER_DAY = Number(process.env.MAX_TOKENS_PER_DAY) || 5;
const SESSION_TTL_DAYS = 30;
const ROTATE_INTERVAL_MS = 10 * 60 * 1000;
const ACTIVE_USER_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_STATS_CACHE_MS = 5 * 60 * 1000;
const FEED_LIMIT = 200;
const PREVIEW_BYTES = 400;
const SEARCH_LIMIT = 50;
const SEARCH_MIN_CHARS = 3;
const MENTIONS_LIMIT = 50;
const RSS_LIMIT = 50;
const POLL_QUESTION_MAX = 200;
const POLL_OPTION_MAX = 80;
const POLL_OPTIONS_MIN = 2;
const POLL_OPTIONS_MAX = 10;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const UPLOAD_EXT_FOR_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const UPLOAD_NAME_RE = /^[a-f0-9]{64}\.(jpg|png|webp)$/;
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});
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

function reloadAllowlist(reason) {
  try {
    const next = loadAllowlist(DEPT_ALLOWLIST_FILE);
    allowedEmailHashes = next;
    if (next === null) {
      console.warn(`[allowlist] ${reason}: file missing — registration disabled until it exists.`);
    } else {
      console.log(`[allowlist] ${reason}: loaded ${next.size} entries from ${DEPT_ALLOWLIST_FILE}`);
    }
  } catch (e) {
    console.error(`[allowlist] ${reason}: reload failed (${e.message}); keeping previous roster.`);
  }
}

reloadAllowlist('startup');

// Watch the allowlist file so edits take effect without a restart.
// fs.watchFile polls via stat() — less efficient than fs.watch but
// survives atomic-save editors (vim, gofmt, etc.) that rename the file.
fs.watchFile(DEPT_ALLOWLIST_FILE, { interval: 2000 }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs && curr.ino === prev.ino) return;
  reloadAllowlist('watch');
});

// SECTION: express-setup
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

// Cheap liveness probe for fly's health check — intentionally does not
// touch the DB, so a stuck SQLite write doesn't cause rolling restarts.
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

// SECTION: sql-helpers
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
  const deletedAt = qualify(alias, 'deleted_at');
  const channelId = qualify(alias, 'channel_id');
  return `${id}, ${pseudonym},
          ${authorKeySql(alias)},
          ${title},
          substr(${content}, 1, ${PREVIEW_BYTES}) AS content,
          length(${content}) > ${PREVIEW_BYTES} AS truncated,
          ${createdAt}, ${editedAt}, ${deletedAt}, ${channelId}`;
}

// SECTION: Q — prepared statements. Add new queries here, never inline.
const Q = {
  findUserByName:  db.prepare('SELECT id, username, password_hash, is_admin, display_name FROM users WHERE username = ? COLLATE NOCASE'),
  usernameExists:  db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE'),
  isUserAdmin:     db.prepare('SELECT is_admin FROM users WHERE id = ?'),
  // Admin "handles" are their display_name (Admin01…); regular users have
  // no public handle by design. Sorted so mention autocomplete is stable.
  listAdminHandles: db.prepare(
    `SELECT display_name FROM users
     WHERE is_admin = 1 AND display_name IS NOT NULL
     ORDER BY display_name COLLATE NOCASE ASC`
  ),
  insertUser:      db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  countUsers:      db.prepare('SELECT COUNT(*) AS n FROM users'),
  findUserById:    db.prepare('SELECT id, password_hash FROM users WHERE id = ?'),
  getUserPwVersion: db.prepare('SELECT pw_version FROM users WHERE id = ?'),
  // Bumping pw_version invalidates every JWT issued before this update;
  // see requireSession's pv check.
  updateUserPassword: db.prepare('UPDATE users SET password_hash = ?, pw_version = pw_version + 1 WHERE id = ?'),
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
     FROM posts
     ORDER BY created_at DESC LIMIT ${FEED_LIMIT}`
  ),
  listPostsByChannel: db.prepare(
    `SELECT ${postPreviewSql()}
     FROM posts WHERE channel_id = ?
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
  findCommentReaction:    db.prepare('SELECT 1 FROM comment_reactions WHERE comment_id = ? AND token_hash = ? AND kind = ?'),
  insertCommentReaction:  db.prepare('INSERT INTO comment_reactions (comment_id, token_hash, kind, created_at) VALUES (?, ?, ?, ?)'),
  deleteCommentReaction:  db.prepare('DELETE FROM comment_reactions WHERE comment_id = ? AND token_hash = ? AND kind = ?'),
  countCommentReactions:  db.prepare('SELECT kind, COUNT(*) AS n FROM comment_reactions WHERE comment_id = ? GROUP BY kind'),
  getCommentForReaction:  db.prepare('SELECT post_id FROM comments WHERE id = ?'),
  countCommentsForPost: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?'),
  insertPoll:      db.prepare('INSERT INTO polls (post_id, question, created_at) VALUES (?, ?, ?)'),
  insertPollOption: db.prepare('INSERT INTO poll_options (poll_id, position, label) VALUES (?, ?, ?)'),
  getPollByPost:   db.prepare('SELECT id, question FROM polls WHERE post_id = ?'),
  listPollOptions: db.prepare('SELECT id, position, label, votes_total FROM poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC'),
  findPollVote:    db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND token_hash = ?'),
  optionInPoll:    db.prepare('SELECT 1 FROM poll_options WHERE id = ? AND poll_id = ?'),
  insertPollVote:  db.prepare('INSERT INTO poll_votes (poll_id, token_hash, option_id, created_at) VALUES (?, ?, ?, ?)'),
  bumpPollOptionTotal: db.prepare('UPDATE poll_options SET votes_total = votes_total + 1 WHERE id = ?'),
  deletePollForPost: db.prepare('DELETE FROM polls WHERE post_id = ?'),
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
  // Union of posts whose title/content matches and posts that have a
  // comment matching. Each row carries both an in_post and in_comment
  // flag so the client can mark the hit. ranked by best-of (lower bm25 = better);
  // in-post hits are weighted slightly stronger so they outrank
  // identical-score in-comment hits.
  // Two separate FTS prepared statements; the union is built in JS.
  // bm25() must be called in the same SELECT that has the MATCH clause —
  // wrapping in a CTE with an aggregate breaks the rank context.
  searchPostsByPost: db.prepare(
    `SELECT p.id, bm25(posts_fts) * 0.9 AS rank
     FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid
     WHERE posts_fts MATCH ? AND p.deleted_at IS NULL
     ORDER BY rank LIMIT ${SEARCH_LIMIT * 2}`
  ),
  searchPostsByComment: db.prepare(
    `SELECT c.post_id AS id, bm25(comments_fts) AS rank
     FROM comments_fts JOIN comments c ON c.id = comments_fts.rowid
     JOIN posts p ON p.id = c.post_id
     WHERE comments_fts MATCH ? AND p.deleted_at IS NULL
     ORDER BY rank LIMIT ${SEARCH_LIMIT * 2}`
  ),
  // Short-query fallbacks — mirror docs' instr() approach. Ranked by
  // recency since FTS rank isn't available. lower()ed on both sides so
  // ASCII is case-insensitive without affecting CJK (lower() is a no-op
  // on non-ASCII in SQLite by default).
  searchPostsLike: db.prepare(
    `SELECT id FROM posts
     WHERE deleted_at IS NULL
       AND (instr(lower(title), lower(?)) > 0
         OR instr(lower(content), lower(?)) > 0)
     ORDER BY created_at DESC LIMIT ${SEARCH_LIMIT * 2}`
  ),
  searchPostsByCommentLike: db.prepare(
    `SELECT DISTINCT c.post_id AS id FROM comments c
     JOIN posts p ON p.id = c.post_id
     WHERE p.deleted_at IS NULL AND instr(lower(c.content), lower(?)) > 0
     ORDER BY p.created_at DESC LIMIT ${SEARCH_LIMIT * 2}`
  ),
  listChannels:    db.prepare(
    `SELECT c.id, c.slug, c.name, c.description, c.created_at,
            (SELECT COUNT(*) FROM posts p WHERE p.channel_id = c.id) AS post_count
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
  insertSaved:        db.prepare('INSERT OR IGNORE INTO saved_posts (user_id, post_id, created_at) VALUES (?, ?, ?)'),
  deleteSaved:        db.prepare('DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?'),
  listSavedIds:       db.prepare('SELECT post_id FROM saved_posts WHERE user_id = ? ORDER BY created_at DESC'),
  countSavedForPost:  db.prepare('SELECT COUNT(*) AS n FROM saved_posts WHERE post_id = ?'),
  listSavedPosts:   db.prepare(
    `SELECT ${postPreviewSql('p')}
     FROM saved_posts s JOIN posts p ON p.id = s.post_id
     WHERE s.user_id = ? AND p.deleted_at IS NULL
     ORDER BY s.created_at DESC LIMIT ${FEED_LIMIT}`
  ),
  listChannelPrefs: db.prepare(
    'SELECT channel_id, pinned, muted, last_seen_at FROM user_channel_prefs WHERE user_id = ?'
  ),
  upsertChannelPref: db.prepare(
    `INSERT INTO user_channel_prefs (user_id, channel_id, pinned, muted)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET pinned = excluded.pinned, muted = excluded.muted`
  ),
  markChannelSeen: db.prepare(
    `INSERT INTO user_channel_prefs (user_id, channel_id, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  ),
  deleteChannelPref: db.prepare(
    'DELETE FROM user_channel_prefs WHERE user_id = ? AND channel_id = ?'
  ),
  channelUnreadCounts: db.prepare(
    `SELECT c.id AS channel_id,
       (SELECT COUNT(*) FROM posts p
        WHERE p.channel_id = c.id AND p.deleted_at IS NULL
          AND p.created_at > COALESCE(pref.last_seen_at, 0)) AS unread
     FROM channels c
     LEFT JOIN user_channel_prefs pref
       ON pref.channel_id = c.id AND pref.user_id = ?`
  ),
  // Shared docs. Wiki-style: created_token_hash gates delete-by-creator
//  only, never edit — any valid posting token can edit. rotate() nulls
//  out the hash once the token expires, matching the post tombstone flow.
  listDocs:         db.prepare(
    `SELECT id, channel_id, title, created_pseudonym, last_editor_pseudonym,
            created_at, updated_at
     FROM docs ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ${FEED_LIMIT}`
  ),
  listDocsByChannel: db.prepare(
    `SELECT id, channel_id, title, created_pseudonym, last_editor_pseudonym,
            created_at, updated_at
     FROM docs WHERE channel_id = ?
     ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ${FEED_LIMIT}`
  ),
  getDoc:           db.prepare(
    `SELECT id, channel_id, title, content, created_pseudonym,
            last_editor_pseudonym, created_token_hash, created_at, updated_at
     FROM docs WHERE id = ?`
  ),
  insertDoc:        db.prepare(
    `INSERT INTO docs (channel_id, title, content, created_pseudonym,
                       last_editor_pseudonym, created_token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  // Optimistic lock: caller passes the version they based their edit on
//  (COALESCE(updated_at, created_at) at fetch time). If another write
//  has happened since, the WHERE fails and we return 409 upstream.
  updateDoc:        db.prepare(
    `UPDATE docs SET title = ?, content = ?, last_editor_pseudonym = ?, updated_at = ?
     WHERE id = ? AND COALESCE(updated_at, created_at) = ?`
  ),
  deleteDoc:        db.prepare('DELETE FROM docs WHERE id = ?'),
  deleteOwnDoc:     db.prepare(
    'DELETE FROM docs WHERE id = ? AND created_token_hash IS NOT NULL AND created_token_hash = ?'
  ),
  orphanDocHashes:  db.prepare(
    `UPDATE docs SET created_token_hash = NULL
     WHERE created_token_hash IS NOT NULL
       AND created_token_hash NOT IN (SELECT token_hash FROM post_tokens)`
  ),
  docExists:        db.prepare('SELECT 1 FROM docs WHERE id = ?'),
  searchDocs:       db.prepare(
    `SELECT d.id, d.channel_id, d.title, d.created_pseudonym, d.last_editor_pseudonym,
            d.created_at, d.updated_at, bm25(docs_fts) AS rank
     FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
     WHERE docs_fts MATCH ?
     ORDER BY rank LIMIT ${SEARCH_LIMIT}`
  ),
  // Short queries (<3 chars) can't produce trigrams, so FTS returns
  // nothing for common 2-char CJK terms like "面试". Fall back to a
  // literal substring scan — lower()ed on both sides to make ASCII
  // case-insensitive (SQLite's lower() is a no-op on CJK).
  searchDocsLike:   db.prepare(
    `SELECT id, channel_id, title, created_pseudonym, last_editor_pseudonym,
            created_at, updated_at
     FROM docs
     WHERE instr(lower(title), lower(?)) > 0
        OR instr(lower(content), lower(?)) > 0
     ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ${SEARCH_LIMIT}`
  ),
  insertSavedDoc:   db.prepare('INSERT OR IGNORE INTO saved_docs (user_id, doc_id, created_at) VALUES (?, ?, ?)'),
  deleteSavedDoc:   db.prepare('DELETE FROM saved_docs WHERE user_id = ? AND doc_id = ?'),
  listSavedDocIds:  db.prepare('SELECT doc_id FROM saved_docs WHERE user_id = ? ORDER BY created_at DESC'),
  countSavedDocsForDoc: db.prepare('SELECT COUNT(*) AS n FROM saved_docs WHERE doc_id = ?'),
  listSavedDocs:    db.prepare(
    `SELECT d.id, d.channel_id, d.title, d.created_pseudonym, d.last_editor_pseudonym,
            d.created_at, d.updated_at
     FROM saved_docs s JOIN docs d ON d.id = s.doc_id
     WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT ${FEED_LIMIT}`
  ),
  getUserEmail:    db.prepare('SELECT username FROM users WHERE id = ?'),
  listUserEmailHistory: db.prepare(
    'SELECT email FROM user_email_history WHERE user_id = ?'
  ),
  insertUserEmailHistory: db.prepare(
    `INSERT OR IGNORE INTO user_email_history (user_id, email, replaced_at)
     VALUES (?, ?, ?)`
  ),
  deleteUserEmailHistoryFor: db.prepare(
    'DELETE FROM user_email_history WHERE user_id = ? AND email = ?'
  ),
  updateUserEmail: db.prepare(
    `UPDATE users SET username = ?, pw_version = pw_version + 1 WHERE id = ?`
  ),
  findEmailCode:   db.prepare('SELECT code_hash, expires_at, attempts, created_at FROM email_codes WHERE email = ?'),
  upsertEmailCode: db.prepare(
    `INSERT INTO email_codes (email, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET
       code_hash = excluded.code_hash,
       expires_at = excluded.expires_at,
       attempts = 0,
       created_at = excluded.created_at`
  ),
  bumpEmailCodeAttempts: db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?'),
  deleteEmailCode: db.prepare('DELETE FROM email_codes WHERE email = ?'),
  purgeEmailCodes: db.prepare('DELETE FROM email_codes WHERE expires_at < ?'),
};

// SECTION: derivations
const REACTION_KINDS = ['👍', '👎'];
const REACTION_KIND_SET = new Set(REACTION_KINDS);
const PSEUDONYM_RE = /^[a-f0-9]{8}$/;
const MENTION_IN_CONTENT_RE = /@([A-Za-z0-9_]{3,32})/g;

function extractMentionTargets(text) {
  if (typeof text !== 'string') return [];
  const adminHandles = new Map(
    Q.listAdminHandles.all().map((row) => [row.display_name.toLowerCase(), row.display_name])
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
    deleted_at: r.deleted_at,
    channel_id: r.channel_id,
  };
}

// Annotates a list of post-preview rows with `reactions` (kind→count) and
// `comment_count`. Uses two batch queries instead of 2×N per-post queries.
// Dynamic IN-list requires inline db.prepare rather than a Q entry.
function annotatePostStats(previews) {
  if (!previews.length) return previews;
  const ids = previews.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const reactionRows = db.prepare(
    `SELECT post_id, kind, COUNT(*) AS n FROM reactions WHERE post_id IN (${ph}) GROUP BY post_id, kind`
  ).all(...ids);
  const commentRows = db.prepare(
    `SELECT post_id, COUNT(*) AS n FROM comments WHERE post_id IN (${ph}) GROUP BY post_id`
  ).all(...ids);
  const reactionMap = {};
  for (const r of reactionRows) {
    if (!reactionMap[r.post_id]) reactionMap[r.post_id] = {};
    if (REACTION_KIND_SET.has(r.kind)) reactionMap[r.post_id][r.kind] = r.n;
  }
  const commentMap = {};
  for (const r of commentRows) commentMap[r.post_id] = r.n;
  for (const p of previews) {
    const out = Object.fromEntries(REACTION_KINDS.map((k) => [k, 0]));
    Object.assign(out, reactionMap[p.id] || {});
    p.reactions = out;
    p.comment_count = commentMap[p.id] || 0;
  }
  return previews;
}

const toggleReactionTx = db.transaction((postId, tokenHash, kind) => {
  if (Q.findReaction.get(postId, tokenHash, kind)) {
    Q.deleteReaction.run(postId, tokenHash, kind);
  } else {
    Q.insertReaction.run(postId, tokenHash, kind, Date.now());
  }
});

const toggleCommentReactionTx = db.transaction((commentId, tokenHash, kind) => {
  if (Q.findCommentReaction.get(commentId, tokenHash, kind)) {
    Q.deleteCommentReaction.run(commentId, tokenHash, kind);
  } else {
    Q.insertCommentReaction.run(commentId, tokenHash, kind, Date.now());
  }
});

function commentReactionCountsFor(commentId) {
  const out = Object.fromEntries(REACTION_KINDS.map((k) => [k, 0]));
  for (const r of Q.countCommentReactions.all(commentId)) {
    if (REACTION_KIND_SET.has(r.kind)) out[r.kind] = r.n;
  }
  return out;
}

// Mutates each comment row to add a `reactions` map. One batch query
// instead of 1×N — cost is fixed regardless of comment count.
function annotateCommentReactions(comments) {
  if (!comments.length) return comments;
  const ids = comments.map((c) => c.id);
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT comment_id, kind, COUNT(*) AS n FROM comment_reactions
       WHERE comment_id IN (${ph}) GROUP BY comment_id, kind`
  ).all(...ids);
  const byId = {};
  for (const r of rows) {
    if (!byId[r.comment_id]) byId[r.comment_id] = {};
    if (REACTION_KIND_SET.has(r.kind)) byId[r.comment_id][r.kind] = r.n;
  }
  for (const c of comments) {
    const out = Object.fromEntries(REACTION_KINDS.map((k) => [k, 0]));
    Object.assign(out, byId[c.id] || {});
    c.reactions = out;
  }
  return comments;
}

function parsePollInput(poll) {
  if (poll == null) return { ok: true, poll: null };
  if (typeof poll !== 'object') return { ok: false, error: '投票格式错误' };
  const question = sanitizeText(poll.question, POLL_QUESTION_MAX);
  if (!question) return { ok: false, error: '投票问题不能为空' };
  if (!Array.isArray(poll.options)) return { ok: false, error: '投票选项格式错误' };
  const seen = new Set();
  const options = [];
  for (const raw of poll.options) {
    const label = sanitizeText(raw, POLL_OPTION_MAX);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    options.push(label);
    if (options.length > POLL_OPTIONS_MAX) break;
  }
  if (options.length < POLL_OPTIONS_MIN) {
    return { ok: false, error: `投票至少需要 ${POLL_OPTIONS_MIN} 个不重复选项` };
  }
  return { ok: true, poll: { question, options } };
}

// Counts/total/my_option_id are filled ONLY when the caller's token already
// has a vote row recorded — that's the single privacy gate. tokenHash may
// be null for anonymous reads. Aggregate counts come from the durable
// poll_options.votes_total counter so totals survive token expiry; the
// per-row poll_votes table still cascades on token purge to preserve the
// "no path back to a current account" property.
function pollViewFor(postId, tokenHash) {
  const poll = Q.getPollByPost.get(postId);
  if (!poll) return null;
  const rows = Q.listPollOptions.all(poll.id);
  const options = rows.map((o) => ({ id: o.id, position: o.position, label: o.label }));
  const base = { id: poll.id, question: poll.question, options };
  if (!tokenHash) return { ...base, voted: false };
  const my = Q.findPollVote.get(poll.id, tokenHash);
  if (!my) return { ...base, voted: false };
  const total = rows.reduce((sum, r) => sum + r.votes_total, 0);
  return {
    ...base,
    voted: true,
    my_option_id: my.option_id,
    total,
    counts: rows.map((r) => ({ option_id: r.id, votes: r.votes_total })),
  };
}

// Concurrent submits from the same token would otherwise race past the
// findPollVote check and trip the PK constraint with a 500. The counter
// bump lives inside the same transaction so totals can never get ahead of
// the row count.
const castVoteTx = db.transaction((pollId, tokenHash, optionId) => {
  if (Q.findPollVote.get(pollId, tokenHash)) return false;
  Q.insertPollVote.run(pollId, tokenHash, optionId, Date.now());
  Q.bumpPollOptionTotal.run(optionId);
  return true;
});

// Atomic post creation: the post row, its mention pointers, and (if
// requested) its poll all commit together or not at all. Otherwise a poll
// insert failure would leave a live post without its requested poll.
const createPostTx = db.transaction((publicHandle, title, content, createdAt, tokenHash, channelId, mentionTargets, poll) => {
  const info = Q.insertPost.run(publicHandle, title, content, createdAt, tokenHash, channelId);
  const postId = info.lastInsertRowid;
  for (const target of mentionTargets) Q.insertMention.run(target, postId, null, createdAt);
  if (poll) {
    const pInfo = Q.insertPoll.run(postId, poll.question, createdAt);
    const pollId = pInfo.lastInsertRowid;
    for (let i = 0; i < poll.options.length; i++) {
      Q.insertPollOption.run(pollId, i, poll.options[i]);
    }
  }
  return postId;
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

const activeUserSalt = crypto.randomBytes(16).toString('hex');
const activeUsers = new Map();
let publicStatsCache = null;

function activeUserKey(uid) {
  return crypto.createHmac('sha256', activeUserSalt).update(String(uid)).digest('hex');
}

function recordActiveUser(uid) {
  if (uid == null) return;
  activeUsers.set(activeUserKey(uid), Date.now());
}

function activeUserCount(now) {
  let count = 0;
  for (const [key, seenAt] of activeUsers) {
    if (now - seenAt > ACTIVE_USER_WINDOW_MS) {
      activeUsers.delete(key);
    } else {
      count++;
    }
  }
  return count;
}

function publicActiveLabel(n) {
  if (n <= 0) return '0';
  if (n <= 5) return '1-5';
  if (n <= 10) return '6-10';
  if (n <= 20) return '11-20';
  if (n <= 50) return '21-50';
  return `${Math.floor(n / 50) * 50}+`;
}

function publicRegisteredLabel(n) {
  if (n <= 0) return '0';
  if (n < 10) return '1+';
  return `${Math.floor(n / 10) * 10}+`;
}

function publicStats() {
  const now = Date.now();
  if (publicStatsCache && publicStatsCache.expiresAt > now) return publicStatsCache.data;
  const data = {
    active_label: publicActiveLabel(activeUserCount(now)),
    registered_label: publicRegisteredLabel(Q.countUsers.get().n || 0),
    active_window_minutes: Math.round(ACTIVE_USER_WINDOW_MS / 60000),
  };
  publicStatsCache = { expiresAt: now + PUBLIC_STATS_CACHE_MS, data };
  return data;
}

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
// SECTION: auth-helpers
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

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
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
    const pvRow = Q.getUserPwVersion.get(payload.uid);
    if (!pvRow || (payload.pv | 0) < pvRow.pw_version) {
      return res.status(401).json({ error: '会话无效或已过期' });
    }
    recordActiveUser(payload.uid);
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

// SECTION: validation
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,24}$/;

function parseEmail(raw) {
  if (typeof raw !== 'string') return { email: '', error: '请求格式错误' };
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { email, error: '邮箱格式不正确' };
  return { email, error: null };
}

function validatePassword(password) {
  if (typeof password !== 'string') return '请求格式错误';
  if (password.length < 8 || password.length > 128) return '密码长度需在 8–128 位之间';
  return null;
}

function sanitizeText(s, max) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
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

// Pick the right search implementation for a raw query. Trigram FTS
// needs 3+ chars to produce any grams, so shorter queries (including
// 2-char CJK terms like "面试") fall back to a literal substring scan.
// Returns { error } | { mode: 'like', term } | { mode: 'fts', term }.
function pickSearchStrategy(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 200) return { error: '搜索词不能为空或过长' };
  if (s.length < SEARCH_MIN_CHARS) return { mode: 'like', term: s };
  const q = sanitizeFtsQuery(s);
  return q ? { mode: 'fts', term: q } : { error: '搜索词无效' };
}

function issueSession(res, userId, username, isAdmin) {
  const jti = crypto.randomBytes(12).toString('hex');
  const pv = Q.getUserPwVersion.get(userId)?.pw_version ?? 0;
  const token = jwt.sign({ uid: userId, u: username, a: isAdmin, pv, jti }, JWT_SECRET, {
    expiresIn: `${SESSION_TTL_DAYS}d`,
  });
  res.cookie('session', token, SESSION_COOKIE_OPTS);
}

// SECTION: token-core — the single path from plaintext token → pseudonym.
// Every write endpoint MUST go through resolveToken; never trust client-supplied
// pseudonyms. See CLAUDE.md "Privacy model".
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

// Validate a 6-digit email code without deleting it on success — callers
// remove the row in their own transaction after they finish using it.
// Returns false on bad shape, expiry, exceeded attempts, or wrong code,
// and bumps the attempts counter on a wrong-code submission so a probe
// can't burn unlimited attempts inside the TTL.
function consumeEmailCode(email, code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  const row = Q.findEmailCode.get(email);
  if (!row || row.expires_at < Date.now()) return false;
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    Q.deleteEmailCode.run(email);
    return false;
  }
  if (row.code_hash !== hashToken(code)) {
    Q.bumpEmailCodeAttempts.run(email);
    return false;
  }
  return true;
}

// Recompute the mention pointers for a comment. Old mentions are cleared
// first so edits don't leave stale rows. Posts route mention writes through
// createPostTx so the whole post commit stays atomic.
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

// ALWAYS replies ok:true for a syntactically valid email. Allowlist,
// already-registered, and throttle checks run in the background so the
// response is opaque — otherwise an attacker could enumerate the
// department roster by probing this endpoint.
// SECTION: routes:auth
app.post('/api/send-code', rateLimit('send-code', 5), (req, res) => {
  const { email, error } = parseEmail(req.body && req.body.email);
  if (error) return res.status(400).json({ error });
  setImmediate(() => processSendCode(email));
  res.json({ ok: true });
});

app.get('/api/stats', rateLimit('stats', 60), (req, res) => {
  res.json(publicStats());
});

// Atomically claim a per-email send slot: the throttle read and the
// upsert share one transaction so two concurrent requests can't both
// pass the 60s check and each trigger an SMTP send.
const claimSendCodeSlotTx = db.transaction((email, codeHash, now) => {
  if (Q.usernameExists.get(email)) return false;
  const existing = Q.findEmailCode.get(email);
  if (existing && now - existing.created_at < RATE_WINDOW_MS) return false;
  Q.upsertEmailCode.run(email, codeHash, now + EMAIL_CODE_TTL_MS, now);
  return true;
});

async function processSendCode(email) {
  try {
    if (!isAllowedEmail(email)) return;
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!claimSendCodeSlotTx(email, hashToken(code), Date.now())) return;
    try {
      await sendVerificationEmail(email, code);
    } catch (e) {
      console.error('[send-code] send failed:', e.message);
      Q.deleteEmailCode.run(email);
    }
  } catch (e) {
    console.error('[send-code] background error:', e.message);
  }
}

app.post('/api/register', rateLimit('register', 5), asyncHandler(async (req, res) => {
  const { email, error } = parseEmail(req.body && req.body.email);
  const { password, password_confirm, code } = req.body || {};
  const err = error || validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  if (password !== password_confirm) {
    return res.status(400).json({ error: '两次输入的密码不一致' });
  }
  // All code-related failures collapse into one message so a probe can't
  // distinguish "not in allowlist" from "wrong code" and learn roster
  // membership.
  const badCode = { error: '验证码无效或已过期' };
  if (!consumeEmailCode(email, code)) return res.status(400).json(badCode);
  // Re-check allowlist in case the roster changed between send and register.
  if (!isAllowedEmail(email)) return res.status(400).json(badCode);

  const hash = await bcrypt.hash(password, 12);
  let info;
  try {
    info = Q.insertUser.run(email, hash, Date.now());
  } catch (e) {
    // Hide duplicate-account races behind the same code error so the
    // register endpoint never becomes an email oracle.
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json(badCode);
    }
    throw e;
  }
  Q.deleteEmailCode.run(email);
  issueSession(res, info.lastInsertRowid, email, false);
  res.json({ ok: true });
}));

app.post('/api/login', rateLimit('login', 10), asyncHandler(async (req, res) => {
  const { email } = parseEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || typeof password !== 'string') {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  const row = Q.findUserByName.get(email);
  const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_BCRYPT_HASH);
  if (!row || !ok) return res.status(401).json({ error: '邮箱或密码错误' });
  // Failure collapses into the same generic auth error so probing
  // this endpoint can't tell "wrong password" from "no longer
  // allowlisted" and learn roster membership.
  if (!userHasAllowlistedEmail(row.id)) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  // Admins get their public display_name (Admin01…); for regular users
  // the handle is only ever the user's own email in their account view —
  // never written alongside content.
  const handle = row.is_admin && row.display_name ? row.display_name : row.username;
  issueSession(res, row.id, handle, !!row.is_admin);
  res.json({ ok: true });
}));

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

app.post('/api/change-password', requireSession, rateLimit('change-password', 5), asyncHandler(async (req, res) => {
  const { current_password, new_password, new_password_confirm } = req.body || {};
  if (typeof current_password !== 'string' || !current_password) {
    return res.status(400).json({ error: '请输入当前密码' });
  }
  const err = validatePassword(new_password);
  if (err) return res.status(400).json({ error: err });
  if (new_password !== new_password_confirm) {
    return res.status(400).json({ error: '两次输入的密码不一致' });
  }
  const row = Q.findUserById.get(req.user.uid);
  if (!row) return res.status(400).json({ error: '用户不存在' });
  const ok = await bcrypt.compare(current_password, row.password_hash);
  if (!ok) return res.status(401).json({ error: '当前密码错误' });
  const hash = await bcrypt.hash(new_password, 12);
  Q.updateUserPassword.run(hash, row.id);
  res.clearCookie('session', SESSION_COOKIE_BASE_OPTS);
  res.json({ ok: true });
}));

// Stays opaque if the new address is already taken by another account
// (silently drops in processChangeEmailSendCode), so this endpoint
// can't be used as a registration probe.
app.post('/api/change-email/send-code', requireSession, rateLimit('change-email-send-code', 5), (req, res) => {
  const { email, error } = parseEmail(req.body && req.body.email);
  if (error) return res.status(400).json({ error });
  setImmediate(() => processChangeEmailSendCode(req.user.uid, email));
  res.json({ ok: true });
});

async function processChangeEmailSendCode(uid, email) {
  try {
    const cur = Q.getUserEmail.get(uid);
    if (!cur || cur.username === email) return;
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!claimSendCodeSlotTx(email, hashToken(code), Date.now())) return;
    try {
      await sendVerificationEmail(email, code);
    } catch (e) {
      console.error('[change-email send-code] send failed:', e.message);
      Q.deleteEmailCode.run(email);
    }
  } catch (e) {
    console.error('[change-email send-code] background error:', e.message);
  }
}

// Bumping pw_version inside Q.updateUserEmail invalidates every
// existing session — the user has to re-log in via the new address,
// which proves the mailbox is actually theirs.
const swapEmailTx = db.transaction((uid, oldEmail, newEmail, now) => {
  if (Q.usernameExists.get(newEmail)) return false;
  // If the user is rotating BACK to a previous address, drop that
  // address from history so it doesn't sit there as a duplicate of
  // the new current email.
  Q.deleteUserEmailHistoryFor.run(uid, newEmail);
  Q.insertUserEmailHistory.run(uid, oldEmail, now);
  Q.updateUserEmail.run(newEmail, uid);
  Q.deleteEmailCode.run(newEmail);
  return true;
});

app.post('/api/change-email', requireSession, rateLimit('change-email', 5), asyncHandler(async (req, res) => {
  const { email: newEmail, error } = parseEmail(req.body && req.body.email);
  if (error) return res.status(400).json({ error });
  const { password, code } = req.body || {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: '请输入当前密码' });
  }

  const cur = Q.getUserEmail.get(req.user.uid);
  if (!cur) return res.status(400).json({ error: '用户不存在' });
  if (cur.username === newEmail) {
    return res.status(400).json({ error: '新邮箱与当前邮箱相同' });
  }

  // Validate the cheap things first — bcrypt costs ~100ms; doing it
  // before the code check would let a session-holding attacker burn
  // server CPU on every wrong-code probe.
  const badCode = { error: '验证码无效或已过期' };
  if (!consumeEmailCode(newEmail, code)) return res.status(400).json(badCode);

  const userRow = Q.findUserById.get(req.user.uid);
  const ok = await bcrypt.compare(password, userRow ? userRow.password_hash : DUMMY_BCRYPT_HASH);
  if (!userRow || !ok) return res.status(401).json({ error: '当前密码错误' });

  let swapped;
  try {
    swapped = swapEmailTx(req.user.uid, cur.username, newEmail, Date.now());
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json(badCode);
    }
    throw e;
  }
  if (!swapped) return res.status(400).json(badCode);

  res.clearCookie('session', SESSION_COOKIE_BASE_OPTS);
  res.json({ ok: true });
}));

app.get('/api/me', requireSession, (req, res) => {
  const q = quotaFor(req.user.uid);
  const admin = isLiveAdmin(req.user.uid);
  res.json({
    uid: req.user.uid,
    username: req.user.u,
    admin,
    admin_handles: Q.listAdminHandles.all().map((row) => row.display_name),
    tokens_remaining: q.remaining,
    max_tokens_per_day: q.max,
    unlimited_tokens: !!q.unlimited,
  });
});

// The only endpoint that knows who you are. It spends one of your daily
// slots and returns a fresh random token. The server stores only
// sha256(token) + expiry — never a link back to your user id.
// SECTION: routes:token
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

// Feed. Supports optional ?channel=<slug> filter.
// SECTION: routes:posts
app.get('/api/posts', requireSession, (req, res) => {
  let rows;
  const chParam = req.query.channel;
  if (chParam != null) {
    const slug = sanitizeChannelSlug(chParam);
    if (!slug) return res.status(400).json({ error: '无效的频道' });
    const ch = Q.getChannelBySlug.get(slug);
    if (!ch) return res.status(404).json({ error: '频道不存在' });
    rows = Q.listPostsByChannel.all(ch.id);
  } else {
    rows = Q.listPosts.all();
  }
  res.json(annotatePostStats(rows.map(mapPostPreview)));
});

app.post('/api/posts', requireSession, (req, res) => {
  const { token, title, content, channel_id, poll } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const publicHandle = publicHandleFor(req.user, resolved.authorKey);
  const t = sanitizeText(title, 200);
  const c = sanitizeText(content, 10000);
  if (!t || !c) return res.status(400).json({ error: '标题和内容不能为空' });
  const ch = resolveChannelInput(channel_id);
  if (!ch.ok) return res.status(400).json({ error: ch.error });
  const pollParsed = parsePollInput(poll);
  if (!pollParsed.ok) return res.status(400).json({ error: pollParsed.error });

  const createdAt = Date.now();
  const targets = extractMentionTargets(c);
  const postId = createPostTx(publicHandle, t, c, createdAt, resolved.tokenHash, ch.channelId, targets, pollParsed.poll);

  res.json({
    id: postId,
    pseudonym: publicHandle,
    author_key: resolved.authorKey,
    title: t,
    content: c,
    truncated: false,
    created_at: createdAt,
    edited_at: null,
    channel_id: ch.channelId,
  });
});

app.get('/api/posts/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const post = Q.getPost.get(id);
  if (!post) return res.status(404).json({ error: '未找到' });
  const comments = annotateCommentReactions(Q.listComments.all(id));
  const { token_hash, ...safePost } = post;
  res.json({
    post: safePost,
    comments,
    reactions: reactionCountsFor(id),
    poll: post.deleted_at ? null : pollViewFor(id, null),
    save_count:   Q.countSavedForPost.get(id)?.n ?? 0,
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

// Comment reactions — same shape as post reactions but keyed on comment_id.
// The :pid param scopes the URL to a post for routing/auth consistency, and
// we sanity-check that the comment belongs to the post and the post is alive.
app.post('/api/posts/:pid/comments/:id/reactions', requireSession, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const cid = parseInt(req.params.id, 10);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(cid) || cid <= 0) {
    return res.status(400).json({ error: '无效的 ID' });
  }
  const { token, kind } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  if (!REACTION_KIND_SET.has(kind)) return res.status(400).json({ error: '不支持的表情' });
  if (!Q.isPostAlive.get(pid)) {
    return res.status(Q.postExists.get(pid) ? 410 : 404).json({ error: '帖子已删除或未找到' });
  }
  const c = Q.getCommentForReaction.get(cid);
  if (!c || c.post_id !== pid) return res.status(404).json({ error: '评论不存在' });
  toggleCommentReactionTx(cid, resolved.tokenHash, kind);
  res.json({ reactions: commentReactionCountsFor(cid) });
});

// Vote once + locked in. A missing option_id means "tell me my state",
// which is how the client reveals results after a prior vote in another
// session — see myVoteFor in public/app.js.
app.post('/api/posts/:id/vote', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const { token, option_id } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  if (!Q.isPostAlive.get(id)) {
    return res.status(Q.postExists.get(id) ? 410 : 404).json({ error: '帖子已删除或未找到' });
  }
  const poll = Q.getPollByPost.get(id);
  if (!poll) return res.status(404).json({ error: '该帖子没有投票' });
  if (option_id != null) {
    if (!Number.isInteger(option_id) || !Q.optionInPoll.get(option_id, poll.id)) {
      return res.status(400).json({ error: '无效的选项' });
    }
    if (!castVoteTx(poll.id, resolved.tokenHash, option_id)) {
      return res.status(409).json({ error: '你已经投过票了' });
    }
  }
  res.json({ poll: pollViewFor(id, resolved.tokenHash) });
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
      reactions: Object.fromEntries(REACTION_KINDS.map((k) => [k, 0])),
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
// while leaving the row so child comments aren't cascade-deleted.
// Post-level mentions and reaction rows are cleared.
function tombstonePost(id) {
  clearMentionsForPost.run(id);
  Q.clearReactionsForPost.run(id);
  Q.deletePollForPost.run(id);
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

// Image uploads. Content-addressed by sha256(body) — files live under
// uploads/<hash>.<ext> with no user_id anywhere, matching the CLAUDE.md
// rule that attachments must stay content-scoped. Sharp re-encodes the
// payload, which strips EXIF and any other embedded metadata along the
// way. The caller still needs a valid posting token (or admin session)
// so random session holders can't silently park files in the bucket.
// SECTION: routes:uploads
app.post('/api/uploads', requireSession, (req, res) => {
  uploadMiddleware.single('image')(req, res, async (multerErr) => {
    if (multerErr) {
      const msg = multerErr.code === 'LIMIT_FILE_SIZE' ? '文件过大（上限 4 MB）' : '上传失败';
      return res.status(400).json({ error: msg });
    }
    // Entire handler is inside try/catch so that a synchronous throw from
    // resolveToken or isLiveAdmin (e.g. a SQLite error) becomes a 500 response
    // rather than an unhandled promise rejection that would crash the process.
    try {
      const { token } = req.body || {};
      const resolved = resolveToken(token);
      const admin = isLiveAdmin(req.user.uid);
      if (!resolved && !admin) return res.status(401).json({ error: '发帖令牌无效或已过期' });
      if (!req.file) return res.status(400).json({ error: '没有图片' });
      const inExt = UPLOAD_EXT_FOR_MIME[req.file.mimetype];
      if (!inExt) return res.status(400).json({ error: '只支持 JPG / PNG / WebP' });
      const pipeline = sharp(req.file.buffer, { failOn: 'error' })
        .rotate()
        .resize({ width: 1600, withoutEnlargement: true });
      // PNG stays PNG to preserve transparency / lossless intent; JPEG & WebP
      // both emit WebP for ~25–40% smaller files at visually equivalent quality.
      const outExt = inExt === 'png' ? 'png' : 'webp';
      const out = outExt === 'png'
        ? await pipeline.png().toBuffer()
        : await pipeline.webp({ quality: 82 }).toBuffer();
      const hash = crypto.createHash('sha256').update(out).digest('hex');
      const fileName = `${hash}.${outExt}`;
      const filePath = path.join(UPLOAD_DIR, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, out);
      res.json({ url: `/api/uploads/${fileName}` });
    } catch {
      if (!res.headersSent) res.status(500).json({ error: '上传失败，请稍后重试' });
    }
  });
});

app.get('/api/uploads/:name', requireSession, (req, res) => {
  if (!UPLOAD_NAME_RE.test(req.params.name)) return res.status(404).end();
  const fp = path.join(UPLOAD_DIR, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).end();
  // Long cache is safe — filenames are immutable content hashes.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(fp);
});

// Saved posts: reader-side bookmarks bound to the account, not the
// posting token. Kept in its own endpoint so feed/thread reads never
// pick up per-user state — callers ask explicitly for their saves.
// SECTION: routes:saved
app.get('/api/saved', requireSession, (req, res) => {
  const ids = Q.listSavedIds.all(req.user.uid).map((r) => r.post_id);
  const posts = annotatePostStats(Q.listSavedPosts.all(req.user.uid).map(mapPostPreview));
  res.json({ ids, posts });
});

app.post('/api/saved/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  if (!Q.isPostAlive.get(id)) {
    return res.status(Q.postExists.get(id) ? 410 : 404).json({ error: '帖子已删除或未找到' });
  }
  Q.insertSaved.run(req.user.uid, id, Date.now());
  res.json({ ok: true, saved: true, save_count: Q.countSavedForPost.get(id)?.n ?? 0 });
});

app.delete('/api/saved/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  Q.deleteSaved.run(req.user.uid, id);
  res.json({ ok: true, saved: false, save_count: Q.countSavedForPost.get(id)?.n ?? 0 });
});

// Docs bookmarks. Same reader-side model as saved_posts — (user_id,
// doc_id) is never read by any content endpoint, so saving a doc
// doesn't leak anything about who edits it.
app.get('/api/saved-docs', requireSession, (req, res) => {
  const ids = Q.listSavedDocIds.all(req.user.uid).map((r) => r.doc_id);
  const docs = Q.listSavedDocs.all(req.user.uid);
  res.json({ ids, docs });
});

app.post('/api/saved-docs/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  if (!Q.docExists.get(id)) return res.status(404).json({ error: '未找到' });
  Q.insertSavedDoc.run(req.user.uid, id, Date.now());
  res.json({ ok: true, saved: true, save_count: Q.countSavedDocsForDoc.get(id)?.n ?? 0 });
});

app.delete('/api/saved-docs/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  Q.deleteSavedDoc.run(req.user.uid, id);
  res.json({ ok: true, saved: false, save_count: Q.countSavedDocsForDoc.get(id)?.n ?? 0 });
});

// Per-user channel prefs: pinned + muted + last-seen. Reader-side
// only; never joined into feed/thread responses. Client fetches once
// on login, then re-fetches unread counts alongside the mention poll.
// SECTION: routes:channels
app.get('/api/channel-prefs', requireSession, (req, res) => {
  res.json(Q.listChannelPrefs.all(req.user.uid));
});

app.get('/api/channel-unread', requireSession, (req, res) => {
  res.json(Q.channelUnreadCounts.all(req.user.uid));
});

app.post('/api/channels/:id/seen', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  if (!Q.getChannelById.get(id)) return res.status(404).json({ error: '频道不存在' });
  Q.markChannelSeen.run(req.user.uid, id, Date.now());
  res.json({ ok: true });
});

app.post('/api/channel-prefs/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  if (!Q.getChannelById.get(id)) return res.status(404).json({ error: '频道不存在' });
  const pinned = req.body && req.body.pinned ? 1 : 0;
  const muted = req.body && req.body.muted ? 1 : 0;
  if (!pinned && !muted) {
    Q.deleteChannelPref.run(req.user.uid, id);
  } else {
    Q.upsertChannelPref.run(req.user.uid, id, pinned, muted);
  }
  res.json({ channel_id: id, pinned: !!pinned, muted: !!muted });
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
// SECTION: routes:bulletins
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

// Shared docs: wiki-style markdown pages. Any logged-in user with a
// valid posting token can create or edit; admins and the original
// creator (while their token is live) can delete. See CLAUDE.md
// "Privacy model" — we store created_token_hash purely as a delete gate
// and rotate() nulls it out when the token expires.
// SECTION: routes:docs
function mapDocRow(r) {
  return {
    id: r.id,
    channel_id: r.channel_id,
    title: r.title,
    created_pseudonym: r.created_pseudonym,
    last_editor_pseudonym: r.last_editor_pseudonym,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Strip the internal created_token_hash before shipping a full doc row
// to the client — that hash is the delete-gate fingerprint and must
// never leave the server.
function mapDocFull(row) {
  const { created_token_hash, ...safe } = row;
  return safe;
}

app.get('/api/docs', requireSession, (req, res) => {
  let rows;
  const qParam = req.query.q;
  const chParam = req.query.channel;
  if (qParam != null) {
    const s = pickSearchStrategy(qParam);
    if (s.error) return res.status(400).json({ error: s.error });
    rows = s.mode === 'like'
      ? Q.searchDocsLike.all(s.term, s.term)
      : Q.searchDocs.all(s.term);
  } else if (chParam != null) {
    const slug = sanitizeChannelSlug(chParam);
    if (!slug) return res.status(400).json({ error: '无效的频道' });
    const ch = Q.getChannelBySlug.get(slug);
    if (!ch) return res.status(404).json({ error: '频道不存在' });
    rows = Q.listDocsByChannel.all(ch.id);
  } else {
    rows = Q.listDocs.all();
  }
  res.json(rows.map(mapDocRow));
});

app.get('/api/docs/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const row = Q.getDoc.get(id);
  if (!row) return res.status(404).json({ error: '未找到' });
  res.json({
    ...mapDocFull(row),
    save_count: Q.countSavedDocsForDoc.get(id)?.n ?? 0,
  });
});

app.post('/api/docs', requireSession, (req, res) => {
  const { token, title, content, channel_id } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const publicHandle = publicHandleFor(req.user, resolved.authorKey);
  const t = sanitizeText(title, 200);
  const c = sanitizeText(content, 20000);
  if (!t || !c) return res.status(400).json({ error: '标题和内容不能为空' });
  const ch = resolveChannelInput(channel_id);
  if (!ch.ok) return res.status(400).json({ error: ch.error });

  const createdAt = Date.now();
  const info = Q.insertDoc.run(
    ch.channelId, t, c, publicHandle, publicHandle, resolved.tokenHash, createdAt
  );
  res.json({
    id: info.lastInsertRowid,
    channel_id: ch.channelId,
    title: t,
    content: c,
    created_pseudonym: publicHandle,
    last_editor_pseudonym: publicHandle,
    created_at: createdAt,
    updated_at: null,
  });
});

app.put('/api/docs/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const { token, title, content, expected_version } = req.body || {};
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const publicHandle = publicHandleFor(req.user, resolved.authorKey);
  const t = sanitizeText(title, 200);
  const c = sanitizeText(content, 20000);
  if (!t || !c) return res.status(400).json({ error: '标题和内容不能为空' });
  if (!Number.isFinite(expected_version)) {
    return res.status(400).json({ error: '缺少版本信息' });
  }
  const current = Q.getDoc.get(id);
  if (!current) return res.status(404).json({ error: '未找到' });

  // Force strict monotonicity — if two saves land in the same
  // millisecond the raw `Date.now()` would collide with the previous
  // `updated_at`, letting a stale client squeak through the next check.
  const prior = current.updated_at || current.created_at || 0;
  const updatedAt = Math.max(Date.now(), prior + 1);
  const info = Q.updateDoc.run(t, c, publicHandle, updatedAt, id, expected_version);
  if (info.changes === 0) {
    // Version mismatch — someone else saved between this client's fetch
    // and its save. Return the current server state so the client can
    // show the live content alongside the user's in-progress draft.
    return res.status(409).json({
      error: '有人在你之前编辑了这份文档',
      latest: mapDocFull(current),
    });
  }
  res.json(mapDocFull(Q.getDoc.get(id)));
});

app.delete('/api/docs/:id', requireSession, (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const { token } = req.body || {};
  if (isLiveAdmin(req.user.uid)) {
    const info = Q.deleteDoc.run(id);
    if (info.changes === 0) return res.status(404).json({ error: '未找到' });
    return res.json({ ok: true });
  }
  const resolved = resolveToken(token);
  if (!resolved) return res.status(401).json({ error: '发帖令牌无效或已过期' });
  const info = Q.deleteOwnDoc.run(id, resolved.tokenHash);
  if (info.changes === 0) {
    const existed = Q.docExists.get(id);
    return res.status(existed ? 403 : 404).json({ error: existed ? '只有创建者或管理员可以删除' : '未找到' });
  }
  res.json({ ok: true });
});

// Search over posts + comments. FTS5 trigram for 3+ chars; shorter
// queries fall back to instr() substring scan so 2-char CJK terms like
// "你好" still work (trigram index can't produce trigrams from <3 chars).
// SECTION: routes:search
app.get('/api/search', requireSession, (req, res) => {
  const s = pickSearchStrategy(req.query.q);
  if (s.error) return res.status(400).json({ error: s.error });

  // Each row: { id, rank?, in_post, in_comment }. FTS path sets rank,
  // LIKE path leaves it undefined and we sort by recency instead.
  const byId = new Map();
  if (s.mode === 'like') {
    for (const r of Q.searchPostsLike.all(s.term, s.term)) {
      byId.set(r.id, { id: r.id, in_post: 1, in_comment: 0 });
    }
    for (const r of Q.searchPostsByCommentLike.all(s.term)) {
      const cur = byId.get(r.id);
      if (cur) cur.in_comment = 1;
      else byId.set(r.id, { id: r.id, in_post: 0, in_comment: 1 });
    }
  } else {
    for (const r of Q.searchPostsByPost.all(s.term)) {
      byId.set(r.id, { id: r.id, rank: r.rank, in_post: 1, in_comment: 0 });
    }
    for (const r of Q.searchPostsByComment.all(s.term)) {
      const cur = byId.get(r.id);
      if (cur) {
        cur.in_comment = 1;
        if (r.rank < cur.rank) cur.rank = r.rank;
      } else {
        byId.set(r.id, { id: r.id, rank: r.rank, in_post: 0, in_comment: 1 });
      }
    }
  }
  if (!byId.size) return res.json([]);
  const ordered = [...byId.values()]
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
    .slice(0, SEARCH_LIMIT);
  const ids = ordered.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT ${postPreviewSql()} FROM posts WHERE id IN (${placeholders})`
  ).all(...ids);
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  res.json(annotatePostStats(ordered.map((hit) => ({
    ...mapPostPreview(rowsById.get(hit.id)),
    hit_in_post: !!hit.in_post,
    hit_in_comment: !!hit.in_comment,
  }))));
});

// @mention inbox for either the current token's pseudonym or, for admins,
// their public username. Rows still age out after TOKEN_TTL_HOURS.
// SECTION: routes:mentions
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
      <author>${esc(r.pseudonym)}@teahole</author>
      <description>${esc(snippet)}</description>
    </item>`;
  }).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>茶园树洞</title>
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
// SECTION: routes:spa — deep-link catchalls; must stay oblivious to record
// existence (see CLAUDE.md "Privacy model" → deep-link endpoints).
app.get('/p/:id(\\d+)', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Bulletins are admin-authored + public by design, but the same
// existence-oblivious rule applies so deep-link probes can't learn a
// bulletin's status before login.
app.get('/b/:id(\\d+)', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Docs deep-link — same existence-oblivious rule as /p and /b.
app.get('/d/:id(\\d+)', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器错误，请稍后重试' });
});

// Purges expired token hashes, orphan author-edit fingerprints on posts
// and comments, and stale mention pointers. Nothing here is keyed by
// user_id, so this sweep plus the calendar boundary is what makes old
// posts truly unlinkable.
// SECTION: rotate+listen
function rotate() {
  const now = Date.now();
  const mentionCutoff = now - TOKEN_TTL_HOURS * 3600 * 1000;
  const t = Q.purgeTokens.run(now);
  const ph = Q.orphanPostHashes.run();
  const ch = Q.orphanCmtHashes.run();
  const dh = Q.orphanDocHashes.run();
  const m = Q.purgeMentions.run(mentionCutoff);
  const r = Q.purgeRevoked.run(now);
  const e = Q.purgeEmailCodes.run(now);
  if (t.changes + m.changes + ph.changes + ch.changes + dh.changes + r.changes + e.changes > 0) {
    console.log(
      `[rotate] purged ${t.changes} tokens, ${m.changes} mentions, ` +
      `${r.changes} revoked sessions, ${e.changes} email codes, ` +
      `orphaned ${ph.changes} post / ${ch.changes} comment / ${dh.changes} doc hashes`
    );
  }
}
setInterval(rotate, ROTATE_INTERVAL_MS).unref();
rotate();

app.listen(PORT, () => {
  console.log(`teahole listening on http://localhost:${PORT}`);
});
