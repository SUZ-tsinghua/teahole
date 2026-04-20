# anonforum

A login-gated discussion platform where **the server cannot link posts to users**.

## The idea

Two hard requirements pull in opposite directions:

- **Strict access control** — only logged-in users may read or post.
- **Full anonymity** — even the platform operator must not know who wrote
  a given post.

The common trick — "log in, then post under a pseudonym" — fails the second
requirement: the DB row says `posts.user_id = 42`.

This project separates **authentication** from **posting authority** via
short-lived, unlinkable tokens.

## Protocol

1. You register / log in with username + password. You get a long-lived
   **session cookie** — used only to prove you're a valid member.
2. You request a **posting token** (random 32 bytes). The server:
   - Stores only `sha256(token)` + expiry in `post_tokens`.
   - Stores on your user row only a per-day **counter** of how many tokens
     you have claimed today — never the token itself, never a mapping.
   - Returns the plaintext token to you **once**. You persist it client-side.
3. To post or comment you send `{ token, content }`. The server:
   - Hashes your token, looks up the row, checks expiry.
   - Writes a post with `pseudonym = token_hash[:8]` — no `user_id` column.
4. Every rotation sweep (10 min) the server deletes expired token hashes.
   After the configured TTL (default 24 h), the hash that linked "this
   post" to "a valid-at-the-time token" is gone.

### What's in the DB at any time

| table        | user-linked? | contains                               |
|--------------|--------------|----------------------------------------|
| `users`      | yes          | username, bcrypt hash, daily counter  |
| `post_tokens`| no           | `sha256(token)`, `expires_at`         |
| `posts`      | no           | `pseudonym`, title, content, created_at|
| `comments`   | no           | `pseudonym`, content, `post_id`       |

There is no join path from a row in `posts` or `comments` back to a row
in `users`.

## Limitations (be honest)

- **Timing correlation.** A malicious operator that keeps external logs
  (web-server access logs, network captures) can correlate
  "user X hit `/api/token` at 14:02:11" with "a post was made using
  some token at 14:02:14." True unlinkability would require something
  like a blind signature so the server signs a token it cannot recognize.
  This project does not do that — it just makes the *database* unlinkable.
- **Token loss.** Tokens live in `localStorage`. Clear your browser and
  the rest of today's posting quota is gone; you must request a new one
  (counting against your daily cap).
- **Abuse.** Daily token cap (default 5) limits sybils-within-a-user.
  Moderation is content-only: an admin can delete a post, but cannot
  deanonymize it.

## Running

```bash
npm install
JWT_SECRET=$(openssl rand -hex 32) npm start
# open http://localhost:3000
```

Env vars:

- `PORT` — default `3000`
- `JWT_SECRET` — **set this in production**; otherwise a random one is
  generated on boot and sessions reset on every restart.
- `TOKEN_TTL_HOURS` — default `24`
- `MAX_TOKENS_PER_DAY` — default `5`

### Making the first admin

```bash
sqlite3 data.db "UPDATE users SET is_admin = 1 WHERE username = 'you';"
```

Admins can `DELETE /api/posts/:id` to remove content. They cannot see
who posted it.

## Files

- `server.js` — Express app, routes, rotation.
- `db.js` — SQLite schema.
- `public/` — single-page frontend.
