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

## Masking the built-in `write` / `edit` (optional)

`lib/mask.mjs` is a separate plugin row: install it into a preset and that preset's sessions have no
built-in `write` / `edit` at all. The installer takes a flag:

```powershell
node scripts/install-preset.mjs --mask-native     # adds the tool-native-edit-mask row and writes guidance: short
```

It removes **2362 B per request** (measured by `node tools/measure-context.mjs --vs-native`): the two
schemas (1754 B: `write` 728 + `edit` 1026, sandbox escalation fields included) plus their two guidance
sections (608 B: 220 + 388). Switching the editor row to `guidance: short` removes another 81 B
(241 -> 160), for **2443 B per request** in total (~600 tokens).

It works through two channels, both scoped to each agent:

| Channel | Call | Effect |
| --- | --- | --- |
| Tool catalog and execution | `agent.ctx.tools.restrict({ deny: ['write','edit'] })` | The named tools are **gone from the catalog and uncallable** - naming one yields `UNKNOWN_TOOL` |
| Prompt | `agent.ctx.systemPrompt.section({ name: 'tool:write', text: '' })` | An empty same-named section in a nearer layer shadows the two sections `dsh-tool-fs` registers |

Why it hangs off `agent/created`: `restrict()` may only be called from a **scoped context**; called from
the preset's standing scope (the plugin row's own context) it is refused, because names registered in
that same layer are not restrictable globals. Scope routing guarantees a listener registered in this
row's scope only sees agents that joined this preset (subagent children included, since they parent to
the same standing key).

### Can the built-ins still be tested once masked? Yes - four ways

1. **Use another preset.** The mask only affects the preset that carries it; a `standard` session keeps
   both tools visible and callable - the built-in control group that `tools/probe-mask.mjs` asserts.
2. **Run the probe.** `node tools/probe-mask.mjs` rebuilds the mount shape with the real `dsh-tools` +
   `dsh-scope` and asserts visibility, executability and the prompt text; 11 checks, exit code 2 when no
   dsh installation is found.
3. **Drive the built-ins directly.** `tools/measure-context.mjs --vs-native` calls `apply()` on the real
   `dsh-tool-fs` inside the process and measures its schemas and sections - no agent involved, so no
   mask can reach it.
4. **Lift it temporarily.** Give the `tool-native-edit-mask` row `disabled: true`, or switch it to
   `mode: 'guard'`.

### `mode: 'guard'`: keep a window open

`mode: 'guard'` skips `restrict` and registers `agent.ctx.tools.guard(...)` instead: the tools stay
**visible**, calls are refused with a reason naming `edit_text` / `write_text`. The schemas and guidance
sections are still paid for (that 2362 B), and in exchange the built-ins stay callable and observable.

### Boundaries

- **Not an authority boundary.** This is the live visibility composition DSH documents: the built-ins
  **stay registered** (a plugin/tool inventory may still list them) and a shell command can still write
  files. `tools/probe-mask.mjs` asserts exactly that.
- **Names are configuration.** `deny` / `sections` are config, so a rename or split of `tool-fs` is a
  config edit.
- **Only visible names are named.** A preset without `tool-fs` gets no restriction at all (never an
  unknown-name error); the section shadowing still applies.

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

Both tools return the same canonical value (`OUTPUT_SCHEMA`). The first four fields feed the **model
channel** (`render` reads only those); the rest is the **presentation channel** (the GUI diff card),
projected through `output.presentationMeta` into the session log and never into the model context.
A failure value carries the first four fields only.

| Field | Content | Destination |
|---|---|---|
| `path` | the target path as supplied by the caller | canonical value only — **not** rendered |
| `ok` | whether the write succeeded | — |
| `brief` | one stat line (e.g. `replace@17 +1/-1`) plus any warning lines | model context |
| `stderr` | failure reason (non-empty on failure) | model context |
| `operation` | `create` or `update` | card title |
| `hunks` | the applied change, one `{ oldText, newText }` per hunk with context | GUI card |
| `hunksTruncated` | whether the card payload hit its cap | GUI card title |

The model-facing text therefore has exactly two shapes:

```
WROTE                   # success: stat line + warnings
replace@17 +1/-1
FAIL                    # failure: the complete reason (it decides the next call)
<reason>
```

**A successful call never echoes the change.** Tool results are appended to the session history, so any
echo accumulates with every call, while the caller has just sent `new_text`; `replace@17 +1/-1` already
says which lines changed and by how much, and `read` is one call away when the content is needed. The
model-visible bytes of a call are independent of input size (measured: a 400 KB single-line write still
returns two lines / 17 B).

