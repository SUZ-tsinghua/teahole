# teahole / 茶园树洞

A login-gated discussion platform where **regular members stay unlinkable by default, while admins can speak publicly under their usernames**.

## The idea

Two hard requirements pull in opposite directions:

- **Strict access control** — only logged-in users may read or post.
- **Default unlinkability** — regular member posts should not join back to
  an account in the DB, while admins can intentionally post under a public
  handle so members can `@` them for feedback.

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
   - Writes a post with `pseudonym = token_hash[:8]` for regular members,
     or `pseudonym = username` for live admins — still no `user_id` column.
4. Every rotation sweep (10 min) the server deletes expired token hashes.
   After the configured TTL (default 24 h), the hash that linked "this
   post" to "a valid-at-the-time token" is gone.

### What's in the DB at any time

| table        | user-linked?              | contains                                    |
|--------------|---------------------------|---------------------------------------------|
| `users`      | yes                       | username, bcrypt hash, daily counter        |
| `post_tokens`| no                        | `sha256(token)`, `expires_at`               |
| `posts`      | members: no / admins: yes | `pseudonym`, title, content, created_at     |
| `comments`   | members: no / admins: yes | `pseudonym`, content, `post_id`             |

Regular-member rows in `posts` / `comments` still have no join path back
to `users`. Admin rows intentionally store the public username so members
can mention them directly.

## Limitations (be honest)

- **Timing correlation.** A malicious operator that keeps external logs
  (web-server access logs, network captures) can correlate
  "user X hit `/api/token` at 14:02:11" with "a post was made using
  some token at 14:02:14." True unlinkability would require something
  like a blind signature so the server signs a token it cannot recognize.
  This project does not do that — it just makes the *database* unlinkable.
- **Admin posts are public.** If `is_admin = 1`, new posts/comments render
  under that username so members can `@admin` for feedback. That is an
  explicit product tradeoff, not an accident.
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

Admins can `DELETE /api/posts/:id` to remove content. Their own
posts/comments render under their usernames; everyone else still posts
under token pseudonyms.

## Files

- `server.js` — Express app, routes, rotation.
- `db.js` — SQLite schema.
- `public/` — single-page frontend.

## Roadmap

Only features that **preserve default unlinkability for regular members**
are in scope. Admin public handles are the one deliberate exception so
people can route feedback to a real moderator identity.

### Shipped

- [x] Threaded comments — replies nest under a parent comment via
      `comments.parent_id` (validated to belong to the same post).
- [x] `@<pseudonym>`, `@<admin-username>`, and `#<post-id>` mentions —
      autocomplete in every textarea/title input, clickable chips that
      scroll+flash the target or open the referenced thread.
- [x] Post IDs — every post shows a `#<id>` badge so it's referenceable.
- [x] Deep-link routing — `/p/<id>` URLs, Back/Forward works, refresh
      preserves the open thread. The SPA catch-all serves `index.html`
      regardless of whether `id` exists, so it doesn't leak existence.
- [x] Markdown rendering — client-side only (bold, italic, code, fenced
      blocks, links, lists, blockquotes, h1–h3). Raw markdown is stored; no
      HTML ever reaches the server.
- [x] Emoji reactions — 6 fixed kinds (👍❤️😂😮😢🎉). One token = one vote
      per post per kind. Keyed by full `token_hash` with FK cascade from
      `post_tokens`, so reactions vanish when the token expires. "Did I
      react?" is tracked client-side in localStorage — the server never
      returns per-user reaction state.
- [x] **Tags** — posts carry lowercase `a-z0-9_-` tags (up to 5 per post,
      24 chars each). `post_tags(post_id, tag)` with FK cascade; the
      sidebar surfaces a tag cloud, clicking a tag filters the feed via
      `GET /api/posts?tag=...`. Tags are stored on the post, not per
      user — no leak.
- [x] **Full-text search** — FTS5 virtual table `posts_fts` over
      title+content, kept in sync by INSERT/UPDATE/DELETE triggers on
      `posts`. Uses the `trigram` tokenizer so CJK queries work too
      (minimum 3 characters). No query logging — the search term never
      hits disk beyond the MATCH call itself.
