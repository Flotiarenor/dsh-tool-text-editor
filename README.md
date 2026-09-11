# dsh-tool-text-editor

[中文](README.zh.md) | English

Model-facing tools for [DeepSeek Harness](https://github.com/deepseek-ai) (dsh) that edit text
files **byte-faithfully**: `edit_text` and `write_text`.

They exist because the built-in tools lose Windows file conventions:

| Case (file is UTF-8 **BOM + CRLF**) | built-in `edit` | built-in `write` | this plugin |
|---|---|---|---|
| change one line | CRLF kept / **BOM lost** | — | BOM + CRLF kept |
| full overwrite | — | **BOM lost + CRLF flattened to LF** | BOM + CRLF kept |

`@deepseek-ai/dsh-fs-local` has no BOM handling at all (Node's `TextDecoder` strips a leading BOM
byte by default) and `writeText` does not restore a file's line-ending style.

On top of fidelity: **unified diffs** (with a `dry_run` preview), **automatic backups**, an **edit
ledger**, **`grep` / `lines` anchors** so old text never has to be copied by hand, **ambiguity
refusal**, **near-miss candidates** when an anchor does not match, and a **token-budgeted result
text**: the model sees one stat line plus a line-budgeted diff body, while the full diff goes to the
UI card (see "Result text and the token budget").

## Implementation and requirements

The implementation is **in-process Node** (`lib/core.mjs`): `node:` builtins only, no subprocess, no
build step, no third-party package.

| Requirement | Notes |
|---|---|
| Node | **The only dependency** — no interpreter, no external runtime, no process-startup cost per call. |

The package installs nothing of its own. Its single `peerDependencies` entry, `@deepseek-ai/dsh-tools`,
is the host contract — "needs this dsh or newer" — and resolves from the dsh installation rather than
being installed beside the plugin.

## Install

### Option 1 — preset (recommended, tightly scoped)

Only sessions that select this preset see the two tools. Run this from the root of a clone of this
repository:

```powershell
node scripts/install-preset.mjs
# flags: --id <preset-id> (default texteditor) / --base <shipped-preset> (default standard)
#        / --force / --dry-run / --from <agent.cordis.yml path>
```

Then restart `dsh web` and start a new session on preset `texteditor`; a preset is a session-creation
fact, so a running session cannot switch to it.

### Option 2 — install into the profile (available to every session)

`dsh plugin add` accepts several kinds of source, and every one of them works here: the package is
prebuilt, dependency-free ESM, so there is no `prepare`/`build` step to authorize or run.

| Source | Command |
|---|---|
| a local checkout | `dsh plugin --profile web add link:<absolute-path-to-this-checkout>` |
| npm, once published | `dsh plugin --profile web add @flotiarenor/dsh-tool-text-editor` |
| a packed tarball | `pnpm pack`, then `dsh plugin --profile web add ./<the-file-it-printed>.tgz` |
| a git repository (tracks the default branch) | `dsh plugin --profile web add github:Flotiarenor/dsh-tool-text-editor` |

Verify the layer without starting anything, then restart:

```powershell
dsh --profile web --dump-config   # look for the "# == @flotiarenor/dsh-tool-text-editor" layer
```

The tool names do not collide with the built-ins, so a host-plane insert is safe. The trade-off is
that both tools (and their guidance section) show up in **every** session. Uninstall with
`dsh plugin --profile web remove @flotiarenor/dsh-tool-text-editor`.

Both installs may coexist: the preset layer shadows the host layer with an identical definition.

## Tools

### `edit_text` — targeted replacement

`file_path` and `new_text` are required; give **exactly one** anchor: `old_text` (literal, copied from
`read`), `grep` (regex; the matched line/block including its trailing newline), or `lines` (e.g.
`"263:270"`). `mode` is `replace` (default) / `after` / `before` / `append` / `prepend`; also `count`
(require exactly N occurrences and replace all), `nth` (k-th occurrence), `strict`, `diff` (`auto` /
`full` / `none`), `dry_run`, `note`. `count` and `nth` are mutually exclusive.

### `write_text` — create or fully replace a file

`file_path` + `content` (plus the same `diff` / `dry_run` / `note`); creation needs no flag, an
overwrite is backed up first, and a brand-new file follows the **majority** line-ending style of its
siblings (same extension first) with no BOM by default.

Both **write by default** (like the built-ins); pass `dry_run: true` to preview.

### Result text and the token budget

Tool results land in the **append-only session history, which is never prefix-cached**, so every byte
returned per call accumulates. The result is therefore split into layers:

| Layer | Content | Where it goes |
|---|---|---|
| Model-facing (`brief` / `diff`) | warnings + one stat line (e.g. `replace@60 +1/-1`) + a budgeted diff body (0 context lines) | the model context |
| Full record (`stdout`) | path header, the complete diff with context lines, the backup name | UI / logs / human triage |
| UI card (`presentationMeta`) | the same `{ path, oldText, newText }` hunk list the built-in `edit` / `write` project | the Web UI, never the model context |

- The path appears **exactly once** in the model-facing text, and the backup filename is no longer
  echoed (it stays in `stdout` and in the ledger).
- The body is returned only when the change is genuinely small (`diff: auto`, threshold
  `maxDiffLines`); otherwise the model gets the stat line plus a one-line hint and decides for itself
  whether to `read`. `diff: full` forces the body, but **it is still capped** — uncapped, a 400-line
  rewrite echoes 7.5k tokens straight back (a measured ~1.0x amplification of the content just sent).

## Deliberate limitations

These are design choices, not defects to be fixed; check them against your use case before relying on
the tools.

- **Writes bypass `ctx.fs`.** The file is written by the plugin itself, so the fs-observation policy
  (read-before-write, version freshness), the sandbox, `sandbox_permissions` escalation and Windows
  DACL preservation are all skipped. The atomic write is the plugin's own (same-directory temp file +
  fsync + rename) and the diff card comes from its own `presentationMeta` (the built-ins project the
  `ctx.fs` `before` / `after` instead).
