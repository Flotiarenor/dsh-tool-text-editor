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
the plugin. Range `>=0.1.0-rc.6 || >=0.1.5-rc.2`, verified against `0.1.0-rc.6` and `0.1.5-rc.2`: npm
admits a prerelease only when its `major.minor.patch` tuple carries a prerelease comparator of its own, so
one clause per verified line keeps a prerelease install from reading as an unmet peer.

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

## Masking the built-in `write` / `edit` (optional)

`lib/mask.mjs` is a separate plugin row: installed into a preset, that preset's sessions have no built-in
`write` / `edit` at all. The installer takes a flag:

```powershell
node scripts/install-preset.mjs --mask-native   # adds the tool-native-edit-mask row and writes guidance: short
```

It removes **2362 B per request** (`node tools/measure-context.mjs --vs-native`): two schemas (1754 B:
`write` 728 + `edit` 1026, sandbox escalation fields included) plus two guidance sections (608 B: 220 +
388); `guidance: short` on the editor row removes another 81 B (241 -> 160), for **2443 B per request**
(~600 tokens).

| Channel | Call | Effect |
| --- | --- | --- |
| Guard, registered in `apply()` on the row's own scope layer | `ctx.tools.guard(...)` | **Order-independent**: the first native call of an agent that joined the preset at any time is refused with a reason naming `edit_text` / `write_text`, and that call narrows the agent, so the next request's table is already clean |
| Tool catalog and execution | `agent.ctx.tools.restrict({ deny: ['write','edit'] })` | The named tools are **gone from the catalog and uncallable**: naming one yields `UNKNOWN_TOOL`; in `deny` mode the guard narrows that agent on the spot |
| Prompt | `agent.ctx.systemPrompt.section({ name: 'tool:write', text: '' })` | An empty same-named section in a nearer layer shadows the two sections `dsh-tool-fs` registers; now a redundant safety net, see the configuration table |
| `agent/created` | listener for an agent created after the mount | That agent is narrowed immediately |
| `tools/change` | emitted by `recompose()` after re-linking an agent's scope (the GUI "switch preset" path) | The row walks `ctx.agents.list()` and narrows every agent of its own composition |
| Leaving the composition | per-agent registrations, each kept as a disposer | `restrict` and the empty shadowing sections sit on the **agent's own layer**, so they survive the preset; each disposer lifts them on re-link to a different preset, without which that agent would have neither the native names nor this plugin's tools (no write tool at all) |

| Mechanism | Detail |
| --- | --- |
| `restrict()` scope | Callable only from a **scoped context** (`agent.ctx`); from the preset's standing scope it is refused, since names registered in that same layer are not restrictable globals |
| Why the guard decides the timing | `AgentPresets.recompose()` re-links a scope parent instead of rebuilding the agent, so an agent the GUI created on the default preset and re-linked to the user's preset afterwards already fired `agent/created` under the old composition, and its listener never sees it. Measured on real session logs: of the `request/header` events of sessions running this preset, 25 still listed the native `write` / `edit` while only 3 were narrowed |
| Membership probe | No import of `@deepseek-ai/dsh-scope` (zero dependencies and `node:`-only builtins are a hard gate, asserted by `tools/check-license.mjs`): the row probes `ctx.tools.guardReason(<a probe exec it minted itself>)`, which walks `exec.agent`'s scope-layer chain and reaches the row's guard only for agents carrying the row's layer, depending on `dsh-tools` alone |
| Verdict | The probe's **object identity**, not its name: `guardReason()` runs before the registry decides whether the tool exists, so invisible names still reach guards ("pick an unused name" would not do), while a real dispatch mints a fresh execution object that never equals the probe or sees the sentinel. That sentinel also rejects a foreign guard refusing every call (the in-process subagent driver carries one; `guardReason` consults the global layer first) |
| Lift rule | The three-state verdict (`member` / `outsider` / `unknown`) lifts a mask only on a definite `outsider`: an unanswerable probe (guard not armed, no `guardReason` in this dsh, a throwing query) or a foreign answer leaves that agent alone, since reading `unknown` as `outsider` would silently undo a working restriction. The price is symmetric and stated: the "switch preset away and get the natives back" half degrades too, so the row logs one warning instead of quietly doing half its job |
| Lifecycle | The per-agent registrations live on the **agent's** fiber, so unloading the row (an HMR reload, `disabled: true` on the preset line) would strand them with nothing to lift them; an unload hook releases every agent the row masked |
| Host-plane install | A row mounted on the host plane (profile layer) has no scope, so its guard lands in the global layer, where narrowing would hit agents of presets that never mounted this plugin. The same probe detects it (a probe carrying no agent is answered only from the global layer) and the row degrades to **guard-only**, with one warning. No config key expresses this: the mount shape decides |

