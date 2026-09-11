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

The installer takes the preset composition **shipped with your own dsh installation**
(`config/agent-presets/standard/agent.cordis.yml`; choose another with `--base`, or point at any file
with `--from` / `DSH_PRESET_SOURCE`), splices in the `tool-text-editor` row pointing at this
checkout's `lib/editor.mjs`, and writes `<DSH_HOME>\.agent-presets\texteditor\` (`DSH_HOME` defaults
to `~/.dsh`). **Restart `dsh web`, then start a new session on preset `texteditor`.**

Nothing of dsh's own composition is copied into this repository, so the preset also tracks the dsh
version you have installed — re-run with `--force` after upgrading dsh.

### Option 2 — install into the profile (available to every session)

`dsh plugin add` accepts several kinds of source, and every one of them works here: the package is
prebuilt, dependency-free ESM, so there is no `prepare`/`build` step to authorize or run.

| Source | Command |
|---|---|
| a local checkout | `dsh plugin --profile web add link:<absolute-path-to-this-checkout>` |
| npm, once published | `dsh plugin --profile web add @flotiarenor/dsh-tool-text-editor` |
| a packed tarball | `pnpm pack`, then `dsh plugin --profile web add ./<the-file-it-printed>.tgz` |
| a git repository | `dsh plugin --profile web add github:<owner>/dsh-tool-text-editor` |

Verify the layer without starting anything, then restart:

```powershell
dsh --profile web --dump-config   # look for the "# == @flotiarenor/dsh-tool-text-editor" layer
```

The tool names do not collide with the built-ins, so a host-plane insert is safe. The trade-off is
that both tools (and their guidance section) show up in **every** session. Uninstall with
`dsh plugin --profile web remove @flotiarenor/dsh-tool-text-editor`.

Both installs may coexist: the preset layer shadows the host layer with an identical definition.

## Tools

**`edit_text`** — targeted replacement. `file_path` and `new_text` are required; give **exactly one**
anchor: `old_text` (literal), `grep` (regex; the matched line/block including its trailing newline),
or `lines` (e.g. `"263:270"`). `mode` is `replace` (default) / `after` / `before` / `append` /
`prepend`; also `count` (require exactly N occurrences and replace all), `nth` (k-th occurrence),
`strict`, `dry_run`, `note`. `count` and `nth` are mutually exclusive.

**`write_text`** — create or fully replace a file: `file_path` + `content`; creation needs no flag,
an overwrite is backed up first, and a brand-new file follows the **majority** line-ending style of
its siblings (same extension first) with no BOM by default.

Both **write by default** (like the built-ins); pass `dry_run: true` to preview. The returned text
always includes the diff.

## Deliberate limitations

- Writing bypasses `ctx.fs`: no fs-observation policy (read-before-write / version freshness), no
  sandbox or `sandbox_permissions` escalation, no Windows DACL preservation.
- `lines` / `before <line>` are **blind anchors**: a wrong line number never fails, it edits the
  wrong place. Prefer `old_text` / `grep`.
- Per-target serialization covers **this process only**: parallel tool calls cannot overwrite each
  other (in-process queue plus an atomic write), but another dsh instance or your editor still can,
  and external changes are not detected.
- Binary content (NUL) and invalid UTF-8 are refused; `.git/`, `.dsh/`, and any path outside the
  workspace are refused.

## Configuration

There is no Config schema: the preset row's `config:` mapping is passed through as-is.

| Key | Default | Meaning |
|---|---|---|
| `backup` | `true` | copy the previous content into `artifactsDir/backups` before writing |
| `ledger` | `true` | append a JSONL record to `artifactsDir/edits.log` |
| `artifactsDir` | `<workspace>/.dsh` | where backups and the ledger live |
| `newFileBom` | `false` | write a UTF-8 BOM when creating a new file |
| `context` | `3` | context lines in the unified diff |
| `root` | `process.cwd()` | fallback workspace when a call has no agent session |

`DSH_TEXT_EDITOR_EOL` (`lf` \| `crlf`) overrides the line-ending inference for **new** files.

## Self-test and gates

```powershell
# run from the root of a clone of this repository
node tools/selftest.mjs        # 75/75 on Windows + Node 24
node tools/check-license.mjs   # license / dependency / Node-only gate
node tools/gen-schema.mjs      # embedded schemas still match the DSL
```

`tools/selftest.mjs` covers BOM/EOL fidelity, `dry_run`, all four anchor kinds, `count`, ambiguity
refusal, usage errors, binary/invalid-UTF-8 refusal, `.dsh/` and outside-workspace guards, majority
EOL inference, multi-hunk diffs, end-of-file newline changes and concurrent writes — **plus a
plugin-layer suite** that drives `apply()` with a fake context and asserts tool registration, the
guidance section, that every returned value satisfies `OUTPUT_SCHEMA`, the `render()` text, and the
config plumbing (`root` / `backup` / `ledger` / `newFileBom`).

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
```

Backups and the ledger use fixed, documented names and fields: one file per edit under
`.dsh/backups/`, named `<flattened-absolute-path>@<timestamp>`, and one JSON object per line in
`.dsh/edits.log` (`time`, `id`, `tool`, `file`, `abspath`, `action`, `kinds`, `line_start`,
`line_end`, `added`, `removed`, `bom`, `eol`, `backup`, `summary`).

## Publishing checklist

1. Drop `private: true` from `package.json` (`publishConfig.access: public` is already set — a scope
   is not public by default).
2. Keep `engines.node` and the `@deepseek-ai/dsh-tools` peer range in step with the dsh release you
   target — the peer range is what plugin inventory and market tooling read as your compatibility
   statement.
3. Preview the tarball with `pnpm pack`: the `files` whitelist should yield `LICENSE` + `lib` +
   `preset` + `cordis.patch.yml` + both READMEs, and nothing else.
4. From a clean working tree, publish against npmjs explicitly:
   `pnpm publish --registry https://registry.npmjs.org`. `prepublishOnly` runs the license gate and
   the self-test first; a mirror such as npmmirror cannot accept publishes.
5. Tag `v<version>` to match `package.json`.

## License

**Apache-2.0** — see [LICENSE](LICENSE). Copyright 2026 Flotiarenor. The package has **no runtime
dependencies**, so it carries no third-party license obligations of its own. Three notes:

- The embedded JSON Schemas in `lib/editor.mjs` are generated *output* of the `@deepseek-ai/dsh-tools`
  converter (MIT, Copyright (c) 2026 DeepSeek) via `tools/gen-schema.mjs`.
- The preset composition is **not** part of this package: `scripts/install-preset.mjs` reads the one
  shipped with the user's own dsh installation at install time.
- Source files carry an `SPDX-License-Identifier` header, so the license is machine-readable per file.
