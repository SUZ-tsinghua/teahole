<p align="center">
  <img src="assets/banner.jpg" alt="teahole banner" width="100%">
</p>

# teahole / 茶园树洞

> English · [中文](README.md)

> **Internal access only.** To keep this a closed circle for 茶园, only emails
> on the allowlist can register. If you'd like to try it out, reach out to me
> by email or WeChat.

A login-gated internal community where **regular members stay unlinkable by
default, while admins can speak publicly under their usernames**.
Live at <https://teahole.fly.dev>.

The two main surfaces are:

- **Anonymous posting** — posts, comments, reactions, and polls are written
  with 24-hour tokens, so regular-member content does not join back to an account.
- **Shared documents** — wiki-style pages use the same Markdown / LaTeX /
  image tools; any valid token can edit, while accounts only handle access
  control and reader-side preferences.

## The idea

Two hard requirements pull in opposite directions:

- **Strict access control** — only logged-in members may read, post, or edit shared docs.
- **Default unlinkability** — regular members' posts should not join
  back to an account in the database.

The common trick — "log in, then post under a pseudonym" — fails the
second: the row `posts.user_id = 42` gives it all away. teahole decouples
**authentication** from **write authority** using short-lived tokens
with no stored mapping to an account.

## How the web app runs

1. **Register / log in**
   - Register with an email address. The server only accepts emails
     whose SHA-256 appears in an in-memory allowlist loaded from a
     gitignored file — raw emails are never written to the DB or logs.
   - A 6-digit verification code is emailed (Gmail SMTP) before you set
     a password.
   - Logging in gives you a long-lived session cookie, used only to
     prove you're a valid member.
2. **Claim a write token**
   - Click "get / rotate token" in the sidebar to receive a random 32-byte
     token. The server stores only `sha256(token)` + expiry, plus a
     per-day **counter** on your user row — never the plaintext, never a
     mapping to your account.
   - The plaintext is returned to you once. The client puts it in
     `localStorage`.
3. **Post / comment / edit docs / react / vote**
   - Writes carry the token. The server hashes it, looks it up, and
     writes the row with:
     - regular member: `pseudonym = sha256(token)[:8]`, an 8-char hex ID.
     - admin: `pseudonym = username`, signed with the real handle.
   - No `user_id` column ever sits next to posts or comments. Shared docs
     keep public creator / last-editor pseudonyms, but no user ID.
4. **Tokens expire**
   - A sweep every 10 min deletes expired hashes (default TTL 24 h).
     The moment a token expires, the DB loses the link between its
     posts/comments and any valid-at-the-time credential — and you also lose
     the ability to edit/delete that content. That's the default state.
   - Shared documents do not disappear when the creator token expires. The
     creator-token hash is nulled out; after that only admins can delete the
     doc, while any valid token can still edit it.

## Features

### Content

- **Anonymous posts** — posts, threaded comments, reactions, and polls all
  use short-lived tokens; regular members leave only a public pseudonym, not
  an account foreign key.
- **Shared docs** — `/d/<id>` pages work like a small wiki, with channels,
  bookmarks, and full-text search. Any valid token can edit; the live creator
  token or an admin can delete.
- **Markdown rendering** — bold, italic, inline / fenced code, links,
  lists, blockquotes, h1–h3. Raw markdown is stored in the DB; HTML is
  only produced in the browser.
- **Syntax highlighting** — fenced code blocks auto-colour. Supports
  js/ts, Python, C-family (C/C++/Rust/Go/Java/Swift/Kotlin), SQL, Shell,
  JSON, CSS. Unknown languages render as plain text.
- **LaTeX math** — inline `$E=mc^2$` and display blocks delimited by
  `$$`, rendered by KaTeX (vendored, same-origin; no CDN).
- **Image uploads** — EXIF and other metadata are stripped on ingest;
  images are addressed by content hash, not per user.