### Can the built-ins still be tested once masked? Yes - four ways

| Way | How |
| --- | --- |
| **Another composition (another preset)** | The mask is a composition fact, not a global switch: an agent of another composition keeps both tools visible and callable, the control group `tools/probe-mask.mjs` and `tools/repro-mask.mjs` assert; a **sibling agent of the same preset** is masked too, deliberately |
| **The probe** | `node tools/probe-mask.mjs` mounts the mask on the real dsh packages and registry (see "Self-test and gates"); 18 checks, exit code 2 without an installed dsh |
| **The built-ins driven directly** | `tools/measure-context.mjs --vs-native` calls `apply()` on the real `dsh-tool-fs` in-process and measures its schemas and sections; no agent is involved, so no mask can reach it |
| **A temporary lift** | Give the `tool-native-edit-mask` row `disabled: true`, or switch it to `mode: 'guard'` |

### `mode: 'guard'`: keep a window open

`mode: 'guard'` keeps the apply-time guard and skips `restrict`, leaving the tools **visible** while
refusing every call with a reason naming `edit_text` / `write_text`. The **schemas are still paid for**
(both tables keep shipping, 1754 B) and the two guidance sections stay shadowed, since guidance left in for
refused calls only invites the model to try; in exchange the built-ins stay callable and observable.

### Mask row configuration

The row has no Config schema either: `config:` is passed through as-is.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `'deny'` | `deny`: the names are gone from the catalog (via `restrict`) and the guard refuses whatever it can still see. `guard`: the tools stay visible and every call is refused |
| `deny` | `['write','edit']` | the names to narrow; only names that agent actually sees are named |
| `sections` | `['tool:write','tool:edit']` | the guidance sections to shadow with an empty section; `[]` turns the shadowing off. Now a **redundant safety net**: since dsh 0.1.5-rc.2 `dsh-tool-fs` evaluates its guidance sections per scope (`({ scope }) => ctx.tools.get('write', scope) === undefined ? '' : '...'`), so they disappear on their own once the tool is narrowed |

### Boundaries

| Boundary | Meaning |
| --- | --- |
| **Not an authority boundary** | This is the live visibility composition DSH documents: the built-ins **stay registered** (a plugin/tool inventory may still list them) and a shell command can still write files; `tools/probe-mask.mjs` asserts exactly that |
| **A composition fact, not a global switch** | The row touches only the agents that joined its composition: the sibling agent of the same preset included, an agent of another preset not at all. A host-plane install is the one exception, and it never narrows |
| **Names are configuration** | `deny` / `sections` are config, so a rename or split of `tool-fs` is a config edit |
| **Only visible names are named** | A preset without `tool-fs` gets no restriction at all (never an unknown-name error) while the section shadowing still applies, and the guard re-asks visibility per call (`tools.get(name, exec.agent)`), leaving a name that exists elsewhere but not for the caller alone |

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
| No k-th hit | `count` is the single disambiguation knob: *confirmation* (declare the expected hits; a mismatch refuses), not *selection* (take one, leave the rest). To change one occurrence among several, make the anchor unique by quoting a longer `old_text` or naming the place with `lines` / `grep`; a wrong anchor then fails loudly instead of editing the wrong line silently |

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

**A successful call echoes neither the change nor the path.** Results are appended to the session history,
so an echo accumulates per call while the caller has just sent `new_text`; `replace@17 +1/-1` already
reports which lines changed and by how much, and `read` is one call away. Model-visible bytes are
independent of input size (a 400 KB single-line write still returns two lines / 17 B). The path is bound to
its call (`tool/result` carries `source.callId`) and the caller's `file_path` argument is in the same turn's
history, so echoing it adds zero information — and it costs: across 86 results in 79 real session logs a
success averaged 116 B, of which the `WROTE <path>` line was 55.6 B (48%), against 66 B path-free (−43%).
The path survives where it carries meaning: in a failure **reason** that has to name the file, and in the
GUI's own rendering of the call arguments.

Nothing else is written: no backup, no ledger, no diff projection. What the change was is visible in the
GUI from the call's own arguments (`old_text` / `grep` / `lines` plus `new_text`), which the host already
renders, and the previous content is one `read` away. A failing system call is reported as errno plus one
reason (`ENOENT`, `ENOTDIR`, `EISDIR`, `EACCES`, …); the absolute paths and internal temp filename
(`.<name>.<pid><ts>.tmp`) of the raw Node message stay out of the model context.

