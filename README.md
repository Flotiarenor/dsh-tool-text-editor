# dsh-tool-text-editor

[中文](README.zh.md) | English

Model-facing tools for [DeepSeek Harness](https://github.com/deepseek-ai) (dsh) that edit text
files **byte-faithfully**: `edit_text` and `write_text`.

They fix three defects of the built-in `write` / `edit` (implemented by
`@deepseek-ai/dsh-fs-local`):

| Defect | Cause | This plugin |
|---|---|---|
| **UTF-8 BOM lost** on any edit or overwrite | the implementation has no BOM handling; Node's `TextDecoder` strips a leading BOM by default | BOM preserved |
| **CRLF flattened to LF** on a full overwrite | `writeText` does not restore the file's line-ending style | line endings follow the file |
| **`FS_EDIT_NOT_FOUND`** when `old_string` differs by a space | the built-in `edit` matches literally, with no fallback | exact → relaxed → nearest candidates (ambiguity refuses to write) |

Beyond those three: **automatic backups** before a write, an **edit ledger**, **`grep` / `lines`
anchors** so old text never has to be copied by hand, and **near-miss candidates**. The return value
and the composition of the model-facing text are documented under "Return value".

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
`"263:270"`; also including the trailing newline). `mode` is `replace` (default) / `after` / `before` /
`append` / `prepend`, plus `count` (require exactly N occurrences and replace all) and `nth` (k-th
occurrence); `count` and `nth` are mutually exclusive.

Both anchor kinds span the line block **with** its trailing newline, so end `new_text` with a newline too —
otherwise the replacement joins the following line and the file loses a line (the `+1/-2` stat reports it).

Matching runs exact → relaxed (trailing whitespace, line-block similarity) → nearest candidates on a
miss. A match that hits several places without `nth` / `count` refuses to write. A relaxed hit adds one
`[warn]` line to the result.

### `write_text` — create or fully replace a file

`file_path` + `content`; creation needs no flag (missing parent directories are created), an overwrite
is backed up first, and a brand-new file follows the **majority** line-ending style of its siblings
(same extension first) with no BOM by default.

Both tools **write**; neither has a preview mode.

### Return value

Both tools return the same canonical value (`OUTPUT_SCHEMA`), with four fields:

| Field | Content | Destination |
|---|---|---|
| `path` | the target path as supplied by the caller, echoed back | — |
| `ok` | whether the write succeeded | — |
| `brief` | one stat line (e.g. `replace@17 +1/-1`) plus any warning lines | model context |
| `stderr` | failure reason (non-empty on failure) | model context |

The model-facing text therefore has exactly two shapes:

```
WROTE <path>            # success: stat line + warnings
replace@17 +1/-1
FAIL <path>             # failure: the complete reason (it decides the next call)
<reason>
```

**A successful call never echoes the change.** Tool results are appended to the session history, so any
echo accumulates with every call, while the caller has just sent `new_text`; `replace@17 +1/-1` already
says which lines changed and by how much, and `read` is one call away when the content is needed. The
model-visible bytes of a call are independent of input size (measured: a 400 KB single-line write still
returns two lines / 90 B).

The record of a change lives in the backup and the ledger, neither of which enters the model context:
the pre-edit copy under `.dsh/backups/` and one JSONL line per edit in `.dsh/edits.log`.

A failing system call is reported as errno plus one reason (`ENOENT`, `ENOTDIR`, `EISDIR`, `EACCES`, …):
the absolute paths and internal temp filename (`.<name>.<pid><ts>.tmp`) carried by the raw Node message
do not enter the model context.

## Deliberate limitations

These are design choices, not defects to be fixed; check them against your use case before relying on
the tools.

- **Writes bypass `ctx.fs`.** The file is written by the plugin itself, so the fs-observation policy
  (read-before-write, version freshness), the sandbox, `sandbox_permissions` escalation and Windows
  DACL preservation are all skipped. The atomic write is implemented by the plugin (same-directory
  temp file + fsync + rename).
- **Line anchors are not content-verified.** `lines` and `before` / `after <line>` locate text by line
  number alone: a wrong number does not fail, it edits somewhere else. When the anchor has to be
  verifiable, use `old_text` or `grep`.
- **Per-target serialization is per process.** An in-process queue per target plus an atomic write
  keeps parallel tool calls from overwriting each other, but another dsh instance, an editor or any
  other process writing the same file still can, and external changes are not detected.
- **UTF-8 text only.** Files containing NUL bytes (binary) or invalid UTF-8 are refused, as are paths
  inside `.git/` or `.dsh/` and paths outside the workspace; the guard list is a constant, not
  configuration.