**A successful call does not echo the path either.** The result is bound to its call (`tool/result`
carries `source.callId`) and the caller's own `file_path` argument sits in the same turn's history, so
echoing it back adds zero information. It is not free: measured across 86 current-shape results in 79
real session logs, one success averaged 116 B of which the `WROTE <path>` line was 55.6 B (48%); the
path-free shape averages 66 B per success (−43%). The path still appears where it carries meaning —
inside a failure **reason** that has to name the file — and in the GUI card (see below).

### Presentation channel (GUI diff card)

The tools declare `presentCall`, `output.presentationMeta` and `presentResult`:

- `presentCall(args)` draws the pending card from the call's arguments (a diff for `edit_text`, a
  create-shaped diff for `write_text`; `grep`/`lines` anchors have no old text, so they show as an
  insertion);
- `presentationMeta(args, value)` projects the hunks the write actually applied — the path and the real
  change live here rather than in the model's context;
- `presentResult(args, result)` narrows the persisted projection back into a `DiffResultView`, and
  degrades to the raw result text whenever the projection is absent, empty or malformed.

The projection is persisted in the session log, so it is capped: `PRESENT_MAX_HUNKS` (40) and
`PRESENT_MAX_BYTES` (4096) in `lib/core.mjs`. An oversized change (a whole-file rewrite, say) keeps the
card honest by dropping the body and marking the title `（部分 diff）`.

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
  temp file + fsync + rename). Because nothing else enforces anything on this path, the plugin mirrors
  the session's own file policy for the one mode that forbids writing: under `read-only` both tools
  refuse before any I/O, and the reason says the session policy — not the path — is what refused.
  `sandboxPolicy` is consumed opportunistically (`ctx.get`), so a deployment without it, or a resolver
  that throws, falls back to the previous behaviour instead of bricking writes.
- **Only the `read-only` mode is mirrored.** `workspace-write` and `danger-full-access` still run
  through the constant guard below; the plugin does not mirror the host exactly, and it is **not** a
  security boundary — a shell command can still write anywhere the sandbox allows.
- **Line anchors are not content-verified.** `lines` and `before` / `after <line>` locate text by line
  number alone: a wrong number does not fail, it edits somewhere else. When the anchor has to be
  verifiable, use `old_text` or `grep`.
- **Per-target serialization is per process.** An in-process queue per target plus an atomic write
  keeps parallel tool calls from overwriting each other, but another dsh instance, an editor or any
  other process writing the same file still can, and external changes are not detected.
- **UTF-8 text only.** Files containing NUL bytes (binary) or invalid UTF-8 are refused, as are paths
  inside `.git/` or `.dsh/` and paths outside the workspace; the guard list is a constant, not
  configuration. (A file marked read-only by the OS is refused too — the atomic rename fails with
  `EPERM` — and the attribute is never silently cleared.)
- **Creating a file fills in missing parent directories.** When the `write_text` target does not exist,
  parents are created (`mkdir -p`, as the built-in `write` does). The action produces no extra output.
- **A failed ledger append does not change the write outcome.** Once the target file is written, a
  ledger failure only appends a `[warn]` line to the result and `ok` stays true; reporting failure would
  make the caller retry a write that already landed.
- **The card payload is capped, so a huge change shows no diff.** Past the hunk/byte caps above the
  card body is empty and the title says `（部分 diff）`; the raw two-line result remains as the record.

## Configuration

There is no Config schema: the preset row's `config:` mapping is passed through as-is.

| Key | Default | Meaning |
|---|---|---|
| `backup` | `true` | copy the previous content into `artifactsDir/backups` before writing |
| `ledger` | `true` | append a JSONL record to `artifactsDir/edits.log` |
| `artifactsDir` | `<workspace>/.dsh` | where backups and the ledger live |
| `newFileBom` | `false` | write a UTF-8 BOM when creating a new file |
| `guidance` | `'full'` | three modes: `full` (names the built-ins) / `short` (for when the mask hides them) / `false` (register no section) |
| `root` | `process.cwd()` | fallback workspace when a call has no agent session |

`DSH_TEXT_EDITOR_EOL` (`lf` \| `crlf`) overrides the line-ending inference for **new** files.

## Self-test and gates

```powershell
# run from the root of a clone of this repository
node tools/selftest.mjs                 # 120/120 on Windows + Node 24
node tools/check-license.mjs            # license / dependency / Node-only gate
node tools/gen-schema.mjs               # embedded schemas still match the DSL
node tools/measure-context.mjs          # per-scenario model-visible bytes
node tools/audit-session.mjs            # reconcile against real session logs (text-shape check)
node tools/probe-mask.mjs               # verify the mask against real dsh packages (exit 2 without them)
```