- **Full-text search** — posts search over title / body / comments; docs
  search over title / body. Longer queries use FTS5 trigram rank; shorter
  queries fall back to literal substring scans, so there is no minimum query
  length. Search terms are never logged.
- **ID references** — posts render as `#post123`, shared docs as `#doc42`;
  typing those in body text makes clickable chips. Legacy `#123` still means
  post `123`, and the search box treats `#123` as a direct post jump.

### Interaction

- **Threaded comments** — replies nest under a parent comment.
- **`@` / `#` autocomplete** — every text input suggests
  `@abc12345` (pseudonyms), `@admin` (admin usernames), or `#post123`;
  submitted `#doc42` text also turns into a clickable doc chip.
- **Mentions inbox** — the "提醒" panel surfaces `@` hits addressed to
  your current pseudonym (or admin username) from the last TTL window.
- **Reactions** — 👍 / 👎 on posts and comments, one token = one vote per
  target per kind.
  Cascades away via foreign key when the token expires. Whether *you*
  reacted is tracked only in localStorage; read endpoints never return
  per-user reaction state.
- **Polls** — a post may include 2–10 options. Each token can vote once per
  poll; per-token vote rows expire with the token, while aggregate option
  totals remain.
- **Edit / delete your own content** — authorised by the submitted
  token. Once the token expires and `post_tokens` purges its row, the
  stored `token_hash` no longer joins to anything, so edit/delete
  becomes impossible — which is also exactly when the content becomes
  fully unlinkable.

### Organisation

- **Channels** — topic sections created by admins. Each user can
  **pin**, **mute**, and see **unread counts** per channel.
- **Saved posts / docs** — ★ bookmarks attached to the account, so they
  survive token rotation.
- **Bulletin board** — admin-only announcements pinned to the sidebar.
- **RSS** — `/api/feed.xml` serves the last 50 posts to any authenticated
  caller. No per-user tailoring, no cursor.
- **Deep links** — posts use `/p/<id>`, bulletins `/b/<id>`, and shared docs
  `/d/<id>`. The SPA catch-all returns `index.html` regardless of whether
  the id exists, so existence is not leaked.

### Surfaces

- **Desktop + mobile web** — single SPA with a separate mobile layout.
- **Dark / light theme** — toggle in the header; follows OS preference.

## What's in the DB at any time

| Table           | User-linked?                    | Contents                                    |
|-----------------|---------------------------------|---------------------------------------------|
| `users`         | yes                             | email, bcrypt hash, daily token counter, password version |
| `post_tokens`   | no                              | `sha256(token)`, `expires_at`               |
| `posts`         | members: no / admins: yes       | `pseudonym`, title, body, channel, ts, temporary `token_hash` |
| `comments`      | members: no / admins: yes       | `pseudonym`, body, `post_id`, `parent_id`, temporary `token_hash` |
| `posts_fts` / `comments_fts` / `docs_fts` | no (derived indexes) | full-text indexes over titles / bodies / comments |
| `reactions`     | no (FK to `token_hash`, cascade) | post / token / kind                        |
| `comment_reactions` | no (FK to `token_hash`, cascade) | comment / token / kind                |
| `polls` / `poll_options` | no                     | post, question, option text, aggregate votes |
| `poll_votes`    | no (FK to `token_hash`, cascade) | poll / token / selected option              |
| `mentions`      | no (target is a pseudonym)      | target, source post/comment, ts             |
| `docs`          | no (public pseudonym + temporary token hash only) | title, body, channel, creator / editor pseudonym |
| `saved_posts`   | yes (by account)                | user, post                                  |
| `saved_docs`    | yes (by account)                | user, shared doc                            |
| `channels`      | no                              | slug, name, description                     |
| `user_channel_prefs` | yes (by account)           | user, channel, pin/mute/read-watermark      |
| `bulletins`     | yes (admin-authored)            | admin-authored announcements                |
| `email_codes`   | yes (short-lived registration flow) | email, code hash, expiry, attempts       |
| `revoked_sessions` | no (short-lived session cleanup) | logged-out JWT `jti`, expiry              |