- **Creating a file fills in missing parent directories.** When the `write_text` target does not exist,
  parents are created (`mkdir -p`, as the built-in `write` does). The action produces no extra output.
- **A failed ledger append does not change the write outcome.** Once the target file is written, a
  ledger failure only appends a `[warn]` line to the result and `ok` stays true; reporting failure would
  make the caller retry a write that already landed.
- **No diff card in the GUI.** The tools declare no `presentResult` / `presentationMeta`, so the Web UI
  shows the same two lines the model sees. Review changes through the backup, the ledger, or the
  project's own git diff.

## Configuration

There is no Config schema: the preset row's `config:` mapping is passed through as-is.

| Key | Default | Meaning |
|---|---|---|
| `backup` | `true` | copy the previous content into `artifactsDir/backups` before writing |
| `ledger` | `true` | append a JSONL record to `artifactsDir/edits.log` |
| `artifactsDir` | `<workspace>/.dsh` | where backups and the ledger live |
| `newFileBom` | `false` | write a UTF-8 BOM when creating a new file |
| `root` | `process.cwd()` | fallback workspace when a call has no agent session |

`DSH_TEXT_EDITOR_EOL` (`lf` \| `crlf`) overrides the line-ending inference for **new** files.

## Self-test and gates

```powershell
# run from the root of a clone of this repository
node tools/selftest.mjs                 # 80/80 on Windows + Node 24
node tools/check-license.mjs            # license / dependency / Node-only gate
node tools/gen-schema.mjs               # embedded schemas still match the DSL
node tools/measure-context.mjs          # per-scenario model-visible bytes
node tools/audit-session.mjs            # reconcile against real session logs (text-shape check)
```

`npm test` chains the licence gate, the self-test and `measure-context --cap 2048`: no single call may
put more than 2 KB of model-visible text into the context. The current worst scenario is the 1.6 KB
ambiguity hint; a successful call is always two lines, about 90 B.

These live in the repository only: `tools/` is deliberately outside the `files` whitelist, so
the published package is just the plugin, its preset installer, the docs and the license.

`tools/selftest.mjs` covers BOM/EOL fidelity, all four anchor kinds, `count`, ambiguity refusal, relaxed
matching reports, usage errors, binary/invalid-UTF-8 refusal, `.dsh/` and outside-workspace guards,
majority EOL inference, multi-hunk diffs, end-of-file newline changes, concurrent writes,
parent-directory creation and errno-only failure text — **plus a plugin-layer suite** that drives
`apply()` with a fake context and asserts tool registration, the guidance section, that every returned
value satisfies `OUTPUT_SCHEMA`, the literal shape of the `render()` text, and the config plumbing
(`root` / `backup` / `ledger` / `newFileBom`) — **and a return-value suite**: whatever the input size, a
successful call is two lines and carries no change content.

### Measuring context cost

`tools/measure-context.mjs` drives `apply()` on a simulated context through the real
`execute()` → `output.render()` path, printing input bytes, model-visible bytes, ratio and line count per
scenario. `--cap N` exits 1 when any scenario exceeds N bytes; `--static` prints the per-request
overhead; `--vs-native` adds the same figures for the host's `write` / `edit` (SKIP when no dsh
installation is found).

`tools/audit-session.mjs` reconciles against real session logs (`<DSH_HOME>/sessions/`, multi-frame
zstd, per call) and checks two things: whether each result matches one of the two documented text
shapes (a diff body, a `=== ` header, an `OK ` tail, a backup name or an internal temp filename is
reported), and whether any single result exceeds `--cap` (1024 B by default).

`tools/gen-schema.mjs` needs an installed `@deepseek-ai/dsh-tools`: it looks for one under the dsh
profile's `node_modules` and under the npm global prefix, and `DSH_TOOLS_ENTRY` overrides that lookup.
It exits 2 when it cannot find one.

## Layout

```
lib/core.mjs             # the core: BOM/EOL, anchors, matching, backups, ledger, atomic write, per-target lock
lib/editor.mjs           # the plugin: schemas, validation, tool registration (zero-dep ESM, no build)
preset/preset.yml        # preset name/description, as dsh lists it
scripts/install-preset.mjs  # derives the user preset from the local dsh installation
cordis.patch.yml         # host-plane bundle patch
tools/selftest.mjs       # end-to-end self-test (core + plugin layer)
tools/check-license.mjs  # license / dependency / Node-only hygiene gate
tools/gen-schema.mjs     # authoritative source and checker for the embedded JSON Schemas
tools/measure-context.mjs  # per-scenario model-visible bytes
tools/audit-session.mjs  # reconciliation against real session logs + text-shape check
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