- **Line anchors are not content-verified.** `lines` and `before` / `after <line>` locate text by line
  number alone: a wrong number does not fail, it edits somewhere else. When the anchor has to be
  verifiable, use `old_text` or `grep`.
- **Per-target serialization is per process.** An in-process queue per target plus an atomic write
  keeps parallel tool calls from overwriting each other, but another dsh instance, an editor or any
  other process writing the same file still can, and external changes are not detected.
- **UTF-8 text only.** Files containing NUL bytes (binary) or invalid UTF-8 are refused, as are paths
  inside `.git/` or `.dsh/` and paths outside the workspace.

## Configuration

There is no Config schema: the preset row's `config:` mapping is passed through as-is.

| Key | Default | Meaning |
|---|---|---|
| `backup` | `true` | copy the previous content into `artifactsDir/backups` before writing |
| `ledger` | `true` | append a JSONL record to `artifactsDir/edits.log` |
| `artifactsDir` | `<workspace>/.dsh` | where backups and the ledger live |
| `newFileBom` | `false` | write a UTF-8 BOM when creating a new file |
| `context` | `3` | context lines in the **human-facing** diff (affects `stdout` and the UI card only; the model-facing body always uses 0) |
| `diff` | `'auto'` | default policy for the model-facing diff body; a per-call `diff` argument overrides it |
| `maxDiffLines` | `30` | line budget for the model-facing diff body: `auto` drops it when exceeded, `full` truncates at it |
| `root` | `process.cwd()` | fallback workspace when a call has no agent session |

`DSH_TEXT_EDITOR_EOL` (`lf` \| `crlf`) overrides the line-ending inference for **new** files.

## Self-test and gates

```powershell
# run from the root of a clone of this repository
node tools/selftest.mjs        # 92/92 on Windows + Node 24
node tools/check-license.mjs   # license / dependency / Node-only gate
node tools/gen-schema.mjs      # embedded schemas still match the DSL
```

These three live in the repository only: `tools/` is deliberately outside the `files` whitelist, so
the published package is just the plugin, its preset installer, the docs and the license.

`tools/selftest.mjs` covers BOM/EOL fidelity, `dry_run`, all four anchor kinds, `count`, ambiguity
refusal, usage errors, binary/invalid-UTF-8 refusal, `.dsh/` and outside-workspace guards, majority
EOL inference, multi-hunk diffs, end-of-file newline changes and concurrent writes — **plus a
plugin-layer suite** that drives `apply()` with a fake context and asserts tool registration, the
guidance section, that every returned value satisfies `OUTPUT_SCHEMA`, the `render()` text, and the
config plumbing (`root` / `backup` / `ledger` / `newFileBom`) — **and a token-budget suite**: a
full-file rewrite must not echo the content back, a small edit still shows the changed lines, the
`diff: none` / `full` boundaries hold, the path appears once, and the complete diff flows only into
the UI card. The token budget is a design constraint rather than an implementation detail, so it
carries its own regression test; otherwise one "let me print a bit more here" quietly removes it.

`tools/gen-schema.mjs` needs an installed `@deepseek-ai/dsh-tools`: it looks for one under the dsh
profile's `node_modules` and under the npm global prefix, and `DSH_TOOLS_ENTRY` overrides that lookup.
It exits 2 when it cannot find one.

## Layout

```
lib/core.mjs             # the core: BOM/EOL, anchors, matching, diff (with the result budget), backups, ledger, atomic write, per-target lock
lib/editor.mjs           # the plugin: schemas, validation, tool registration (zero-dep ESM, no build)
preset/preset.yml        # preset name/description, as dsh lists it
scripts/install-preset.mjs  # derives the user preset from the local dsh installation
cordis.patch.yml         # host-plane bundle patch
tools/selftest.mjs       # end-to-end self-test (core + plugin layer)
tools/check-license.mjs  # license / dependency / Node-only hygiene gate
tools/gen-schema.mjs     # authoritative source and checker for the embedded JSON Schemas
```

Backups and the ledger use fixed, documented names and fields: one file per edit under
`.dsh/backups/`, named `<flattened-absolute-path>@<timestamp>`, and one JSON object per line in
`.dsh/edits.log` (`time`, `id`, `tool`, `file`, `abspath`, `action`, `kinds`, `line_start`,
`line_end`, `added`, `removed`, `bom`, `eol`, `backup`, `summary`).

## License

**Apache-2.0** — see [LICENSE](LICENSE). Copyright 2026 Flotiarenor. The package has **no runtime
dependencies**, so it carries no third-party license obligations of its own. Three notes:

- The embedded JSON Schemas in `lib/editor.mjs` are generated *output* of the `@deepseek-ai/dsh-tools`
  converter (MIT, Copyright (c) 2026 DeepSeek) via `tools/gen-schema.mjs`.
- The preset composition is **not** part of this package: `scripts/install-preset.mjs` reads the one
  shipped with the user's own dsh installation at install time.
- Source files carry an `SPDX-License-Identifier` header, so the license is machine-readable per file.