Regular-member rows in `posts` / `comments` still have no join path
back to `users`. Shared docs are collaborative material: they keep public
pseudonyms and a temporary delete-gate token hash, not user IDs. Reader-side
preferences (saved / channel pin / mute / read-watermarks) are deliberately
account-scoped because they're about reading, not authorship.

## Known limits

- **Timing correlation.** An operator with access to web-server logs or
  network captures can correlate "user X hit `/api/token` at 14:02:11"
  with "a post was made by some token at 14:02:14." True
  unlinkability would need something like a blind signature so the
  server signs a token it can't recognise. This project only makes the
  **database** unlinkable.
- **Admin posts are public.** Deliberate product tradeoff, not a bug.
- **Shared docs are collaborative.** A doc shows public creator /
  last-editor pseudonyms; use docs for durable shared notes, not as a
  replacement for anonymous posts.
- **Token loss.** Tokens live in `localStorage`. Clear your browser and
  today's remaining posting quota goes with it; you have to claim a new
  token (counting against the daily cap).
- **Abuse.** The daily token cap (default 5) bounds sybils-within-a-user.
  Admins can delete content but cannot de-anonymise anyone.

## Running locally

```bash
npm install
JWT_SECRET=$(openssl rand -hex 32) npm start
# open http://localhost:3000
```

For a throwaway local demo, explicitly enable debug account seeding:
`DEV_SEED_USERS=1 JWT_SECRET=$(openssl rand -hex 32) npm start`. This resets
the `users` table and creates `admin@example.com / admin1234` plus
`user@example.com / user1234`. **Never set this in production.**

Environment variables:

| Var                  | Default               | Purpose                                            |
|----------------------|-----------------------|----------------------------------------------------|
| `PORT`               | `3000`                | HTTP port                                          |
| `JWT_SECRET`         | random at boot        | **Set this in production** — otherwise sessions reset on every restart. |
| `TOKEN_TTL_HOURS`    | `24`                  | Write / posting-token lifetime                     |
| `MAX_TOKENS_PER_DAY` | `5`                   | Per-account daily token cap                        |
| `GMAIL_USER`         | —                     | Gmail address that sends verification codes        |
| `GMAIL_APP_PASSWORD` | —                     | Google app password (not your login password)      |
| `GMAIL_FROM`         | —                     | Override the sender display name                   |
| `DEPT_ALLOWLIST_FILE`| `./dept-allowlist.txt` | Path to the registration allowlist                |
| `TRUST_PROXY`        | —                     | Set to `1` or a CIDR behind a proxy so `req.ip` reads `X-Forwarded-For`. |
| `DEV_SEED_USERS`     | —                     | Local debug only: `1` resets and seeds debug users; never set in production. |

Without `GMAIL_USER` / `GMAIL_APP_PASSWORD` the verification code is
logged to the server console — convenient for local dev.

### Making the first admin

```bash
sqlite3 data.db "UPDATE users SET is_admin = 1 WHERE username = 'you';"
```

### Registration allowlist

List allowed email addresses, one per line, in `dept-allowlist.txt`
(`#` starts a comment). Missing file = registration fully disabled.
The server `stat`s it every 2 s, so edits take effect without a restart.

## Deploying to fly.io

`Dockerfile` and `fly.toml` ship with the repo; production is at
<https://teahole.fly.dev>. First-time deploy:

```bash
fly launch --no-deploy
fly volumes create teahole_data --region sin --size 1
fly secrets set \
  JWT_SECRET=$(openssl rand -hex 32) \
  GMAIL_USER=you@gmail.com \
  GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx'
fly ssh console -C 'sh -c "cat > /data/dept-allowlist.txt"' < dept-allowlist.txt
fly deploy
```

Subsequent releases: `git commit … && fly deploy`.

The SQLite file lives on the mounted volume, so the app is pinned to a
single machine (`min_machines_running = 1`, auto-stop off) — running
more than one instance would fork the database.
