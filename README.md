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
refusal**, and **near-miss candidates** when an anchor does not match.

The canonical return value of both tools, the composition of the model-facing text, and the UI card
projection are documented under "Return value".

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

### Return value

Both tools return the same canonical value (`OUTPUT_SCHEMA`). Field contents and destinations:

| Field | Content | Destination |
|---|---|---|
| `path` | the target path as supplied by the caller, echoed back | — |
| `ok` / `wrote` / `dryRun` | outcome flags | — |
| `brief` | warning lines plus one stat line, e.g. `replace@60 +1/-1` | model context |
| `diff` | a unified diff of the changed lines only (`@@` hunk headers, 0 context lines, no `---` / `+++` file headers), bounded by **lines + bytes + per-line characters** | model context |
| `stdout` | the full human record: path header, complete diff with context lines, backup filename | UI / logs / triage |
| `stderr` | failure reason (non-empty on failure) | model context |

The model-facing text consists of `brief` and `diff`, with the path appearing once in the leading
line; the `diff` body carries no `---` / `+++` file headers, so the path never recurs inside it. The
complete diff is additionally projected by `output.presentationMeta` into a list of
`{ path, oldText, newText }`, the same card vocabulary the built-in `edit` / `write` tools use, and
handed to the Web UI by `presentResult`; that metadata is persisted with `tool/result` and never
enters the model context.

On failure neither `brief` nor `diff` is returned: the model-facing text is `FAIL` plus the target
path, followed by the complete failure reason (produced by the core, usually containing the
workspace-relative path once more). A failing system call is reported as errno plus one reason
(`ENOENT`, `ENOTDIR`, `EISDIR`, `EACCES`, …): the absolute paths and internal temp filename
(`.<name>.<pid><ts>.tmp`) carried by the raw Node message do not enter the model context.

The `diff` argument selects the detail level of the `diff` field:

| Value | Behavior |
|---|---|
| `auto` | default. The body is returned when it fits all three budgets; otherwise it is omitted with a one-line note |
| `full` | the body is always returned; it is truncated with a one-line note when it exceeds the budgets |
| `none` | no body is returned |

The body always uses 0 context lines; the `context` setting affects `stdout` and the UI card only. The
three budgets bound the bytes a single call puts into the model context: tool results are appended to
the session history and are not prefix-cached, so without a bound a full-file rewrite returns the same
order of magnitude as the content just sent (measured at ~1.0x).

| Budget | Default | Bounds |
|---|---|---|
| `maxDiffLines` | `30` | line count |
| `maxDiffBytes` | `4096` | total body bytes; the backstop that applies when the lines are few but long |
| `maxDiffLineChars` | `200` | characters per line; the excess is clamped to `…[+N chars]`, keeping the line prefix |

With a line-count budget alone, a change of fewer than 30 very long lines (a file minified to one line,
wide data rows, a swap of one long line) still entered the model context whole (1.0x, about 2.0x when
replacing a long line). With all three budgets, `tools/measure-context.mjs` measures a worst single
result of 2.2 KB (200-line rewrite with `diff:"full"`) and 200-550 B for the long-line cases.

## Deliberate limitations

These are design choices, not defects to be fixed; check them against your use case before relying on
the tools.

- **Writes bypass `ctx.fs`.** The file is written by the plugin itself, so the fs-observation policy
  (read-before-write, version freshness), the sandbox, `sandbox_permissions` escalation and Windows
  DACL preservation are all skipped. The atomic write is implemented by the plugin (same-directory
  temp file + fsync + rename), and the diff card is projected by the plugin's `presentationMeta`
  whereas the built-ins use the `before` / `after` returned by `ctx.fs`.
- **Line anchors are not content-verified.** `lines` and `before` / `after <line>` locate text by line
  number alone: a wrong number does not fail, it edits somewhere else. When the anchor has to be
  verifiable, use `old_text` or `grep`.
- **Per-target serialization is per process.** An in-process queue per target plus an atomic write
  keeps parallel tool calls from overwriting each other, but another dsh instance, an editor or any
  other process writing the same file still can, and external changes are not detected.
- **UTF-8 text only.** Files containing NUL bytes (binary) or invalid UTF-8 are refused, as are paths
  inside `.git/` or `.dsh/` and paths outside the workspace.
- **Creating a file fills in missing parent directories.** When the `write_text` target does not exist,
  parents are created (`mkdir -p`, as the built-in `write` does). The action leaves one line in `stdout`
  and never enters the model-facing text; `dry_run` creates nothing.
- **A failed ledger append does not change the write outcome.** Once the target file is written, a
  failure of a side channel (the ledger, or anything after the write) adds a `[note]` line to `stdout`
  and the result stays `ok`; reporting failure would make the caller retry a write that already landed.

## Configuration

