// ────────────────────────────────────────────────────────────────────────────
// FILE MAP — grep "SECTION:" to jump.
//
//   SECTION: bootstrap      Database handle + WAL + FK pragmas
//   SECTION: schema         CREATE TABLE / CREATE INDEX (content + reader-side)
//   SECTION: drops          One-shot cleanups for removed features
//   SECTION: migrations     ALTER TABLE ADD COLUMN + post-alter indexes
//   SECTION: seeds          Default channel + dev user reset (user_version gate)
//   SECTION: housekeeping   NOCASE username index, admin display-name backfill
//
// When adding a column: update the CREATE TABLE block AND add an ALTER block
// in SECTION: migrations. When adding a table keyed by token_hash: FK into
// post_tokens(token_hash) ON DELETE CASCADE (see CLAUDE.md "Privacy model").
// ────────────────────────────────────────────────────────────────────────────

// SECTION: bootstrap
const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// SECTION: schema
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  tokens_issued_date TEXT,
  tokens_issued_count INTEGER NOT NULL DEFAULT 0
);

-- Active posting tokens. Hash only. No user link.
CREATE TABLE IF NOT EXISTS post_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_post_tokens_expires ON post_tokens(expires_at);

-- Posts carry a public-facing handle but never a user_id: regular
-- members get an opaque per-token pseudonym; live admins deliberately
-- post under their username. The token_hash column is used ONLY to gate
-- "author can edit/delete" checks; once the corresponding token row in
-- post_tokens has expired and been purged, this hash no longer joins to
-- anything, leaving only the public display handle on the content row.
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pseudonym TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  token_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  parent_id INTEGER,
  pseudonym TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  token_hash TEXT,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

-- Reactions keyed by full token_hash so cascades from post_tokens purge
-- them automatically when the token expires — no user_id ever stored.
CREATE TABLE IF NOT EXISTS reactions (
  post_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, token_hash, kind),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (token_hash) REFERENCES post_tokens(token_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);

-- Comment reactions: same shape as the post reactions table, keyed by
-- comment_id. The comments to posts cascade plus the token_hash to
-- post_tokens cascade both apply, so a deleted post or expired token
-- wipes these rows automatically. Privacy model is identical: no
-- user_id, ever.
CREATE TABLE IF NOT EXISTS comment_reactions (
  comment_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, token_hash, kind),
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (token_hash) REFERENCES post_tokens(token_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment ON comment_reactions(comment_id);

-- Polls attach 0..1 to a post. question + ordered option list. A vote is
-- keyed by token_hash (not user_id), so votes cascade out when the token
-- expires — same privacy model as reactions. PK (poll_id, token_hash)
-- enforces one vote per token per poll. Aggregate counts live on
-- poll_options.votes_total, a monotonic counter, so totals stay durable
-- after token rotation while the per-token row in poll_votes is still
-- purged on expiry (preserving "can't link old content to current
-- account"). Results are NEVER returned by the server unless the caller's
-- token already has a vote row on the poll (enforced server-side).
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL UNIQUE,
  question TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  votes_total INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  option_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, token_hash),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
  FOREIGN KEY (token_hash) REFERENCES post_tokens(token_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(option_id);

-- Channels are attached to the post, not the author, so they leak no
-- "who wrote what" info. ON DELETE SET NULL on posts.channel_id (in
-- the ALTER below) keeps posts alive when a channel is removed —
-- content is not admin-churnable.
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);

-- Mentions inbox: keyed by target handle, which is either a token-scoped
-- 8-char pseudonym or a public admin username. rotate() ages rows out
-- after TOKEN_TTL_HOURS so stale pseudonym mentions can't bleed into a
-- new token holder that coincidentally picks up the same 8-char prefix.
-- FK cascades catch post/comment delete.
CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_pseudonym TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  comment_id INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mentions_target ON mentions(target_pseudonym, created_at);

-- FTS5 over post title+content. Trigram tokenizer so CJK works; the
-- default unicode61 tokenizer won't split Chinese into useful tokens.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title, content, content='posts', content_rowid='id', tokenize='trigram'
);

