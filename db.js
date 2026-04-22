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

-- Posts carry an opaque per-token pseudonym, never a user_id. The
-- token_hash column is used ONLY to gate "author can edit/delete" checks;
-- once the corresponding token row in post_tokens has expired and been
-- purged, this hash no longer joins to anything — the post is orphaned
-- from any identity, which is exactly the intended state.
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

-- Same privacy shape as tags: attached to the post, not the author.
-- ON DELETE SET NULL on posts.channel_id (in the ALTER below) keeps
-- posts alive when a channel is removed — content is not admin-churnable.
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);

-- Tags: normalized lowercase, attached to a post. Stored per-post (not
-- per-user), so tagging leaks no "who tags what" info.
CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (post_id, tag),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag);

-- Mentions inbox: keyed by target pseudonym (8 hex chars) because that's
-- all the sender types. rotate() ages rows out after TOKEN_TTL_HOURS so
-- stale mentions can't bleed into a new token holder that coincidentally
-- picks up the same 8-char prefix. FK cascades catch post/comment delete.
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
`);

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

const channelCount = db.prepare('SELECT count(*) AS n FROM channels').get().n;
if (channelCount === 0) {
  db.prepare(
    'INSERT INTO channels (slug, name, description, created_at) VALUES (?, ?, ?, ?)'
  ).run('general', '一般讨论', '默认频道', Date.now());
}

// Backfill FTS for pre-existing posts (fresh DB has nothing to do).
const ftsCount = db.prepare('SELECT count(*) AS n FROM posts_fts').get().n;
const postCount = db.prepare('SELECT count(*) AS n FROM posts').get().n;
if (ftsCount === 0 && postCount > 0) {
  db.exec("INSERT INTO posts_fts(posts_fts) VALUES('rebuild')");
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
