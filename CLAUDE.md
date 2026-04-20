# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
JWT_SECRET=dev-secret-change-me npm start   # production-style server on :3000
npm run dev                                  # same, with node --watch
```

There is no build step, no linter, no test suite. The frontend is plain HTML/CSS/JS served statically from `public/`; the server is a single `server.js`.

**Syntax-check after edits:**

```bash
node -c public/app.js
node -e "require('./db.js')"   # also runs migrations end-to-end
```

**End-to-end smoke test** (the only way to verify behavior): start the server, then drive it with `curl` or a small Node script through the real flow — register → `/api/token` → `/api/posts` → `/api/posts/:id/comments` → `/api/posts/:id/reactions`. Sessions are cookie-based, so use `--cookie-jar` / `--cookie` with curl, or pass the Set-Cookie header through in Node.

**Admin bootstrap:** `sqlite3 data.db "UPDATE users SET is_admin = 1 WHERE username = 'you';"`.

## Architecture

**The one invariant: posts and comments have no join path back to `users`.** Read [README.md](README.md) for the full protocol; everything below assumes you already know that `posts.pseudonym = sha256(token)[:8]` and that no user_id is stored anywhere alongside content.

### Server (`server.js`, `db.js`)

- All prepared statements live in the `Q` object at the top of `server.js`. Add new queries there rather than inlining `db.prepare(...)` calls.
- `resolveToken(token)` is the only function that turns a plaintext posting token into a `{ tokenHash, pseudonym }`. All write endpoints must go through it — never trust a pseudonym from the client.
- Token-quota bumps happen inside `claimTokenSlotTx` (a `db.transaction`). Any new per-day-quota feature must follow the same pattern or the count can race.
- `rotate()` (every 10 min, also at startup) runs `DELETE FROM post_tokens WHERE expires_at < now`. Foreign-key CASCADE chains from `post_tokens.token_hash` → dependent tables (currently `reactions`) are how token-scoped state gets purged when a token expires. When adding a new table keyed by `token_hash`, use an FK with `ON DELETE CASCADE` — don't extend `rotate()` manually.
- Schema lives in `db.js` as one big `CREATE TABLE IF NOT EXISTS` block. When you **add a column** to an existing table, the `CREATE TABLE` clause becomes a no-op on pre-existing DBs, so also add a `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` migration block below it (see the `parent_id` backfill for the shape). Indexes on new columns must be created *after* the ALTER, not inside the main `db.exec()`.
- Deep-link SPA routes (`/p/:id(\d+)`) serve `public/index.html` unconditionally — they must not check whether the post exists, because that would leak existence to unauthenticated requesters.

### Client (`public/app.js`)

One file, no modules, ~700 lines. Reusable helpers at the top — always use them before reaching for raw DOM APIs:

- `el(tag, props, children)` — the only way to create elements. Never use `innerHTML` on user content.
- `$(sel)`, `$$(sel)` — document-scoped query shortcuts.
- `api(method, path, body)` — JSON fetch wrapper; throws on non-2xx with `data.error`.
- `getToken()` / `setToken()` / `clearToken()` — posting-token state in localStorage.

Rendering pipeline for post/comment bodies:

1. Raw text comes back from the API untouched.
2. `renderMarkdown(text)` parses a small markdown subset (bold, italic, inline+fenced code, links, lists, blockquotes, h1–h3) into a DOM fragment. It never runs `innerHTML` on user data.
3. Every plain-text run inside the markdown output passes through `renderTextWithMentions(text)`, which turns `@[a-f0-9]{8}` and `#<id>` into clickable chips.

**If you add a new text-display call site, go through `renderMarkdown` — don't call `renderTextWithMentions` directly, or markdown formatting will be bypassed.**

URL routing is client-side: `openThread(id)` pushes `/p/<id>`, `closeReader()` pushes `/`, a `popstate` handler re-renders. Deep-link paths are served by the server's SPA catch-all; the client then fetches `/api/posts/:id` and shows a not-found state if needed.

`@`/`#` autocomplete is wired via `attachMentionAutocomplete(fieldNode)`. **Must be called after the field is in the DOM** (the popup is inserted as the field's next sibling). For reply forms, that means attaching after `form.appendChild(ta)`, not during construction.

### Privacy model (do not violate)

When adding features, every new server-side row or response field gets checked against these rules:

- **No user_id next to content.** If a feature needs "is this mine?", derive it client-side from the token the client already holds. Don't add a lookup that returns per-user state in a read endpoint.
- **No new logging of pseudonyms or token hashes** beyond what the existing code does (which is nothing — `console.log` is only used for `rotate()` sweep counts and startup).
- **Token-scoped state cascades.** Anything keyed by `token_hash` must FK into `post_tokens(token_hash) ON DELETE CASCADE` so the 24h purge takes it with it.
- **Deep-link endpoints stay oblivious.** Any future server route that corresponds to a client-visible URL (like `/p/<id>`) must serve the same response regardless of whether the underlying record exists.

## Commit style

Imperative subject line under ~70 chars. Short body explaining the *why* and the privacy-relevant design choice if there is one. Co-Authored-By trailer with the model name (see recent commits — `git log -1 --pretty=format:'%B'`).