There is no Config schema: the preset row's `config:` mapping is passed through as-is.

| Key | Default | Meaning |
|---|---|---|
| `backup` | `true` | copy the previous content into `artifactsDir/backups` before writing |
| `ledger` | `true` | append a JSONL record to `artifactsDir/edits.log` |
| `artifactsDir` | `<workspace>/.dsh` | where backups and the ledger live |
| `newFileBom` | `false` | write a UTF-8 BOM when creating a new file |
| `context` | `3` | context lines in the diff of `stdout` and the UI card (the model-facing body always uses 0) |
| `diff` | `'auto'` | default policy for the `diff` field (`auto` / `full` / `none`); a per-call `diff` argument takes precedence |
| `maxDiffLines` | `30` | line limit for the `diff` field: `auto` omits the body when exceeded, `full` truncates at it |
| `maxDiffBytes` | `4096` | byte limit for the `diff` field (the backstop when the lines are few but long) |
| `maxDiffLineChars` | `200` | per-line character limit: a longer line is clamped to `prefix…[+N chars]` |
| `root` | `process.cwd()` | fallback workspace when a call has no agent session |

`DSH_TEXT_EDITOR_EOL` (`lf` \| `crlf`) overrides the line-ending inference for **new** files.

## Self-test and gates

```powershell
# run from the root of a clone of this repository
node tools/selftest.mjs                 # 107/107 on Windows + Node 24
node tools/check-license.mjs            # license / dependency / Node-only gate
node tools/gen-schema.mjs               # embedded schemas still match the DSL
node tools/measure-context.mjs          # per-scenario model-visible bytes (synthetic)
node tools/audit-session.mjs            # reconcile against real session logs (+ stdout leak check)
```

These live in the repository only: `tools/` is deliberately outside the `files` whitelist, so
the published package is just the plugin, its preset installer, the docs and the license.

`tools/selftest.mjs` covers BOM/EOL fidelity, `dry_run`, all four anchor kinds, `count`, ambiguity
refusal, usage errors, binary/invalid-UTF-8 refusal, `.dsh/` and outside-workspace guards, majority
EOL inference, multi-hunk diffs, end-of-file newline changes, concurrent writes, parent-directory
creation and errno-only failure text — **plus a plugin-layer suite** that drives `apply()` with a fake
context and asserts tool registration, the guidance section, that every returned value satisfies
`OUTPUT_SCHEMA`, the `render()` text, and the config plumbing (`root` / `backup` / `ledger` /
`newFileBom` / `maxDiffBytes` / `maxDiffLineChars`) — **and a return-value suite**: a full-file rewrite
must not echo the content back, a very long line must be clamped, a wide file must not come back whole,
a small edit must still report the changed lines, the three `diff` values must hold their documented
boundaries, the path must appear once, and the complete diff must be projected only through
`presentationMeta`.

### Measuring context cost

`tools/measure-context.mjs` drives `apply()` on a simulated context through the real
`execute()` → `output.render()` path, printing input bytes, model-visible bytes, ratio and UI metadata
bytes per scenario. `--cap N` exits 1 when any scenario exceeds N bytes (`npm test` runs it with
`--cap 4096`); `--static` prints the per-request overhead; `--vs-native` adds the same figures for the
host's `write` / `edit` (SKIP when no dsh installation is found).

`tools/audit-session.mjs` reconciles against real session logs (`<DSH_HOME>/sessions/`, multi-frame
zstd, per call) and checks two things: whether stdout-only lines reach the model-visible text, and
whether any single result exceeds `--cap` (8192 B by default). It is also the upgrade measurement:
development-era sessions contain 158 results carrying the full human stdout (largest single result
12.5 KB); the three-budget build contains none.

`tools/gen-schema.mjs` needs an installed `@deepseek-ai/dsh-tools`: it looks for one under the dsh
profile's `node_modules` and under the npm global prefix, and `DSH_TOOLS_ENTRY` overrides that lookup.
It exits 2 when it cannot find one.

## Layout

```
lib/core.mjs             # the core: BOM/EOL, anchors, matching, diff, backups, ledger, atomic write, per-target lock
lib/editor.mjs           # the plugin: schemas, validation, tool registration (zero-dep ESM, no build)
preset/preset.yml        # preset name/description, as dsh lists it
scripts/install-preset.mjs  # derives the user preset from the local dsh installation
cordis.patch.yml         # host-plane bundle patch
tools/selftest.mjs       # end-to-end self-test (core + plugin layer)
tools/check-license.mjs  # license / dependency / Node-only hygiene gate
tools/gen-schema.mjs     # authoritative source and checker for the embedded JSON Schemas
tools/measure-context.mjs  # per-scenario model-visible bytes (synthetic scenarios)
tools/audit-session.mjs  # reconciliation against real session logs + stdout leak check
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
