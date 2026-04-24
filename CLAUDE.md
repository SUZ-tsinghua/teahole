# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and other agents working in this
repository. Humans: most of this is for you too, but the "Agent navigation"
section is specifically about how Claude Code searches and edits code.

## Commands

```bash
npm install
JWT_SECRET=dev-secret-change-me npm start   # production-style server on :3000
npm run dev                                  # same, with node --watch
npm run check                                # syntax-check + tsc --noEmit
npm run typecheck                            # tsc --noEmit on its own
```

There is no build step, no linter, no test suite. The frontend is plain
HTML/CSS/JS served statically from `public/`; the server is a single
`server.js`. KaTeX is vendored under `public/vendor/katex/` (woff2 fonts
only) so the strict CSP doesn't need a CDN exception.

**Verify after edits:** `npm run check` (fast — syntax check every JS file
plus `tsc --noEmit`). A pre-commit hook under `.githooks/pre-commit`
auto-runs this on `git commit` — wired up by `npm run prepare`, which sets
`core.hooksPath=.githooks`. Run `npm install` once after cloning to wire it.
GitHub Actions runs the same checks on push and PRs
(`.github/workflows/check.yml`).

**Type checking:** `tsconfig.json` has `allowJs: true, checkJs: false` so
plain JS parses without forcing annotations. Opt a specific file in by
adding `// @ts-check` at the top plus JSDoc — good for new/well-scoped files
that you want the compiler to police.

**End-to-end smoke test** (the only way to verify behavior): start the
server, then drive it with `curl` or a small Node script through the real
flow — register → `/api/token` → `/api/posts` → `/api/posts/:id/comments` →
`/api/posts/:id/reactions`. Sessions are cookie-based, so use
`--cookie-jar` / `--cookie` with curl, or pass the Set-Cookie header through
in Node.

**Admin bootstrap:** `sqlite3 data.db "UPDATE users SET is_admin = 1 WHERE username = 'you';"`.

## Architecture

**The one invariant: posts and comments have no join path back to `users`.**
Read [README.md](README.md) for the full protocol; everything below assumes
you already know that `posts.pseudonym = sha256(token)[:8]` and that no
user_id is stored anywhere alongside content.

### Server (`server.js`, `db.js`)

- All prepared statements live in the `Q` object in `server.js`
  (grep `SECTION: Q`). Add new queries there rather than inlining
  `db.prepare(...)` calls.
- `resolveToken(token)` (grep `SECTION: token-core`) is the only function
  that turns a plaintext posting token into a `{ tokenHash, pseudonym }`.
  All write endpoints must go through it — never trust a pseudonym from
  the client.
- Token-quota bumps happen inside `claimTokenSlotTx` (a `db.transaction`).
  Any new per-day-quota feature must follow the same pattern or the count
  can race.
- `rotate()` (every 10 min, also at startup; grep `SECTION: rotate+listen`)
  runs `DELETE FROM post_tokens WHERE expires_at < now`. Foreign-key
  CASCADE chains from `post_tokens.token_hash` → dependent tables
  (currently `reactions`) are how token-scoped state gets purged when a
  token expires. When adding a new table keyed by `token_hash`, use an FK
  with `ON DELETE CASCADE` — don't extend `rotate()` manually.
- Schema lives in `db.js` as one big `CREATE TABLE IF NOT EXISTS` block
  (grep `SECTION: schema`). When you **add a column** to an existing
  table, the `CREATE TABLE` clause becomes a no-op on pre-existing DBs,
  so also add a `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` migration
  block in `SECTION: migrations` (see the `parent_id` backfill for the
  shape). Indexes on new columns must be created *after* the ALTER, not
  inside the main `db.exec()`.
- Deep-link SPA routes (`/p/:id(\d+)`, `/b/:id(\d+)`, `/d/:id(\d+)`;
  grep `SECTION: routes:spa`) serve `public/index.html` unconditionally
  — they must not check whether the post/bulletin/doc exists, because
  that would leak existence to unauthenticated requesters.

### Client (`public/app.js`)

One file, no modules, ~2.3k lines. Reusable helpers at the top (grep
`SECTION: dom-helpers`) — always use them before reaching for raw DOM APIs:

- `el(tag, props, children)` — the only way to create elements. Never use
  `innerHTML` on user content.
- `$(sel)`, `$$(sel)` — document-scoped query shortcuts.
- `api(method, path, body)` — JSON fetch wrapper; throws on non-2xx with
  `data.error`.