The one shape the built-ins offer and this plugin does not is a diff body in the result: the built-in `write`
returns `before` / `after` so the host can draw a card, which costs 128 B per call. Here the host draws from
the call arguments instead, which it already has.

## Deliberate limitations

| Limitation | Detail |
| --- | --- |
| **Writes bypass `ctx.fs`** | The plugin writes the file itself: the fs-observation policy (read-before-write, version freshness), the sandbox, `sandbox_permissions` escalation and Windows DACL preservation are all skipped, and the atomic write is its own (same-directory temp file + fsync + rename). Nothing else enforces anything on this path, so the session file policy is mirrored for the one mode that forbids writing: `read-only` refuses both tools before any I/O, naming the session policy rather than the path. `sandboxPolicy` is consumed opportunistically (`ctx.get`); absent, or answered by a throwing resolver, the previous behaviour stands instead of writes bricking |
| **Only `read-only` is mirrored, and no path is restricted** | Under `workspace-write` and `danger-full-access` both tools write **any** path: outside the workspace, inside `.dsh/` or `.git/`, and through a junction / symlink pointing out of the workspace. The path guard this package used to carry decided by **string prefix**, so a symlink walked around it (a guard in appearance only) while it blocked positions the model may write in a full-access session. The plugin is therefore **not** a security boundary and does not replace host policy, sandbox or approvals: to restrict where writes land, use the session file policy, the sandbox and `sandbox_permissions` (or a shell-side guard); this package takes no part in that judgement |
| **Line anchors are not content-verified** | `lines` and `before` / `after <line>` locate text by line number alone: a wrong number does not fail, it edits somewhere else. Where the anchor must be verifiable, use `old_text` or `grep` |
| **Per-target serialization is per process** | An in-process queue per target plus an atomic write keeps parallel tool calls from overwriting each other, but another dsh instance, an editor or any other process writing the same file still can, and external changes are not detected |
| **UTF-8 text only** | Files containing NUL bytes (binary) or invalid UTF-8 are refused; a file marked read-only by the OS is refused too (the atomic rename fails with `EPERM`) and the attribute is never silently cleared |
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

So the honest accounting is: **one correctness fix (the BOM) and one behaviour fix (line-ending style),
plus cheaper results.** The rest of the gap is convenience — anchors that name a position, and a fallback
for near-miss anchors. If you never touch BOM files, the only thing you gain is tokens (roughly 3–45 % per
call depending on the scenario), and you pay for it with two competing write tools in the model's catalog.

## Self-test and gates

```powershell
# run from the root of a clone of this repository
node tools/selftest.mjs                 # 150/150 on Windows + Node 24
node tools/check-license.mjs            # 30/30 license / dependency / Node-only gate
node tools/gen-schema.mjs               # embedded schemas still match the DSL
node tools/measure-context.mjs          # per-scenario model-visible bytes
node tools/audit-session.mjs            # reconcile against real session logs (text-shape check)
node tools/audit-session.mjs --tools    # the real tool table of every request/header (mask acceptance)
node tools/probe-mask.mjs               # the mask on real dsh packages: registry semantics (18 checks, exit 2 without them)
node tools/repro-mask.mjs               # the mask on real presets + agents: composition timing (23 checks, exit 2 without them)
```

`npm test` chains the licence gate, the self-test and `measure-context --cap 2048`: no single call may put
more than 2 KB of model-visible text into the context. The current worst scenario is the 1.6 KB ambiguity
hint; a successful call is always two lines, 17–21 B.

These live in the repository only: `tools/` is deliberately outside the `files` whitelist, so the published
package is just the plugin, its preset installer, the docs and the license. `HANDOVER.md` is the internal dev
handover (state, evidence, open work, operational steps), unpublished as well; `tools/check-license.mjs`
keeps it under the same line-ending and CJK-spacing rules as the two READMEs.

