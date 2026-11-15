# Truth model

## What the index contains

| Layer | Scope | Content |
| --- | --- | --- |
| `verified` | `verified_truths` | conclusions you wrote with `save_verified` (section-level FTS) |
| `protocol` | `protocol_catalog`, `protocol_docs` | 2020 client commands (cmd/name/request/response/kind) + `PROTOCOL.md`/endpoints notes |
| `web` | `code_anchors` | 531 deduplicated Web client resources (formatted, line-accurate) |
| `electron` | `code_anchors` | 8500+ desktop renderer/preload/JSSDK/worker files from `webcontent/*.asar` |

Index scale depends on the client version used to build the pack (current reference:
2020 commands, 237,729 anchors, 12 verified sections, 17 protocol doc sections).

`code_anchors` cover: OpenAPI paths, URLs, IPC channels, `tt.*`/`h5sdk.*`/`LarkAPI.*`, card schema
keys, error codes, i18n keys, protocol constants, command names.

## Coordinates and reading

- Search returns `file_path` **relative to the formatted corpus** (e.g.
  `electron/asar/messenger/35983/f7adb73684.js`) plus `line_number`.
- Pass that path verbatim to `read_slice`; do not prepend anything.
- `verified_truths/<slug>.md` paths are also readable; sections carry `line_start`/`line_end`.
- `read_slice` is bounded (default 12 lines of context, `max_lines <= 120`). Reading a whole
  formatted file is forbidden — the corpus is ~14M lines.

## Writing knowledge (`save_verified`)

File format (one topic per file):

```md
---
topic: ...
verified_at: ...
source: probe | reverse | doc | console
confidence: high | medium | low
tags: [...]
---

## 结论
...

## 证据
- probe log_id / URL / file:line
```

Rules:

- Only verified facts. Guesses stay in the conversation.
- Include a minimal reproduction (request/response/JSON snippet) so the conclusion is actionable.
- Never write credentials, tokens, or full auth headers.
- After writing, `lark_truth_search(scope="verified")` must hit immediately (SQLite incremental
  sync). If sync fails, the Markdown is still saved and will be indexed on the next rebuild.

## Storage layout

```
~/.larkit/
├── data/
│   ├── truth.db              # SQLite FTS5 index
│   ├── truth.meta.json       # build stats
│   ├── formatted/            # optional code corpus (search works without it)
│   ├── cache/                # docs, tokens, screenshots, login logs
│   └── console-api-recipes.json
├── verified_truths/          # user-owned Markdown knowledge
├── cli/                      # durable CLI install (npm prefix)
├── downloads/                # cached truth/code pack archives
├── install.json              # bootstrap state + seed hashes
├── mcp.json                  # MCP client config
├── config.json               # user-level config (profiles/apps)
└── credentials.json          # auth profiles
```

Engineers can override `LARKIT_HOME`, `LARKIT_DATA_DIR`, `LARKIT_VERIFIED_DIR`. A git checkout
continues to use `<repo>/.larkit-data` and `<repo>/verified_truths` for `pnpm index` / `pnpm verify`.

## Installing / updating

```bash
npx larkit                  # truth pack (truth.db + code corpus) + skill + CLI + MCP config
npx larkit update           # refresh only outdated pieces (truth check runs on every command)
npx larkit status --json
```

Truth pack sources, in priority order:

1. `--pack=<manifest.json|dir|.tar.gz|https://...>`
2. `--from-assets --deb=... --web-dump=...` (local build; Linux + `dpkg-deb`)
3. `--channel[=<url>]` — the official channel, also the default
4. `LARKIT_PACK_MANIFEST`

There is exactly one archive (`tiers.full`, ~161 MB): `truth.db` + verified seeds + `formatted/`.
Nothing is optional — installing always brings the code corpus with it.

Seed `verified_truths` files are content-hashed. On update they are replaced only if unmodified;
user edits are preserved.

## Rebuilding (maintainers)

```bash
pnpm index                                  # full pipeline into .larkit-data
node scripts/build-index.mjs --only=protocol,db
node scripts/build-index.mjs --only=anchors,protocol,db
npx larkit pack build --out=dist/truth-pack --tag=2026.11.15 --base-url=https://host/path
node scripts/publish-pack.mjs --pack-dir=dist/truth-pack --base-url=https://host/path
npx larkit pack verify dist/truth-pack/manifest.json
```

## Boundaries

- Desktop main process is native (`feishu`/`libiron`); there is no `app.asar`. The corpus covers
  renderer/preload/JSSDK/worker/protocol assets only.
- i18n bundles are excluded from formatting; query specific keys if needed.
- Official docs endpoints and console APIs are public but may rate-limit or change; caches and
  `browser_fallback` recordings are the fallback.
- Private protocol routes and console internals drift with client versions. Record the version you
  verified against.
