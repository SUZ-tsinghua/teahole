const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
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

// One-shot drop for the removed tag feature: any pre-existing DB still
// has post_tags around. Drop it (and its index) here so stale rows
// don't keep referencing posts.
db.exec('DROP INDEX IF EXISTS idx_post_tags_tag');
db.exec('DROP TABLE IF EXISTS post_tags');

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

module.exports = db;