| Tool | Behaviour |
| --- | --- |
| `tools/selftest.mjs` | Covers BOM/EOL fidelity, all four anchor kinds, `count`, ambiguity refusal, relaxed matching reports (including the similarity threshold pinned on both sides), usage errors, binary/invalid-UTF-8 refusal, editable `.dsh/` and outside-workspace paths (no path guard), majority EOL inference, multi-hunk diffs, end-of-file newline changes, concurrent writes, parent-directory creation and errno-only failure text. Five suites: **plugin-layer** (`apply()` on a fake context: tool registration, the guidance section, every returned value satisfying `OUTPUT_SCHEMA` with exactly four fields, the literal `render()` text, the `root` / `newFileBom` plumbing, and that a write leaves no `.dsh/` behind); **return-value** (two lines at any input size, no change content, no repeated path); **policy** (`read-only` refuses both tools before any I/O while `workspace-write` / `danger-full-access` keep writing and a missing or throwing policy service does not brick writes); **mask** (a fake world for guard registration in `apply()`, the membership probe, `guardReason()` reaching the row's guard only for members of the composition, the `tools/change` sweep, leave-path disposal and rejoin, the host-plane degradation, only visible names named, what each mode calls, the empty sections and their orders, no double registration, an unusable probe never lifting a mask, a failed guard registration logged, a throwing registry or prompt service never escaping the listener); **guidance** (`full` / `short` / `false` plus a loud failure on an unknown value) |
| `tools/probe-mask.mjs` | Rebuilds the preset mount shape with the real dsh packages (`dsh-tools` + `dsh-scope` + `dsh-system-prompt` + `cordis`) and the real `dsh-agent` registry: the mask row is mounted with a real scoped context (the guard has to land on that layer in `apply()`), and `agent/created` is dispatched by the registry instead of being handed to the listener by hand. It asserts the mask's registry semantics: a masked agent loses `write` / `edit` from its catalog, naming one yields `UNKNOWN_TOOL`, an agent of another composition keeps both, the native guidance disappears from the masked prompt only, the standing scope still has them registered (visibility composition, not authority), an agent that never got a creation event is still blocked by the apply-time guard and narrowed right away, `mode: 'guard'` keeps them visible while refusing the call, and a row mounted on the host plane degrades to guard-only and says so. 18 checks; exit code 2 without a dsh installation |
| `tools/repro-mask.mjs` | (npm script `npm run repro:mask`) Drives the **real** `@deepseek-ai/dsh-agent-presets` service and **real** `@deepseek-ai/dsh-agent` registry inside a temp directory with real `agent.cordis.yml` compositions (this repo's `lib/mask.mjs` listed by absolute path), asserting the resulting tool table on every composition path: created after the mount, re-linked after creation (`recompose()`), first-time bind, switching away, and a child agent that joined its parent's composition, plus a host whose own guard refuses every call (the membership probe must not be fooled by it) and an agent of another composition as the control. 23 checks; the regression test for the composition-timing bug (4/7 before the fix), needing the same dsh packages (exit 2 without them) |

### Measuring context cost

| Tool | Behaviour |
| --- | --- |
| `tools/measure-context.mjs` | Drives `apply()` on a simulated context through the real `execute()` → `output.render()` path, printing input bytes, model-visible bytes, ratio and line count per scenario. `--cap N` exits 1 when a scenario exceeds N bytes; `--static` prints the per-request overhead; `--vs-native` adds the same figures for the host's `write` / `edit` (SKIP without a dsh installation). `--static --vs-native` is the source of the masking table above |
| `tools/audit-session.mjs` | Reconciles real session logs (`<DSH_HOME>/sessions/`, multi-frame zstd, per call) and checks three things: whether each result matches one of the two documented shapes (`WROTE` + a stat line, or `FAIL` + a reason; a diff body, a `=== ` header, an `OK ` tail or an internal temp filename is flagged as a mismatch), whether a successful result repeats the call's own `file_path` (the regression this shape exists to prevent), and whether a result exceeds `--cap` (1024 B by default). Results from before this shape landed are reported separately as legacy |
| `tools/audit-session.mjs --tools` | Switches the view: every real session log prints each `request/header` event's actual tool table with a verdict line (`native write/edit: PRESENT (...)` vs `masked`, plus whether `edit_text` / `write_text` are present) and a summary. That table is the truth about what the model was offered, so it is the only acceptance check for whether the mask took effect: `node tools/audit-session.mjs --tools` |
| `tools/gen-schema.mjs` | Needs an installed `@deepseek-ai/dsh-tools`: it looks for one under the dsh profile's `node_modules` and under the npm global prefix, and `DSH_TOOLS_ENTRY` overrides that lookup. It exits 2 when it cannot find one |

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
HANDOVER.md              # internal dev handover: findings, evidence, open work, operations
```

## License

**Apache-2.0** — see [LICENSE](LICENSE). Copyright 2026 Flotiarenor. The package has **no runtime
dependencies**, so it carries no third-party license obligations of its own. Three notes:

- The embedded JSON Schemas in `lib/editor.mjs` are generated *output* of the `@deepseek-ai/dsh-tools`
  converter (MIT, Copyright (c) 2026 DeepSeek) via `tools/gen-schema.mjs`.
- The preset composition is **not** part of this package: `scripts/install-preset.mjs` reads the one shipped
  with the user's own dsh installation at install time.
- Source files carry an `SPDX-License-Identifier` header, so the license is machine-readable per file.