`npm test` chains the licence gate, the self-test and `measure-context --cap 2048`: no single call may
put more than 2 KB of model-visible text into the context. The current worst scenario is the 1.6 KB
ambiguity hint; a successful call is always two lines, 17–21 B.

These live in the repository only: `tools/` is deliberately outside the `files` whitelist, so
the published package is just the plugin, its preset installer, the docs and the license.

`tools/selftest.mjs` covers BOM/EOL fidelity, all four anchor kinds, `count`, ambiguity refusal, relaxed
matching reports, usage errors, binary/invalid-UTF-8 refusal, `.dsh/` and outside-workspace guards,
majority EOL inference, multi-hunk diffs, end-of-file newline changes, concurrent writes,
parent-directory creation and errno-only failure text — **plus a plugin-layer suite** that drives
`apply()` with a fake context and asserts tool registration, the guidance section, that every returned
value satisfies `OUTPUT_SCHEMA`, the literal shape of the `render()` text, and the config plumbing
(`root` / `backup` / `ledger` / `newFileBom`) — **a return-value suite**: whatever the input size, a
successful call is two lines, carries no change content and never repeats the path — **a presentation
suite**: `presentCall` shapes, the applied-hunk projection, replay narrowing, the degradation paths for
absent/empty/malformed metadata, and the card cap — **a policy suite**: `read-only` refuses both
tools before any I/O (no bytes, no backup), `workspace-write` / `danger-full-access` keep writing, and a
missing or throwing policy service does not brick writes — **a mask suite**: only visible names are
named, what each mode calls, the empty sections and their orders, no double registration, and a
throwing registry or prompt service never escaping the listener — and **a guidance suite**: the
`full` / `short` / `false` modes plus a loud failure on an unknown value.

`tools/probe-mask.mjs` rebuilds the preset mount shape with the real dsh packages (`dsh-tools` +
`dsh-scope` + `dsh-system-prompt` + `cordis`) and asserts the mask's actual registry semantics: a masked
agent loses `write` / `edit` from its catalog, naming one yields `UNKNOWN_TOOL`, an unmasked sibling
keeps both, the native guidance disappears from the masked prompt only, the standing scope still has
them registered (visibility composition, not authority), and `mode: 'guard'` keeps them visible while
refusing the call. Exit code 2 when no dsh installation is found.

### Measuring context cost

`tools/measure-context.mjs` drives `apply()` on a simulated context through the real
`execute()` → `output.render()` path, printing input bytes, model-visible bytes, ratio and line count per
scenario. `--cap N` exits 1 when any scenario exceeds N bytes; `--static` prints the per-request
overhead; `--vs-native` adds the same figures for the host's `write` / `edit` (SKIP when no dsh
installation is found).

`tools/audit-session.mjs` reconciles against real session logs (`<DSH_HOME>/sessions/`, multi-frame
zstd, per call) and checks three things: whether each result matches one of the two documented text
shapes (a diff body, a `=== ` header, an `OK ` tail, a backup name or an internal temp filename is
reported), whether a successful result repeats the call's own `file_path` (the regression this shape
exists to prevent), and whether any single result exceeds `--cap` (1024 B by default).

`tools/gen-schema.mjs` needs an installed `@deepseek-ai/dsh-tools`: it looks for one under the dsh
profile's `node_modules` and under the npm global prefix, and `DSH_TOOLS_ENTRY` overrides that lookup.
It exits 2 when it cannot find one.

## Layout

```
lib/core.mjs             # the core: BOM/EOL, anchors, matching, backups, ledger, atomic write, locks, hunk projection
lib/editor.mjs           # the plugin: schemas, validation, registration, diff card, read-only mirror (zero-dep ESM)
lib/mask.mjs             # optional row: hide the built-in write / edit per agent (deny or guard)
preset/preset.yml        # preset name/description, as dsh lists it
scripts/install-preset.mjs  # derives the user preset from the local dsh installation (--mask-native adds the mask)
cordis.patch.yml         # host-plane bundle patch
tools/selftest.mjs       # end-to-end self-test (core + plugin + presentation + policy + mask + guidance)
tools/probe-mask.mjs     # verifies the mask's registry semantics against real dsh packages (exit 2 without them)
tools/check-license.mjs  # license / dependency / Node-only hygiene gate
tools/gen-schema.mjs     # authoritative source and checker for the embedded JSON Schemas
tools/measure-context.mjs  # per-scenario model-visible bytes + the native-tool comparison
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