-- Revoked JWTs. Logout inserts the session's jti so requireSession can
-- reject it even though the JWT is otherwise still valid. expires_at
-- matches the original JWT exp so rotate() can prune.
CREATE TABLE IF NOT EXISTS revoked_sessions (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_exp ON revoked_sessions(expires_at);

-- Followed threads: reader-side state only. last_seen_comment_id lets
-- the client compute unread counts without the server exposing who has
-- read what in any content-read endpoint.
CREATE TABLE IF NOT EXISTS followed_posts (
  user_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  followed_at INTEGER NOT NULL,
  last_seen_comment_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, post_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- Per-user channel preferences (pinned / muted / last-seen). Reader-
-- side state only; purely a display / unread-counter preference.
-- Cascades on user + channel delete.
CREATE TABLE IF NOT EXISTS user_channel_prefs (
  user_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  PRIMARY KEY (user_id, channel_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

-- Saved posts: reader-side bookmark against the account, not the token,
-- so it survives token rotation. Keyed by (user_id, post_id); the row
-- records WHO saved WHAT. This is a reader-side linkage only, never
-- joined into feed/thread read endpoints, so it can't be used to infer
-- authorship (anyone can save anyone's post).
CREATE TABLE IF NOT EXISTS saved_posts (
  user_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_saved_posts_user ON saved_posts(user_id, created_at);

-- Bulletins: admin-curated notices. Authored under the admin's username,
-- same opt-in-public model as admin posts. Intentionally separate from
-- posts so regular-member anonymous content and admin announcements
-- don't share a table (and can't be confused via an ID collision).
CREATE TABLE IF NOT EXISTS bulletins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_username TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bulletins_created ON bulletins(created_at);

-- Shared docs: wiki-style markdown pages attached to a channel. Unlike
-- posts, docs are collaboratively editable — anyone holding a valid
-- posting token can edit. The creator's token_hash is stored so the
-- creator (while their token is still live) or an admin can delete; it
-- is nulled out by rotate() when the token expires so the row stops
-- being a per-author linker. last_editor_pseudonym is a public display
-- handle only (8-char pseudonym or admin username) — never a token hash.
-- ON DELETE SET NULL on channel_id mirrors posts: docs survive channel
-- deletion and fall back to the default channel client-side.
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_pseudonym TEXT NOT NULL,
  last_editor_pseudonym TEXT,
  created_token_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_docs_channel ON docs(channel_id);
CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updated_at);

-- FTS5 over docs title+content. Trigram tokenizer for CJK, matching
-- the posts_fts setup. Triggers mirror the post FTS lifecycle.
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, content, content='docs', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO docs_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- Same reader-side bookmark model as saved_posts but keyed by doc. The
-- (user_id, doc_id) row is never joined into read endpoints, so it
-- can't be used to infer authorship (anyone can save anyone's doc).
CREATE TABLE IF NOT EXISTS saved_docs (
  user_id INTEGER NOT NULL,
  doc_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, doc_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_saved_docs_user ON saved_docs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_saved_docs_doc  ON saved_docs(doc_id);

-- One-shot email verification codes. Keyed by email so sending a new
-- code for an address replaces any pending one. Stores only the hash
-- of the 6-digit code; rotate() purges expired rows. Intentionally
-- NOT FK'd to users — codes exist before the account does.
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_expires ON email_codes(expires_at);

CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO posts_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- Comment FTS so search matches a thread when the hit is in a reply,
-- not just the OP. Same trigram tokenizer for CJK parity with posts_fts.
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  content, content='comments', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS comments_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS comments_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS comments_au AFTER UPDATE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO comments_fts(rowid, content) VALUES (new.id, new.content);
END;
`);

// SECTION: drops
// One-shot drop for the removed tag feature: any pre-existing DB still
// has post_tags around. Drop it (and its index) here so stale rows
// don't keep referencing posts.
db.exec('DROP INDEX IF EXISTS idx_post_tags_tag');
db.exec('DROP TABLE IF EXISTS post_tags');

// SECTION: migrations
// Column-level migrations for pre-existing databases. CREATE TABLE above
// is a no-op when the table already exists, so new columns have to come
// in via ALTER. Indexes on new columns must be created AFTER the ALTER.
const columnsOf = (table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const commentCols = columnsOf('comments');
if (!commentCols.includes('parent_id')) {
  db.exec(
    'ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE'
  );
}
if (!commentCols.includes('edited_at')) {
  db.exec('ALTER TABLE comments ADD COLUMN edited_at INTEGER');
}
if (!commentCols.includes('token_hash')) {
  db.exec('ALTER TABLE comments ADD COLUMN token_hash TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)');

const userCols = columnsOf('users');
if (!userCols.includes('display_name')) {
  db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
}

const postCols = columnsOf('posts');
if (!postCols.includes('edited_at')) {
  db.exec('ALTER TABLE posts ADD COLUMN edited_at INTEGER');
}
if (!postCols.includes('token_hash')) {
  db.exec('ALTER TABLE posts ADD COLUMN token_hash TEXT');
}
if (!postCols.includes('deleted_at')) {
  db.exec('ALTER TABLE posts ADD COLUMN deleted_at INTEGER');
}
if (!postCols.includes('channel_id')) {
  db.exec(
    'ALTER TABLE posts ADD COLUMN channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL'
  );
}
db.exec('CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts(deleted_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id)');

const prefCols = columnsOf('user_channel_prefs');
if (prefCols.length && !prefCols.includes('last_seen_at')) {
  db.exec('ALTER TABLE user_channel_prefs ADD COLUMN last_seen_at INTEGER');
}

// Durable per-option vote counter. Backfill from poll_votes so existing
// polls don't drop to zero on the next token sweep.
const pollOptCols = columnsOf('poll_options');
if (pollOptCols.length && !pollOptCols.includes('votes_total')) {
  db.exec('ALTER TABLE poll_options ADD COLUMN votes_total INTEGER NOT NULL DEFAULT 0');
  db.exec(
    `UPDATE poll_options SET votes_total = (
       SELECT COUNT(*) FROM poll_votes WHERE option_id = poll_options.id
     )`
  );
}

// SECTION: seeds
const channelCount = db.prepare('SELECT count(*) AS n FROM channels').get().n;
if (channelCount === 0) {
  db.prepare(
    'INSERT INTO channels (slug, name, description, created_at) VALUES (?, ?, ?, ?)'
  ).run('general', '一般讨论', '默认频道', Date.now());
}

// Backfill FTS for pre-existing posts/comments. For contentless FTS5 tables
// `count(*)` returns the underlying-table row count, so we can't use that
// to detect "index empty"; track schema version via user_version instead.
const ftsCount = db.prepare('SELECT count(*) AS n FROM posts_fts').get().n;
const postCount = db.prepare('SELECT count(*) AS n FROM posts').get().n;
if (ftsCount === 0 && postCount > 0) {
  db.exec("INSERT INTO posts_fts(posts_fts) VALUES('rebuild')");
}
const userVersion = db.pragma('user_version', { simple: true });
if (userVersion < 2) {
  db.exec("INSERT INTO comments_fts(comments_fts) VALUES('rebuild')");
  db.pragma('user_version = 2');
}

// SECTION: housekeeping
// Case-insensitive username uniqueness. Prevents `Alice` and `alice` from
// both registering. Will fail to create if a pre-existing DB already has
// case-variant duplicates — we log and move on rather than crash.
try {
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)'
  );
} catch (e) {
  console.warn(
    '[warn] could not create username NOCASE unique index — dedupe existing users first:',
    e.message
  );
}

// Migration to email-based accounts. The old schema allowed arbitrary
// `username`s; posts/comments never linked back to users, so wiping the
// users table here is safe for content. FK cascades clear reader-side
// state (followed_posts, user_channel_prefs, saved_posts). Seeds two
// debug accounts so the app is usable right after the migration.
if (db.pragma('user_version', { simple: true }) < 3) {
  const bcrypt = require('bcrypt');
  const now = Date.now();
  db.exec('DELETE FROM users');
  const seed = db.prepare(
    `INSERT INTO users (username, password_hash, is_admin, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  seed.run('admin@example.com', bcrypt.hashSync('admin1234', 12), 1, 'Admin01', now);
  seed.run('user@example.com', bcrypt.hashSync('user1234', 12), 0, null, now);
  db.pragma('user_version = 3');
  console.log('[migrate] users reset; seeded admin@example.com + user@example.com (see README for dev passwords)');
}

// docs_fts was added after some DBs already had rows in `docs`; backfill once.
if (db.pragma('user_version', { simple: true }) < 4) {
  db.exec("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')");
  db.pragma('user_version = 4');
}

// Assign Admin## display names to any admin that doesn't have one yet.
// The documented promotion flow is raw SQL, so promoted admins start
// with NULL display_name.
const missingAdmins = db
  .prepare('SELECT id FROM users WHERE is_admin = 1 AND display_name IS NULL ORDER BY id ASC')
  .all();
if (missingAdmins.length) {
  const { max } = db
    .prepare(
      `SELECT MAX(CAST(substr(display_name, 6) AS INTEGER)) AS max
       FROM users WHERE display_name GLOB 'Admin[0-9][0-9]'`
    )
    .get();
  const setName = db.prepare('UPDATE users SET display_name = ? WHERE id = ?');
  let n = (max || 0) + 1;
  for (const row of missingAdmins) {
    setName.run(`Admin${String(n).padStart(2, '0')}`, row.id);
    n += 1;
  }
  console.log(`[migrate] assigned display_name to ${missingAdmins.length} admin(s)`);
}

module.exports = db;