- [x] **Edit / delete your own content** — `posts.token_hash` and
      `comments.token_hash` are compared to `sha256(submitted_token)`
      with equality guards in the `UPDATE` / `DELETE` SQL itself. Once
      the token expires and `post_tokens` purges its row, the stored
      hash no longer joins to anything — edit/delete becomes impossible,
      which is also when the content becomes fully unlinkable.
- [x] **Per-handle `@mention` inbox** — posts/comments are scanned for
      `@[a-f0-9]{8}` plus live admin usernames at write time and pointers
      are stashed in `mentions(target_pseudonym, post_id, comment_id,
      created_at)`. `POST /api/mentions` returns rows addressed to the
      caller's token pseudonym (regular members) or session username
      (admins) from the last TTL window. `rotate()` also purges
      `mentions.created_at < now - TTL` so a new token holder that
      coincidentally takes the same pseudonym prefix never sees mentions
      meant for the previous one. Edits re-derive the pointer list;
      deletes cascade via FK.
- [x] **Session-gated RSS** — `GET /api/feed.xml` serves RSS 2.0 of the
      last 50 posts to any authenticated caller. No per-user tailoring,
      no cursor, nothing bound to the fetcher's identity.

### To implement

- [ ] **Bulletin board (`公告栏`)** — a dedicated notices surface for
      forum-wide updates, rules, and moderator announcements. Only admins
      can create or edit bulletin entries. Keep it separate from anonymous
      post authorship so regular-member content stays unlinkable by
      default.
- [ ] **Post ID search** — let the search UI accept `#<post-id>` (and
      optionally raw numeric IDs) as a direct jump / lookup path, so
      referenced posts are easier to open without scrolling the feed.
- [ ] **Image uploads (`上传图片`)** — allow posts/comments to attach
      images, but strip EXIF and other identifying metadata on ingest and
      keep the storage model content-scoped rather than user-scoped so
      uploads do not quietly reintroduce account-to-content linkage.
- [ ] **Role-based posting mode** — admins should not need to claim
      posting tokens and must always post non-anonymously under their
      usernames; regular members should continue to require tokens and may
      only post anonymously.
- [ ] **Mobile web (`移动端网页`)** — make the forum work well on phones,
      with a touch-friendly layout, readable compose/thread views, and the
      same core flows (login, browsing, posting, replying, moderation)
      available without desktop-only interactions.
- [ ] **Saved posts (`收藏 posts`)** — let logged-in users bookmark posts
      against their account rather than against a posting token, so saved
      items survive token rotation and remain visible after refreshing or
      claiming a new token. Keep this as reader-side state only: it should
      not reveal anything about authorship.
- [ ] **Pinned channels (`置顶 channels`)** — let each user pin the
      channels they care about most so those channels stay at the top of
      the sidebar or channel picker. This should be a per-user reading
      preference, not token-scoped state.
- [ ] **Channel unread / new-post markers (`频道未读 / 新帖标记`)** —
      show which channels have new activity for each logged-in user so
      they can quickly see where fresh discussion is happening. This
      should be account-scoped reading state, not author-linked state.
- [ ] **Followed threads (`站内关注帖子`)** — let users follow specific
      posts and get in-site reminders when those threads receive new
      comments, without relying on email or push notifications. Keep this
      as reader-side/account-side state only; it should not expose
      anything about who authored the content.
- [ ] **Muted / hidden channels (`频道静音 / 隐藏`)** — let users hide or
      down-rank channels they do not care about, complementing pinned
      channels with a per-user “show me less of this” preference.
- [ ] **Onboarding / documentation (`新手指引 / documentation`)** —
      provide a clear newcomer guide that explains how login, posting
      tokens, anonymity, admin visibility, channels, and mentions work, so
      first-time users can understand the product model before posting.
- [ ] **Project rename to `teahole` / `茶园树洞`** — rename the product
      from `anonforum` / `匿名论坛` to `teahole` / `茶园树洞`, reflecting the
      institute nickname “茶园” for `交叉信息研究院`. Update UI copy,
      documentation, and other user-facing naming consistently.

### Explicitly out of scope (would break the model)

- Email/push notifications across tokens — links your account to your
  posts.
- "Posts by this user" pages — only safe within a single token's lifetime
  (which is already trivially linkable to the caller's own client).
- Server-side "did I react?" in read endpoints — forces the server to map
  reads to identities.