- `getToken()` / `setToken()` / `clearToken()` — posting-token state in
  localStorage.

Rendering pipeline for post/comment bodies (grep `SECTION: markdown`):

1. Raw text comes back from the API untouched.
2. `renderMarkdown(text)` parses a small markdown subset (bold, italic,
   inline+fenced code, links, lists, blockquotes, h1–h3, `$…$` / `$$…$$`
   math) into a DOM fragment. It never runs `innerHTML` on user data.
3. Fenced code blocks go through `highlightInto(node, lang, code)` — a
   small homemade tokenizer keyed by `HL_LANG_ALIASES` → `HL_RULES` (grep
   `SECTION: syntax-highlight`). Output is `<span class="tok-*">` with
   colours driven by CSS vars (see `style/markdown.css`
   `SECTION: syntax-colors`). Adding a language means adding an entry in
   both maps plus a CSS token colour if it's a new class; unknown
   languages fall back to plain text.
4. Math blocks go through `renderMathInto(node, expr, displayMode)` — a
   thin wrapper around vendored `window.katex.render`. It always passes
   `throwOnError: false`, so bad LaTeX degrades to a red error span
   rather than blowing up rendering.
5. Every plain-text run inside the markdown output passes through
   `renderTextWithMentions(text)`, which turns `@[a-f0-9]{8}` and
   `#<id>` into clickable chips.

**If you add a new text-display call site, go through `renderMarkdown` —
don't call `renderTextWithMentions` directly, or markdown formatting will
be bypassed.**

URL routing is client-side (grep `SECTION: view-routing`): `openThread(id)`
pushes `/p/<id>`, `closeReader()` pushes `/`, a `popstate` handler
re-renders. Deep-link paths are served by the server's SPA catch-all; the
client then fetches `/api/posts/:id` and shows a not-found state if needed.

