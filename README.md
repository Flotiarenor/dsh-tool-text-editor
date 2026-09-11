# dsh-tool-text-editor

[中文](README.zh.md) | English

Model-facing tools for [DeepSeek Harness](https://github.com/deepseek-ai) (dsh) that edit text files
**byte-faithfully**: `edit_text` and `write_text`. They fix what the built-in `write` / `edit`
(`@deepseek-ai/dsh-fs-local`) cannot do — both defects below were verified against a real installation
(§ "Versus the built-ins"):

| Built-in behaviour | Cause | This plugin |
|---|---|---|
| **UTF-8 BOM lost** on any edit or overwrite | the implementation has no BOM handling; Node's `TextDecoder` strips a leading BOM by default | BOM preserved |
| **Line-ending style not restored** on a full overwrite | `writeText` writes `content` verbatim, so LF content turns a CRLF file into an LF file | line endings follow the file |
| **`FS_EDIT_NOT_FOUND`** when `old_string` differs by a space | the built-in `edit` matches literally, with no fallback | exact → relaxed → nearest candidates (ambiguity refuses to write) |

Also **`grep` / `lines` anchors** (old text is never copied by hand) and **near-miss candidates**;
"Return value" documents the result value and the model-facing text.

A call leaves **no side artifacts**: the only thing written is the target file.

## Implementation and requirements

**In-process Node** (`lib/core.mjs`): `node:` builtins only, no subprocess, no build step, no third-party
package.

| Requirement | Notes |
|---|---|
| Node | **The only dependency**: no interpreter, no external runtime, no process-startup cost per call. |

The package installs nothing. Its one `peerDependencies` entry, `@deepseek-ai/dsh-tools`, is the host
contract ("needs this dsh, and not a later major line") and resolves from the dsh installation, not beside
the plugin. The range carries two clauses, `>=0.1.0-rc.6 || >=0.1.5-rc.2`, because npm admits a prerelease
only when the range has a comparator sharing its `major.minor.patch` tuple; each verified dsh line therefore
needs its own clause, or a prerelease install reads as an unmet peer.

## Install

### Option 1 — preset (recommended, tightly scoped)

Only sessions selecting this preset see the two tools. Run from the root of a clone of this repository:

```powershell
node scripts/install-preset.mjs
# flags: --id <preset-id> (default texteditor) / --base <shipped-preset> (default standard)
#        / --force / --dry-run / --from <agent.cordis.yml path>
```

Restart `dsh web` and start a new session on preset `texteditor`: a preset is a session-creation fact, so a
running session cannot switch to it.

### Option 2 — install into the profile (available to every session)

`dsh plugin add` accepts several kinds of source, all working here: the package is prebuilt, dependency-free
ESM, with no `prepare` / `build` step to authorize or run.

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

The tool names do not collide with the built-ins, so a host-plane insert is safe; the cost is both tools and
their guidance section in **every** session. Uninstall with `dsh plugin --profile web remove @flotiarenor/dsh-tool-text-editor`.
Both installs may coexist, the preset layer shadowing the host layer with an identical definition.

## Masking the built-in `write` / `edit`

The editor row **adds** `edit_text` / `write_text` and leaves the built-ins alone. Removing them is a second,
separate row — `lib/mask.mjs` — that the installer only injects on request:

```powershell
node scripts/install-preset.mjs --mask-native   # also injects the tool-native-edit-mask row (and guidance: short)
```

Two rows are forced, not a matter of taste: `tools.restrict()` is callable only from a **scoped context**
(`agent.ctx`), and a preset row's own context *is* the standing scope where the natives are registered, so a row
cannot hide tools from itself. Masking is therefore a fact about the composition, and only a second row can state
it.

It removes **2362 B per request** (`node tools/measure-context.mjs --vs-native`): two schemas (1754 B: `write`
728 + `edit` 1026, sandbox escalation fields included) plus two guidance sections (608 B: 220 + 388);
`guidance: short` on the editor row removes another 81 B (241 -> 160), for **2443 B per request** (~600 tokens).

| Mechanism | How it works |
| --- | --- |
| Guard, armed in `apply()` on the row's own scope layer | Refuses the first native call of any agent, naming `edit_text` / `write_text`, and narrows that agent in the same call, so the next request's table is already clean. Being on the layer rather than on an event, its coverage does not depend on when the agent was created |
| Tool catalog and execution | `agent.ctx.tools.restrict({ deny: ['write','edit'] })` — the named tools leave the catalog **and** become uncallable (naming one yields `UNKNOWN_TOOL`) |
| Prompt | `agent.ctx.systemPrompt.section({ name: 'tool:write', text: '' })` shadows the two guidance sections `dsh-tool-fs` registers. A redundant safety net: since 0.1.5-rc.2 those sections are visibility-gated and disappear on their own |
| Membership | The guard is asked who it belongs to, because a preset can be swapped under a live agent. The row calls `ctx.tools.guardReason()` with an execution object **it minted itself**, so the answer is object identity, not a name: a real dispatch always mints a fresh object and can never be mistaken for the probe, and a foreign guard that refuses everything cannot answer for this row |
| Leaving, and unloading | `restrict` and the shadowing sections sit on the **agent's own layer**, so they outlive the preset; each is kept as a disposer and lifted when the agent re-links elsewhere — otherwise that agent is left with neither the native names nor this plugin's tools, i.e. no way to write at all. Unloading the row does the same for every agent it masked |
| Host-plane install | A row mounted on the host plane (profile layer) has no scope, so its guard lands in the global layer, where narrowing would hit presets that never mounted this plugin. The same probe detects exactly that and the row degrades to guard-only, with one warning. No config key expresses this — the mount shape decides |

Membership is deliberately three-state (`member` / `outsider` / `unknown`) and a mask is lifted only on a
definite `outsider`: an unanswerable probe means "leave that agent alone", because reading it as `outsider` would
silently undo a working restriction. A probe that cannot answer at all is reported once, loudly.

### Observing the built-ins once masked: four ways

| Way | How |
| --- | --- |
| **Another composition (another preset)** | Masking is a composition fact, not a global switch: an agent of another composition keeps both tools visible and callable, the control group `tools/probe-mask.mjs` and `tools/repro-mask.mjs` assert; a **sibling agent of the same preset** is masked too, deliberately |
| **The probe** | `node tools/probe-mask.mjs` mounts the mask on the real dsh packages and registry (see "Self-test and gates"); 15 checks, exit code 2 without an installed dsh |
| **The built-ins driven directly** | `tools/measure-context.mjs --vs-native` calls `apply()` on the real `dsh-tool-fs` in-process and measures its schemas and sections; no agent is involved, so no mask can reach it |
| **A temporary lift** | Give the `tool-native-edit-mask` row `disabled: true` |

### Mask row configuration

The row has no Config schema either: `config:` is passed through as-is.

| Key | Default | Meaning |
|---|---|---|
| `deny` | `['write','edit']` | the names to narrow; only names that agent actually sees are named |
| `sections` | `['tool:write','tool:edit']` | the guidance sections to shadow with an empty section; `[]` turns the shadowing off |

### Boundaries

| Boundary | Meaning |
| --- | --- |
| **Not an authority boundary** | Visibility composition as DSH defines it: the built-ins **stay registered** and a shell command can still write files |
| **A composition fact, not a global switch** | The row touches only the agents that joined its composition: the sibling agent of the same preset included, an agent of another preset not at all. A host-plane install is the one exception, and it never narrows |
| **Names are configuration** | `deny` / `sections` are config, so a rename or split of `tool-fs` is a config edit |
| **Only visible names are named** | A preset without `tool-fs` gets no restriction at all (never an unknown-name error), and the guard asks visibility per call, leaving a name that exists elsewhere but not for the caller alone |

## Tools

### `edit_text` — targeted replacement

| Aspect | Rule |
| --- | --- |
| Required | `file_path` and `new_text` |
| Anchor, exactly one | `old_text` (literal, copied from `read`) / `grep` (regex; the matched line/block including its trailing newline) / `lines` (e.g. `"263:270"`, also including the trailing newline) |
| `mode` | `replace` (default) / `after` / `before` / `append` / `prepend` |
| `count` | The expected number of hits: occurrences of the literal for `old_text` (all of them replaced), regex hits for `grep`, covered lines for `lines`. Any mismatch refuses to write |
| Trailing newline | Both anchor kinds span the line block **with** its trailing newline, so end `new_text` with a newline too; otherwise the replacement joins the following line and the file loses a line (the `+1/-2` stat reports it) |
| Matching | Exact → relaxed (trailing whitespace, line-block similarity) → nearest candidates on a miss; a match hitting several places without `count` refuses to write, and a relaxed hit adds one `[warn]` line to the result |
| No k-th hit | `count` is the only disambiguation knob, and it means *confirmation*, not *selection*. To change one occurrence among several, make the anchor unique — a longer `old_text`, or `lines` / `grep` |

### `write_text` — create or fully replace a file

`file_path` + `content`; creation needs no flag (missing parent directories are created) and a brand-new file
follows the **majority** line-ending style of its siblings (same extension first) with no BOM by default.
**`content: ''` against a missing target creates a zero-byte file** (stat line `write +0/-0`), while writing
empty content over an already-empty file is still refused as "no change": a real no-op, not a creation. Both
tools **write**; neither has a preview mode.

### Return value

Both tools return the same canonical value (`OUTPUT_SCHEMA`), and it is the whole result: there is no
presentation channel and no side record. `render` reads `ok`, `brief` and `stderr`; `path` is carried for
the caller but never rendered.

| Field | Content | Destination |
|---|---|---|
| `path` | the target path as supplied by the caller | canonical value only — **not** rendered |
| `ok` | whether the write succeeded | model context (`FAIL` vs `WROTE`) |
| `brief` | one stat line (e.g. `replace@17 +1/-1`) plus any warning lines | model context |
| `stderr` | failure reason (non-empty on failure) | model context |

The model-facing text has exactly two shapes:

```
WROTE                   # success: stat line + warnings
replace@17 +1/-1
FAIL                    # failure: the complete reason (it decides the next call)
<reason>
```

**A successful call echoes neither the change nor the path.** Results are appended to the session history, so an
echo accumulates per call while the caller has just sent `new_text`; `replace@17 +1/-1` already reports which
lines changed and by how much, and `read` is one call away. The path is bound to its call (`tool/result` carries
`source.callId`) and the caller's `file_path` is in the same turn's history, so echoing it adds nothing — and it
costs: across 86 results in 79 real session logs, one success averaged 116 B of which the `WROTE <path>` line was
55.6 B (48%), against 66 B path-free (−43%). It survives where it carries meaning: in a failure reason that has
to name the file, and in the GUI's own rendering of the call arguments.

Failures are reported as an errno plus one reason (`ENOENT`, `ENOTDIR`, `EISDIR`, `EACCES`, …); the absolute
paths and the internal temp filename (`.<name>.<pid><ts>.tmp`) of the raw Node message stay out of the model
context.

The one thing the built-ins offer and this plugin does not is a diff body in the result — the built-in `write`
returns `before` / `after` so the host can draw a card, at 128 B per call. Here the host draws from the call
arguments it already has.

## Deliberate limitations

| Limitation | Detail |
| --- | --- |
| **Writes bypass `ctx.fs`** | The plugin writes the file itself, so the fs-observation policy (read-before-write, version freshness), the sandbox, `sandbox_permissions` escalation and Windows DACL preservation are all skipped; the atomic write is its own (same-directory temp file + fsync + rename). Nothing else enforces anything on this path, so the session file policy is mirrored for the one mode that forbids writing: `read-only` refuses both tools before any I/O, naming the session policy rather than the path. `sandboxPolicy` is consumed opportunistically (`ctx.get`), so a deployment without it, or a resolver that throws, keeps writing instead of bricking |
| **Only `read-only` is mirrored, and no path is restricted** | Under `workspace-write` and `danger-full-access` both tools write **any** path: outside the workspace, inside `.dsh/` or `.git/`, and through a junction / symlink pointing out of it. The plugin is **not** a security boundary: to restrict where writes land, use the session file policy, the sandbox and `sandbox_permissions` |
| **Line anchors are not content-verified** | `lines` and `before` / `after <line>` locate text by line number alone: a wrong number does not fail, it edits somewhere else. Where the anchor must be verifiable, use `old_text` or `grep` |
| **Per-target serialization is per process** | An in-process queue per target plus an atomic write keeps parallel tool calls from overwriting each other, but another dsh instance, an editor or any other process writing the same file still can, and external changes are not detected |
| **UTF-8 text only** | Files containing NUL bytes (binary) or invalid UTF-8 are refused; a file marked read-only by the OS is refused too (the atomic rename fails with `EPERM`) |
| **Creating a file fills in missing parent directories** | A missing `write_text` target gets its parents created (`mkdir -p`, as the built-in `write` does), with no extra output |

## Configuration

There is no Config schema: the preset row's `config:` mapping is passed through as-is.

| Key | Default | Meaning |
|---|---|---|
| `newFileBom` | `false` | write a UTF-8 BOM when creating a new file |
| `guidance` | `'full'` | three modes: `full` (names the built-ins) / `short` (for when the mask hides them) / `false` (register no section) |
| `root` | `process.cwd()` | fallback workspace when a call has no agent session |

`DSH_TEXT_EDITOR_EOL` (`lf` \| `crlf`) overrides the line-ending inference for **new** files.

## Versus the built-ins

Measured against a real installation (`dsh 0.1.5-rc.2`, `lib/editor.mjs` vs `dsh-tool-fs`), each row
writing the same fixture twice:

| Fixture | Built-in | This plugin |
|---|---|---|
| CRLF file, `write` with CRLF content | 3 CRLF in, 3 out (content is written verbatim) | same |
| CRLF file, `write` with LF content | **3 CRLF in, 0 out** — the file silently becomes LF | CRLF kept: the file's own style wins |
| BOM + CRLF file, either tool | **BOM gone** | BOM kept |
| Anchor missing a trailing space | `FS_EDIT_NOT_FOUND`, no fallback (a re-read is the only recovery) | relaxed line-block match, one `[warn]` line |
| Literal appearing twice | refused (`FS_AMBIGUOUS_EDIT`) unless `replace_all: true` | refused unless `count` declares it |
| Success result text | 128 B, echoing `before` / `after` for the GUI | 17–21 B, echoing nothing |

So the honest accounting is: **one correctness fix (the BOM) and one behaviour fix (line-ending style), plus
cheaper results.** The rest is convenience — anchors that name a position, and a fallback for near-miss anchors.
If you never touch BOM files, the only thing you gain is tokens, and you pay for it with two competing write
tools in the model's catalog.

## Self-test and gates

```powershell
# run from the root of a clone of this repository
node tools/selftest.mjs                 # 148/148 on Windows + Node 24
node tools/check-license.mjs            # 30/30 license / dependency / Node-only gate
node tools/gen-schema.mjs               # embedded schemas still match the DSL
node tools/measure-context.mjs          # per-scenario model-visible bytes
node tools/audit-session.mjs            # reconcile against real session logs (text-shape check)
node tools/audit-session.mjs --tools    # the real tool table of every request/header (mask acceptance)
node tools/probe-mask.mjs               # the mask on real dsh packages: registry semantics (15 checks, exit 2 without them)
node tools/repro-mask.mjs               # the mask on real presets + agents: composition timing (23 checks, exit 2 without them)
```

`npm test` chains the licence gate, the self-test and `measure-context --cap 2048`: no single call may put
more than 2 KB of model-visible text into the context. The current worst scenario is the 1.6 KB ambiguity
hint; a successful call is always two lines, 17–21 B.

These live in the repository only: `tools/` is deliberately outside the `files` whitelist, so the published
package is just the plugin, its preset installer, the docs and the license. Each script's own header documents
what it asserts and why; what follows is the shape of each.

| Tool | Behaviour |
| --- | --- |
| `tools/selftest.mjs` | The end-to-end suite, needing no dsh: BOM/EOL fidelity, all four anchor kinds, `count`, ambiguity refusal, relaxed matching (the similarity threshold pinned on both sides), usage errors, binary/invalid-UTF-8 refusal, majority EOL inference, concurrent writes, parent-directory creation, errno-only failure text — plus a plugin layer (`apply()` on a fake context: registration, the guidance section, every value satisfying `OUTPUT_SCHEMA`, the literal `render()` text, config plumbing, no `.dsh/` left behind), a return-value layer, a policy layer (`read-only` refusals), a mask layer (a fake world for the guard, the membership probe, the sweep, disposal and the unload hook) and a guidance layer. 148 checks |
| `tools/probe-mask.mjs` | Mask registry semantics on the real packages and the real `dsh-agent` registry, mounted on a real scoped context: a masked agent loses `write` / `edit` and naming one yields `UNKNOWN_TOOL`, another composition keeps both, the standing scope still has them registered, an agent with no creation event is still blocked by the apply-time guard, and a host-plane row degrades to guard-only. 15 checks; exit 2 without a dsh installation |
| `tools/repro-mask.mjs` | Mask composition timing on the real `dsh-agent-presets` service: created after the mount, re-linked after creation, first bind, switched away, and a child agent via `composeFrom`, with a foreign-guard host and another composition as controls. 23 checks; the regression test for a timing bug that shipped once (4/7 before the fix), exit 2 without the packages |

### Measuring context cost

| Tool | Behaviour |
| --- | --- |
| `tools/measure-context.mjs` | Drives `apply()` on a simulated context through the real `execute()` → `render()` path, printing input bytes, model-visible bytes, ratio and line count per scenario. `--cap N` exits 1 when a scenario exceeds N bytes; `--static` prints the per-request overhead; `--vs-native` adds the same figures for the host's `write` / `edit` (SKIP without a dsh installation). `--static --vs-native` is the source of the masking figures above |
| `tools/audit-session.mjs` | Reconciles real session logs (`<DSH_HOME>/sessions/`, multi-frame zstd) per call: whether each result matches one of the two documented shapes (`WROTE` + a stat line, or `FAIL` + a reason), whether a success repeats the call's own `file_path`, and whether a result exceeds `--cap` (1024 B by default). Results from before this shape landed are reported separately as legacy. `--tools` switches to the tool-table view described above |
| `tools/gen-schema.mjs` | Checks that the embedded schemas still match the author DSL in the same file. Needs an installed `@deepseek-ai/dsh-tools` (`DSH_TOOLS_ENTRY` overrides the lookup); exit 2 without one |

## Layout

```
lib/core.mjs             # core: BOM/EOL, anchors, matching, atomic write, per-target lock
lib/editor.mjs           # plugin: schemas, validation, registration, read-only mirror (zero-dep ESM)
lib/mask.mjs             # optional row: mask the built-in write / edit per agent (guard + restrict)
preset/preset.yml        # preset name/description, as dsh lists it
scripts/install-preset.mjs  # derives the user preset from the local dsh installation (--mask-native adds the mask)
cordis.patch.yml         # host-plane bundle patch
tools/selftest.mjs       # end-to-end self-test (core + plugin + result text + policy + mask + guidance)
tools/probe-mask.mjs     # mask registry semantics on real dsh packages + registry (exit 2 without them)
tools/repro-mask.mjs     # mask composition timing on real presets + agents (exit 2 without them)
tools/check-license.mjs  # license / dependency / Node-only hygiene gate
tools/gen-schema.mjs     # authoritative source and checker for the embedded JSON Schemas
tools/measure-context.mjs  # per-scenario model-visible bytes + the native-tool comparison
tools/audit-session.mjs  # real session logs: text-shape reconciliation + the --tools tool-table view
```

## License

**Apache-2.0** — see [LICENSE](LICENSE). Copyright 2026 Flotiarenor. The package has **no runtime
dependencies**, so it carries no third-party license obligations of its own. Three notes:

- The embedded JSON Schemas in `lib/editor.mjs` are generated *output* of the `@deepseek-ai/dsh-tools`
  converter (MIT, Copyright (c) 2026 DeepSeek) via `tools/gen-schema.mjs`.
- The preset composition is **not** part of this package: `scripts/install-preset.mjs` reads the one shipped
  with the user's own dsh installation at install time.
- Source files carry an `SPDX-License-Identifier` header, so the license is machine-readable per file.
