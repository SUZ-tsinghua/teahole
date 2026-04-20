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

-- Posts carry an opaque per-token pseudonym, never a user_id.
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pseudonym TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  parent_id INTEGER,
  pseudonym TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
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
`);

// Back-fill parent_id on databases created before threading was added.
// (The CREATE TABLE above is a no-op when the table already exists, so
// the column has to be added via ALTER. The index must be created after.)
const hasParentId = db
  .prepare("PRAGMA table_info(comments)")
  .all()
  .some((c) => c.name === 'parent_id');
if (!hasParentId) {
  db.exec(
    'ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE'
  );
}
db.exec('CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)');

module.exports = db;