`@`/`#` autocomplete is wired via `attachMentionAutocomplete(fieldNode)`
(grep `SECTION: autocomplete`). **Must be called after the field is in the
DOM** (the popup is inserted as the field's next sibling). For reply forms,
that means attaching after `form.appendChild(ta)`, not during construction.

### Stylesheet layout (`public/style.css`, `public/style/*.css`)

`style.css` is a 19-line aggregator that `@import`s the real rules from
`style/*.css`, split by banner: `base` (theme vars — must load first),
`layout`, `auth`, `sidebar`, `reader`, `forms`, `dialog`, `markdown`,
`mobile` (media-query overrides — must load last). When adding new rules,
drop them in the module that matches the component, not at the bottom of
`style.css`. The whole thing still goes through one
`<link rel="stylesheet" href="/style.css">`.

All theme-aware values come from CSS custom properties defined in
`style/base.css` (grep `SECTION: theme-light` and `SECTION: theme-dark`).
Reuse those variables — don't hard-code colours.

### Privacy model (do not violate)

The top priority is always posting anonymity for regular users. A post or
comment must not be linkable back to a specific user, even by inference
from surrounding data, timing, or database raw materials. Assume an
attacker can read the full database: the design still must not leave a
path that ties content to an account.

When adding features, every new server-side row or response field gets
checked against these rules:

- **No user_id next to content.** If a feature needs "is this mine?",
  derive it client-side from the token the client already holds. Don't
  add a lookup that returns per-user state in a read endpoint.
- **No new logging of pseudonyms or token hashes** beyond what the
  existing code does (which is nothing — `console.log` is only used for
  `rotate()` sweep counts and startup).
- **Token-scoped state cascades.** Anything keyed by `token_hash` must FK
  into `post_tokens(token_hash) ON DELETE CASCADE` so the 24h purge takes
  it with it.
- **Deep-link endpoints stay oblivious.** Any future server route that
  corresponds to a client-visible URL (like `/p/<id>`) must serve the
  same response regardless of whether the underlying record exists.

## Agent navigation

This codebase is tuned for Claude Code's primary tool: the `Grep` tool
(ripgrep under the hood). If you're an agent, these conventions make
everything else cheap.

### `SECTION:` anchors and `FILE MAP` headers

Every large file starts with a `FILE MAP` comment block listing named
sections. Each section has a matching inline `SECTION: <name>` marker
inside the file. To jump to a section:

```
Grep pattern: "SECTION: token-core"   # or any other name from the map
```

Files with FILE MAP + inline SECTION markers (as of this writing):

- `server.js` — 22 sections (config → routes → rotate)
- `public/app.js` — 26 sections (constants → sidebar+init)
- `db.js` — 6 sections (bootstrap → housekeeping)
- `public/style/base.css` — theme/body/scrollbar sections
- `public/style/reader.css`, `sidebar.css`, `layout.css`, `markdown.css` —
  one section per component cluster
- `public/index.html` — header / auth-view / forum-view / dialogs

**When you add a new major block of code, add a matching SECTION marker
and update the FILE MAP at the top of the file.** The FILE MAP is the
one thing an agent reads before searching — keep it honest.

### File-size principle

One file up to ~2000 lines is easier for an agent to work in than a
tidy multi-file split. The cost of cross-file navigation (re-Read, resolve
imports, hunt for the caller) outweighs the context win of smaller files
until the file genuinely has multiple orthogonal concerns. Past ~2500
lines or when one file mixes clearly separable features, split by
capability (e.g. `markdown.js` for the renderer), not by layer
(`helpers.js` / `ui.js`). `public/app.js` is at ~2.3k lines and is
intentionally not split — the SECTION anchors do the job the extra files
would do.

### Grep cheatsheet

| What you want | Grep pattern |
|---|---|
| Any section in any file | `SECTION:` |
| A specific section | `SECTION: <name>` (e.g. `SECTION: Q`) |
| All HTTP routes | `^app\.(get\|post\|put\|delete\|patch)` in `server.js` |
| All prepared statements | after `SECTION: Q`, every key is a `db.prepare(` |
| LocalStorage keys | `teahole\.` in `public/app.js` |
| CSS variable definitions | `SECTION: theme-light` in `public/style/base.css` |
| Token derivation | `SECTION: token-core` in `server.js` |
| Rendering pipeline | `renderMarkdown\|highlightInto\|renderMathInto\|renderTextWithMentions` |
| Privacy-sensitive spots | `CLAUDE\.md\|privacy\|token_hash` |

### Endpoint index

All HTTP routes live in `server.js`, grouped by `SECTION: routes:*`:

- `routes:auth` — `POST /api/send-code /register /login /logout`, `GET /api/me`
- `routes:token` — `POST /api/token`
- `routes:posts` — `GET/POST /api/posts`, `GET/DELETE /api/posts/:id`,
  `POST /api/posts/:id/reactions`, `POST/PUT/DELETE /api/posts/:pid/comments[/:id]`
- `routes:uploads` — `POST/GET /api/uploads[/:name]`
- `routes:saved` — `GET/POST/DELETE /api/saved/:id`, `GET/POST/DELETE /api/saved-docs/:id`, `GET/POST/DELETE /api/followed/:id`
- `routes:channels` — `GET/POST/DELETE /api/channels[/:id]`, `GET/POST /api/channel-prefs`, `GET /api/channel-unread`, `POST /api/channels/:id/seen`
- `routes:bulletins` — `GET/POST/PUT/DELETE /api/bulletins[/:id]`
- `routes:docs` — `GET/POST /api/docs`, `GET/PUT/DELETE /api/docs/:id`
  (wiki-style shared markdown pages; any valid token can edit, delete is
  creator-or-admin, `created_token_hash` orphaned by rotate like posts)
- `routes:search` — `GET /api/search`
- `routes:mentions` — `POST /api/mentions`, `GET /api/feed.xml`
- `routes:spa` — `GET /p/:id /b/:id /d/:id` (deep-link catchalls; must stay oblivious)

### Client-side state index

All localStorage keys are declared at the top of `public/app.js`
(`SECTION: constants`) and namespaced under `teahole.*`:

- `teahole.token` — current posting token (`{ token, pseudonym, … }`)
- `teahole.theme` — `'light' | 'dark'`
- `teahole.myReactions` — locally-tracked reactions per post/pseudonym
- `teahole.mentionsSeen` — per-target read-cursor for the mentions inbox
- `teahole.helpSeen` — help-dialog dismissal flag
- `teahole.sidebarWidth` — sidebar drag width

### Rendering pipeline entry points (client)

Use these in this order — don't reach for lower-level helpers first:

1. `renderMarkdown(text)` — for any user text (post/comment body, bulletin)
2. `renderInline(text, parent)` / `renderInlineWithBreaks` — only inside
   custom block-level renderers
3. `renderTextWithMentions(text)` — only inside the markdown renderer;
   do NOT call this directly from UI code

## Commit style

Imperative subject line under ~70 chars. Short body explaining the *why*
and the privacy-relevant design choice if there is one. Co-Authored-By
trailer with the model name (see recent commits —
`git log -1 --pretty=format:'%B'`).
