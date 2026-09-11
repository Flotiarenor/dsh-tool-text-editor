// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * bench-tokens.mjs —— 原生 `write`/`edit` 与本插件 `edit_text`/`write_text` 的 **token 消耗对照跑分**。
 *
 * ## 为什么不是"再量一次字节"
 *
 * `tools/measure-context.mjs` 量的是本插件自己的返回值形状。这个脚本要回答的是另一个问题：
 * **同一个任务，交给哪套工具更省模型上下文**，包括
 *
 *   * 静态开销：工具 schema + 系统提示词里的工具引导段（每个请求都要重发的那部分）；
 *   * 动态开销：一次调用的**入参**（模型自己写出来的 tool-call，也进历史）与**结果文本**
 *     （tool-result，追加进历史且从此每轮重发）；
 *   * 失败与重试：锚点不精确时原生会失败，失败本身要花 token，而且往往要**再读一次文件**才修得好；
 *   * 会话累积：一个真实会话里几十次调用叠起来是多少。
 *
 * ## 方法
 *
 * 1. **真栈跑，不mock。** 用真实的 cordis `Context` 挂真实的 `dsh-tools` / `dsh-system-prompt` /
 *    `dsh-fs-local`（真正的 `ctx.fs` 后端）/ `dsh-tool-fs`（原生 read/write/edit）与本插件，
 *    然后调用 `ctx.tools.execute()` —— 返回的就是 dsh 会写进会话日志、下一轮原样重发的那份结果。
 * 2. **两侧都真跑。** 每个场景的每个候选写法都在各自的工作目录里执行，读回文件校验最终内容；
 *    **只有真正成功的写法才参与计价**（因此"最短锚点"不是猜的，是跑出来的）。
 * 3. **每侧取自己的最优写法。** 原生可选项 ⊂ 插件可选项（插件的 `old_text` 与原生 `old_string`
 *    等价，宽松匹配只会让它更短；`lines`/`grep` 是额外两条路）。所以这不是"拿模型的失误当论点"，
 *    而是给两侧都配上称职模型会选的写法，让差距只剩工具设计本身。
 * 4. **计价用 dsh 自己的估算器**：`@deepseek-ai/dsh-token-meter` 的 `estimateContent`
 *   （`ceil(chars/4)` + 每块 4 token）。GUI 里的上下文压力条就是按它算的。
 *
 * ## 用法
 *
 *   node tools/bench-tokens.mjs                    # 全部：静态 + 场景 + 会话聚合
 *   node tools/bench-tokens.mjs --logs             # 再扫一遍 <DSH_HOME>/sessions 的真实调用
 *   node tools/bench-tokens.mjs --assert           # 回归门禁（退出码 1 = 有场景不达预期）
 *   node tools/bench-tokens.mjs --json out.json    # 机器可读结果
 *   node tools/bench-tokens.mjs --md BENCH.md      # Markdown 报表
 *   node tools/bench-tokens.mjs --only near-miss   # 只跑 id/title 含该子串的场景
 *
 * 需要一份装有 `cordis` / `dsh-tools` / `dsh-system-prompt` / `dsh-scope` / `dsh-fs-local` /
 * `dsh-tool-fs` / `dsh-token-meter` 的 dsh（`DSH_PACKAGES_ROOT` 可显式指定）；找不到时退出码 2。
 * 零第三方依赖，不写入仓库文件（作业目录只在临时目录）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

import * as editorPlugin from '../lib/editor.mjs'

// ── 0. 参数 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)
const flagValue = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const ONLY = flagValue('--only', '')
const JSON_OUT = flagValue('--json', '')
const MD_OUT = flagValue('--md', '')
const WITH_LOGS = hasFlag('--logs')
const ASSERT = hasFlag('--assert')

const bytes = (value) => Buffer.byteLength(value ?? '', 'utf8')
const pct = (part, whole) => (whole === 0 ? 0 : (part / whole) * 100)
const signed = (value) => (value >= 0 ? `-${value}` : `+${-value}`)
const tok = (value) => Math.round(value)

// ── 1. 找 dsh 包 ──────────────────────────────────────────────────────────────

const NEEDED = ['cordis', 'dsh-tools', 'dsh-system-prompt', 'dsh-scope', 'dsh-session-projection', 'dsh-fs-local', 'dsh-fs-sandbox', 'dsh-sandbox-policy', 'dsh-tool-fs', 'dsh-token-meter']

/** 与 `tools/probe-mask.mjs` 同一套布局枚举：`DSH_PACKAGES_ROOT` → profile → npm 全局前缀。 */
function findPackages() {
  const candidates = []
  const add = (root, nested) => {
    if (typeof root !== 'string' || root === '') return
    candidates.push(join(root, '@deepseek-ai'))
    if (nested) candidates.push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  }
  const explicit = process.env.DSH_PACKAGES_ROOT
  if (typeof explicit === 'string' && explicit !== '') candidates.push(explicit)
  add(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules'), false)
  const globalRoots = process.platform === 'win32'
    ? [process.env.APPDATA === undefined ? '' : join(process.env.APPDATA, 'npm', 'node_modules')]
    : ['/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.npm-global', 'lib', 'node_modules')]
  for (const root of globalRoots) add(root, true)
  return candidates.find((dir) => NEEDED.every((pkg) => existsSync(join(dir, pkg, 'lib', 'index.js'))))
}

const PACKAGES = findPackages()
if (PACKAGES === undefined) {
  console.error(`SKIP 找不到齐备的 dsh 包（需要 ${NEEDED.join(' / ')}）`)
  console.error('     用 DSH_PACKAGES_ROOT 指向含这些包的 @deepseek-ai 目录后重跑。')
  process.exit(2)
}
const pkgUrl = (name, file = 'lib/index.js') => pathToFileURL(join(PACKAGES, name, file)).href

const { Context } = await import(pkgUrl('cordis'))
const { ToolRuntime } = await import(pkgUrl('dsh-tools'))
const { SystemPrompt, renderPrompt } = await import(pkgUrl('dsh-system-prompt'))
const { createScope } = await import(pkgUrl('dsh-scope'))
const { LocalFileSystem } = await import(pkgUrl('dsh-fs-local'))
const toolFs = await import(pkgUrl('dsh-tool-fs'))
const { estimateContent: hostEstimate } = await import(pkgUrl('dsh-token-meter', 'lib/types/estimate.js'))

/** 工具 schema 与系统提示词的静态计价（与宿主 `estimateContent` 同式，找不到时兜底）。 */
const estimate = typeof hostEstimate === 'function'
  ? hostEstimate
  : (() => {
    console.warn('WARN 找不到 dsh-token-meter，退回同式的本地估算（ceil(chars/4) + 4/块）')
    const walk = (blocks) => {
      let tokens = 0
      for (const block of blocks) {
        if (block.type === 'text' || block.type === 'reasoning') tokens += Math.ceil(block.text.length / 4) + 4
        else if (block.type === 'tool-call') tokens += Math.ceil(block.name.length / 4) + Math.ceil(block.arguments.length / 4) + 4
        else if (block.type === 'tool-result') tokens += walk(block.content) + 4
        else tokens += 4 + Math.ceil(JSON.stringify(block).length / 4)
      }
      return tokens
    }
    return walk
  })()

/** 模型自己发出的 tool-call 块（`name` + `arguments` 的 JSON 文本）计价。 */
const callTokens = (name, args) => estimate([{ type: 'tool-call', name, arguments: JSON.stringify(args) }])
/** tool-result 块计价。 */
const resultTokens = (content) => estimate([{ type: 'tool-result', content: content ?? [] }])
/** 一次 `ctx.tools.execute()` 结果里模型可见的全部文本。 */
const resultText = (result) => (result?.content ?? []).map((block) => block.text ?? '').join('')
/** 结果文本的字节数（列里做交叉参考，主指标是 token）。 */
const resultBytes = (result) => bytes(resultText(result))

// ── 2. 真栈挂载 ───────────────────────────────────────────────────────────────

const READ_CAPS = { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 204_800, readStreamMinSize: 4096 }

/**
 * 挂一套与 dsh 一致的组合，返回可用于 `ctx.tools.execute()` 的上下文。
 *
 * 层次照抄 dsh：宿主平面（`ctx.fs` = 真实的 LocalFileSystem）→ 常驻作用域（原生 tool-fs 行 +
 * 本插件行，等价于 preset 的 standing 层）→ agent 作用域（工具可见性按作用域组合）。
 *
 * @param kind - `base`（只有 read）/ `native` / `plugin` / `plugin-short` / `plugin-masked` / `plugin-masked-short`
 * @param dir - 作业目录（会话 cwd，也是 `ctx.fs` 的相对路径基准）
 * @param options - `sandbox: true` 时挂真实 `dsh-sandbox-policy`（危险模式下原生 schema 会多两个升权字段）
 * @returns 上下文、agent、作用域与两侧的工具表
 */
async function mount(kind, dir, options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  if (options.sandbox === true) {
    // 真实的沙箱组合：先挂策略服务，再挂**沙箱版** fs 后端（`ctx.fs` 换成它，工具层不变）。
    //
    // 顺序有讲究：0.1.5-rc.2 起 `SandboxPolicyService` 自己 `static inject = ['sessionProjections']`
    // 并改用 `ctx.sessionProjections.stateOf(session, 'sandboxMode')`，所以投影登记表必须先挂上，
    // 否则策略行不落地 → 沙箱版 fs 的 `inject: ['sandboxPolicy']` 解析不了 → `ctx.fs` 根本不存在
    // （症状是后面 `createScope(host)` 抛 "Cannot read properties of undefined"）。
    const projection = await import(pkgUrl('dsh-session-projection'))
    const policy = await import(pkgUrl('dsh-sandbox-policy'))
    const { default: SandboxedFileSystem } = await import(pkgUrl('dsh-fs-sandbox'))
    await ctx.plugin(projection.SessionProjectionRegistry ?? projection.default)
    await ctx.plugin(policy.default, { mode: options.mode ?? 'danger-full-access', workspaceRoot: dir })
    await ctx.plugin(SandboxedFileSystem, { cwd: dir })
  } else {
    await ctx.plugin(LocalFileSystem, { cwd: dir })
  }
  let host
  await ctx.plugin({ name: 'bench-host', inject: ['tools', 'systemPrompt', 'fs'], apply(c) { host = c } })
  if (host === undefined) {
    throw new Error('bench: 宿主组合没挂上（tools / systemPrompt / fs 有一个没解析）——dsh 换了服务名或少了 inject 前置')
  }

  const standingKey = { kind: 'standing', id: `bench:${kind}` }
  const standing = createScope(host, standingKey)
  if (kind !== 'none') await standing.ctx.plugin(toolFs, READ_CAPS)
  if (kind.includes('plugin')) {
    await standing.ctx.plugin(editorPlugin, {
      backup: false,
      ledger: false,
      root: dir,
      guidance: kind.includes('short') ? 'short' : 'full',
    })
  }

  const agent = { id: `bench:${kind}`, kind: 'agent', session: { header: { cwd: dir }, events: [] } }
  const scope = createScope(host, agent, { parent: standingKey })
  agent.ctx = scope.ctx

  // 只读组合：直接用注册表把原生两个写工具从这个 agent 的可见面去掉（mask 的 `mode: 'deny'` 就是这条）。
  if (kind === 'read') agent.ctx.tools.restrict({ deny: ['write', 'edit'] })
  if (kind.includes('masked')) {
    // 屏蔽组合走**真实**的 lib/mask.mjs（它同时清掉工具与原生引导段），而不是在这里复刻它。
    const { apply: applyMask } = await import('../lib/mask.mjs')
    const listeners = []
    const warnings = []
    applyMask(
      { on: (event, listener) => listeners.push([event, listener]), logger: { warn: (message) => warnings.push(String(message)) } },
      { mode: 'deny', ...(options.mask ?? {}) },
    )
    for (const [event, listener] of listeners) if (event === 'agent/created') listener({ agent })
    if (warnings.length > 0) console.warn(`WARN mask: ${warnings.join(' | ')}`)
  }

  return { ctx, agent, scope, host, dir }
}

/** agent 视角的工具表 JSON（宿主就是把它塞进 `header.tools` 发出去的）。 */
const schemasOf = (harness) => harness.ctx.tools.schemas(harness.agent)
/** agent 视角的完整系统提示词文本。 */
const promptOf = async (harness) => renderPrompt(await harness.ctx.systemPrompt.assemble({ scope: harness.agent }))

/** 在给定上下文里真跑一次工具调用，返回 dsh 规范结果。 */
function executeIn(harness, tool, args, callId) {
  return harness.ctx.tools.execute({
    callId,
    name: tool,
    arguments: args,
    agent: harness.agent,
    signal: new AbortController().signal,
  })
}

// ── 3. 静态开销 ───────────────────────────────────────────────────────────────

/**
 * 逐个组合量"每个请求都要重发"的那部分：工具 schema JSON + 系统提示词里的工具引导段。
 *
 * 计价直接用宿主的两把尺子：`tools` 走 `estimateToolsTokens` 的式子（`ceil(JSON.stringify(tools)/4)+4`），
 * `system` 走 `estimateSystemTokens` 的式子（`ceil(system.length/4)+4`）——GUI 的上下文压力条就是这两项。
 */
async function staticReport() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bench-static-'))
  const configs = [
    ['无文件工具（基线）', 'none', {}],
    ['只有 read', 'read', {}],
    ['原生 read+write+edit（无沙箱后端）', 'native', {}],
    ['原生 read+write+edit（沙箱后端 danger-full-access）', 'native', { sandbox: true }],
    ['原生 + 插件（guidance full）', 'plugin', { sandbox: true }],
    ['原生 + 插件（guidance short）', 'plugin-short', { sandbox: true }],
    ['插件 + 屏蔽原生（guidance short，无 escape）', 'plugin-masked-short', { sandbox: true }],
    ['插件 + 屏蔽原生 + escape（native_edit/native_write 可见）', 'plugin-masked-short', { sandbox: true, mask: { escape: true } }],
  ]
  const measured = []
  for (const [label, kind, options] of configs) {
    const harness = await mount(kind, dir, options)
    const schemas = schemasOf(harness)
    const toolsJson = JSON.stringify(schemas)
    const prompt = await promptOf(harness)
    const perTool = schemas.map((schema) => ({
      name: schema.name,
      descriptionBytes: bytes(schema.description),
      parametersBytes: bytes(JSON.stringify(schema.parameters)),
    }))
    measured.push({
      label,
      kind,
      sandbox: options.sandbox === true,
      toolNames: schemas.map((schema) => schema.name).sort(),
      perTool,
      toolsBytes: bytes(toolsJson),
      promptBytes: bytes(prompt),
      // 与宿主 estimateToolsTokens / estimateSystemTokens 同式。
      toolsTokens: estimate([{ type: 'text', text: toolsJson }]),
      promptTokens: estimate([{ type: 'text', text: prompt }]),
      totalBytes: bytes(toolsJson) + bytes(prompt),
      totalTokens: estimate([{ type: 'text', text: toolsJson }]) + estimate([{ type: 'text', text: prompt }]),
    })
  }
  rmSync(dir, { recursive: true, force: true })
  return measured
}

// ── 4. 锚点助手（两侧的"最优写法"都由它从真实文件文本推出来） ──────────────────

function countOccurrences(text, needle) {
  let count = 0
  let index = 0
  for (;;) {
    const found = text.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * 含 `[start,end)` 且在全文中**只出现一次**的最短子串 —— 原生 `edit` 能做到的理论下界
 * （锚点再短就会命中多处，`edit` 直接拒绝写盘）。
 * @returns 锚点文本。
 */
function minimalUniqueAnchor(text, start, end) {
  let best = null
  for (let left = start; left >= 0; left -= 1) {
    for (let right = Math.max(end, left + 1); right <= text.length; right += 1) {
      const candidate = text.slice(left, right)
      if (best !== null && candidate.length >= best.length) break
      if (countOccurrences(text, candidate) === 1) {
        best = candidate
        break
      }
    }
    if (best !== null && left === start) break
  }
  return best ?? text.slice(start, end)
}

/** 从 `text` 里取整行块（1-based，含尾换行），用于 `lines` 锚点与 `new_text`。 */
function lineBlock(text, from, to) {
  const lines = text.split('\n')
  return lines.slice(from - 1, to).join('\n') + '\n'
}

/** 第 n 行（1-based，不含换行）。 */
function lineAt(text, n) {
  return text.split('\n')[n - 1]
}

// ── 5. 场景 ───────────────────────────────────────────────────────────────────
//
// 每个场景声明 seeds（两侧各自一份，内容完全相同）、一个共享的 read、以及两侧各自的候选写法。
// 候选写法是函数：给作业目录，返回 `{ tool, args }` 序列；多步就是"失败后重读再试"。

/** 场景 1 的种子文件：24 行配置，`30000` 出现两次（考的是"锚点必须唯一"）。 */
const CONFIG_JS = [
  '// service configuration',
  'const defaults = {',
  "  host: '127.0.0.1',",
  '  port: 8080,',
  '  timeoutMs: 30000,',
  '  retries: 3,',
  '  verbose: false,',
  "  logLevel: 'info',",
  '}',
  '',
  'export function build(overrides = {}) {',
  '  return { ...defaults, ...overrides }',
  '}',
  '',
  'export const POOL = {',
  '  min: 2,',
  '  max: 10,',
  '  idleMs: 30000,',
  '}',
  '',
  'export default defaults',
  '',
].join('\n')
const CONFIG_JS_EDITED = CONFIG_JS.replace('  timeoutMs: 30000,', '  timeoutMs: 60000,')

/** 场景 2 的种子：20 个近乎逐字重复的 8 行函数（160 行）。 */
function repeatedHandlers(count) {
  const blocks = []
  for (let i = 0; i < count; i += 1) {
    blocks.push([
      `function handle${i}(req, res) {`,
      '  const ok = validate(req)',
      '  if (!ok) {',
      "    throw new Error('invalid request')",
      '  }',
      `  return res.send({ id: ${i} })`,
      '}',
      '',
    ].join('\n'))
  }
  return blocks.join('\n')
}
const HANDLERS_JS = repeatedHandlers(20)
/** 目标：第 15 个 block（1-based 行 113-119）里那一行 `throw`。 */
const HANDLER_TARGET_LINE = 14 * 8 + 4 // 116
/** 只改这一行（用来做最终内容校验：把"改对了"变成可执行的断言）。 */
const HANDLERS_EDITED = (() => {
  const lines = HANDLERS_JS.split('\n')
  lines[HANDLER_TARGET_LINE - 1] = "    throw new Error('invalid request: ' + req.id)"
  return lines.join('\n')
})()

/** 场景 3 的种子：20 行 × 约 5 KB 的宽表。 */
const WIDE_CSV = Array.from({ length: 20 }, (_, i) => `row${i}|${'y'.repeat(4990)}|tag${i}`).join('\n') + '\n'

/** 场景 4 的种子：40 行，其中 12-27 行是一整块要被重写的实现。 */
const LEGACY_JS = [
  '// legacy exporter',
  'import { readFileSync } from \'node:fs\'',
  '',
  'const HEADER = \'id,value\'',
  '',
  'function pad(value, width) {',
  '  let out = String(value)',
  '  while (out.length < width) out = \' \' + out',
  '  return out',
  '}',
  '',
  'export function exportRows(rows) {',
  '  const out = [HEADER]',
  '  for (const row of rows) {',
  '    const id = pad(row.id, 8)',
  '    const value = pad(row.value, 16)',
  '    if (value.trim() === \'\') {',
  '      continue',
  '    }',
  '    out.push(id + \',\' + value)',
  '  }',
  '  return out.join(\'\\n\') + \'\\n\'',
  '}',
  '',
  'export function summarize(rows) {',
  '  let empty = 0',
  '  for (const row of rows) {',
  '    if (String(row.value).trim() === \'\') empty += 1',
  '  }',
  '  return { total: rows.length, empty }',
  '}',
  '',
  'export default { exportRows, summarize }',
  '',
].join('\n')
const LEGACY_BLOCK_FROM = 12
const LEGACY_BLOCK_TO = 23
const LEGACY_REPLACEMENT = [
  'export function exportRows(rows) {',
  '  const out = [HEADER]',
  '  for (const row of rows) {',
  '    const value = pad(row.value, 16)',
  '    if (value.trim() === \'\') continue',
  '    out.push(pad(row.id, 8) + \',\' + value)',
  '  }',
  '  return out.join(\'\\n\') + \'\\n\'',
  '}',
].join('\n') + '\n'
/** 期望结果 = 前 11 行 + 新块 + 第 24 行起（按真实行号拼，别再手抄一份）。 */
const LEGACY_EDITED = (() => {
  const lines = LEGACY_JS.split('\n')
  return [...lines.slice(0, LEGACY_BLOCK_FROM - 1), ...LEGACY_REPLACEMENT.split('\n').slice(0, -1), ...lines.slice(LEGACY_BLOCK_TO)].join('\n')
})()

/** 场景 6 的种子：目标行有 **尾随空格**（真实现场很常见，模型抄回来时经常丢掉）。 */
const SERVER_JS = [
  'export const limits = {',
  '  maxConnections = 128   ',
  '  maxBodyKb = 512',
  '}',
  '',
  'export function describe() {',
  '  return `limits: ${limits.maxConnections}`',
  '}',
  '',
].join('\n')

/** 场景 7 的种子：同一行出现 5 次。 */
const RETRY_JS = Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? 'const RETRY_LIMIT = 3' : `const step${i} = ${i}`)).join('\n') + '\n'

/** 场景 8/9 的种子：60 行、要在一次调用里整体替换。 */
const REWRITE_JS = Array.from({ length: 60 }, (_, i) => `export const item${i} = ${i} // ${'z'.repeat(30)}`).join('\n') + '\n'
const REWRITE_NEXT = REWRITE_JS.replaceAll('export const item', 'export const entry')

/** 场景 10 的种子：压缩成单行的 96 KB JS。 */
const MIN_JS = `const payload="${'a'.repeat(96_000)}";const marker="TARGET_VALUE";export default payload;\n`

/** 场景 12 的种子：模型抄错了一个字（锚点在文件里根本不存在）。 */
const TYPO_JS = Array.from({ length: 30 }, (_, i) => (i === 17 ? '  retryDelayMs: 250,' : `  key${i}: ${i},`)).join('\n') + '\n'

/** 场景 13 的种子：BOM + CRLF 的文件（原生两处缺陷的现场）。 */
const BOM_CRLF = '\uFEFF{\r\n  "name": "demo",\r\n  "version": "1.0.0"\r\n}\r\n'

const SCENARIOS = [
  {
    id: 'small-unique-edit',
    title: '小改动：24 行文件里改一个值',
    why: '最常见的调用。两侧都能用同一段字面锚点，看的是结果文本与 schema 的固定差。',
    seed: { 'src/config.js': CONFIG_JS },
    expect: { 'src/config.js': CONFIG_JS_EDITED },
    read: (dir) => ({ file_path: join(dir, 'src/config.js') }),
    native: [
      {
        label: 'literal-最短唯一锚点',
        steps: (dir) => {
          const anchor = minimalUniqueAnchor(CONFIG_JS, CONFIG_JS.indexOf('30000'), CONFIG_JS.indexOf('30000') + 5)
          return [{ tool: 'edit', args: { file_path: join(dir, 'src/config.js'), old_string: anchor, new_string: anchor.replace('30000', '60000') } }]
        },
      },
      {
        label: 'literal-整行',
        steps: (dir) => [{
          tool: 'edit',
          args: { file_path: join(dir, 'src/config.js'), old_string: '  timeoutMs: 30000,', new_string: '  timeoutMs: 60000,' },
        }],
      },
    ],
    plugin: [
      {
        label: 'old_text-最短唯一锚点',
        steps: (dir) => {
          const anchor = minimalUniqueAnchor(CONFIG_JS, CONFIG_JS.indexOf('30000'), CONFIG_JS.indexOf('30000') + 5)
          return [{ tool: 'edit_text', args: { file_path: join(dir, 'src/config.js'), old_text: anchor, new_text: anchor.replace('30000', '60000') } }]
        },
      },
      {
        label: 'lines:5',
        steps: (dir) => [{
          tool: 'edit_text',
          args: { file_path: join(dir, 'src/config.js'), lines: '5', new_text: '  timeoutMs: 60000,\n' },
        }],
      },
    ],
  },
  {
    id: 'repeated-block-edit',
    title: '重复块里改一行（160 行、20 个几乎逐字相同的函数）',
    why: '关键实测：`lines:116` **不是位置锚点**——它取回那一行的原文再走字面匹配，重复内容照样拒绝。'
      + '所以两侧都必须把锚点撑到唯一；差别在于插件用 `lines:113:116` 只付一次块内容（整块替换），原生要付两次（旧块 + 新块）。',
    seed: { 'src/handlers.js': HANDLERS_JS },
    expect: { 'src/handlers.js': HANDLERS_EDITED },
    read: (dir) => ({ file_path: join(dir, 'src/handlers.js'), offset: 110, limit: 20 }),
    native: [
      {
        label: 'literal-最短唯一锚点（撑到函数头）',
        steps: (dir) => {
          const at = HANDLERS_JS.indexOf("throw new Error('invalid request')", HANDLERS_JS.indexOf('function handle14'))
          const anchor = minimalUniqueAnchor(HANDLERS_JS, at, at + 30)
          return [{
            tool: 'edit',
            args: { file_path: join(dir, 'src/handlers.js'), old_string: anchor, new_string: anchor.replace("'invalid request'", "'invalid request: ' + req.id") },
          }]
        },
      },
      {
        label: 'literal-上下文两行（会失败：命中 20 处）',
        steps: (dir) => [{
          tool: 'edit',
          args: {
            file_path: join(dir, 'src/handlers.js'),
            old_string: "  if (!ok) {\n    throw new Error('invalid request')\n  }",
            new_string: "  if (!ok) {\n    throw new Error('invalid request: ' + req.id)\n  }",
          },
        }],
      },
    ],
    plugin: [
      {
        label: 'lines:113:116（整块，含唯一函数头）',
        steps: (dir) => [{
          tool: 'edit_text',
          args: {
            file_path: join(dir, 'src/handlers.js'),
            lines: '113:116',
            new_text: "function handle14(req, res) {\n  const ok = validate(req)\n  if (!ok) {\n    throw new Error('invalid request: ' + req.id)\n",
          },
        }],
      },
      {
        label: `lines:${HANDLER_TARGET_LINE}（反例：不是位置锚点，会失败）`,
        steps: (dir) => [{
          tool: 'edit_text',
          args: {
            file_path: join(dir, 'src/handlers.js'),
            lines: String(HANDLER_TARGET_LINE),
            new_text: "    throw new Error('invalid request: ' + req.id)\n",
          },
        }],
      },
      {
        label: 'old_text-最短唯一锚点（同原生）',
        steps: (dir) => {
          const at = HANDLERS_JS.indexOf("throw new Error('invalid request')", HANDLERS_JS.indexOf('function handle14'))
          const anchor = minimalUniqueAnchor(HANDLERS_JS, at, at + 30)
          return [{
            tool: 'edit_text',
            args: { file_path: join(dir, 'src/handlers.js'), old_text: anchor, new_text: anchor.replace("'invalid request'", "'invalid request: ' + req.id") },
          }]
        },
      },
    ],
  },
  {
    id: 'wide-row-edit',
    title: '宽表里改一个字段（20 行 × 5 KB）',
    why: '反例：宽行并不天然利于 lines 锚点——整行替换要重发 5 KB。两侧都该用短字面锚点。',
    seed: { 'data/report.csv': WIDE_CSV },
    expect: { 'data/report.csv': WIDE_CSV.replace('|tag7\n', '|tag7x\n') },
    read: (dir) => ({ file_path: join(dir, 'data/report.csv') }),
    native: [
      {
        label: 'literal-短字段锚点',
        steps: (dir) => [{
          tool: 'edit',
          args: { file_path: join(dir, 'data/report.csv'), old_string: '|tag7\n', new_string: '|tag7x\n' },
        }],
      },
    ],
    plugin: [
      {
        label: 'old_text-短字段锚点',
        steps: (dir) => [{
          tool: 'edit_text',
          args: { file_path: join(dir, 'data/report.csv'), old_text: '|tag7\n', new_text: '|tag7x\n' },
        }],
      },
      {
        label: 'lines:8（反例：整行 5 KB 都要重发）',
        steps: (dir) => {
          const row = lineAt(WIDE_CSV, 8)
          return [{
            tool: 'edit_text',
            args: { file_path: join(dir, 'data/report.csv'), lines: '8', new_text: row.replace('|tag7', '|tag7x') + '\n' },
          }]
        },
      },
    ],
  },
  {
    id: 'block-rewrite',
    title: `块重写：${LEGACY_BLOCK_TO - LEGACY_BLOCK_FROM + 1} 行整体换掉（40 行文件）`,
    why: '原生必须把旧块抄一遍（old_string）再写一遍（new_string）= 2×；插件点行号，只付新内容。',
    seed: { 'src/legacy.js': LEGACY_JS },
    expect: { 'src/legacy.js': LEGACY_EDITED },
    read: (dir) => ({ file_path: join(dir, 'src/legacy.js'), offset: 8, limit: 20 }),
    native: [
      {
        label: 'literal-整块',
        steps: (dir) => [{
          tool: 'edit',
          args: {
            file_path: join(dir, 'src/legacy.js'),
            old_string: lineBlock(LEGACY_JS, LEGACY_BLOCK_FROM, LEGACY_BLOCK_TO),
            new_string: LEGACY_REPLACEMENT,
          },
        }],
      },
    ],
    plugin: [
      {
        label: `lines:${LEGACY_BLOCK_FROM}:${LEGACY_BLOCK_TO}`,
        steps: (dir) => [{
          tool: 'edit_text',
          args: { file_path: join(dir, 'src/legacy.js'), lines: `${LEGACY_BLOCK_FROM}:${LEGACY_BLOCK_TO}`, new_text: LEGACY_REPLACEMENT },
        }],
      },
      {
        label: 'grep-多行正则（不依赖行号）',
        steps: (dir) => [{
          tool: 'edit_text',
          args: {
            file_path: join(dir, 'src/legacy.js'),
            grep: '^export function exportRows\\(rows\\) \\{[\\s\\S]*?\\n\\}',
            new_text: LEGACY_REPLACEMENT,
          },
        }],
      },
      {
        label: 'old_text-整块（同原生）',
        steps: (dir) => [{
          tool: 'edit_text',
          args: {
            file_path: join(dir, 'src/legacy.js'),
            old_text: lineBlock(LEGACY_JS, LEGACY_BLOCK_FROM, LEGACY_BLOCK_TO),
            new_text: LEGACY_REPLACEMENT,
          },
        }],
      },
    ],
  },
  {
    id: 'insert-after-brace',
    title: '在重复的 `}` 之后插入一段（行号锚点 vs 撑大的字面锚点）',
    why: '插入点是重复行时，原生必须把锚点撑到唯一；插件 `lines` + `mode: after` 只付插入内容。',
    seed: { 'src/handlers.js': HANDLERS_JS },
    expect: { 'src/handlers.js': HANDLERS_JS.replace('}\n\nfunction handle5', "}\n\nfunction audit(entry) {\n  return { at: Date.now(), entry }\n}\n\nfunction handle5") },
    read: (dir) => ({ file_path: join(dir, 'src/handlers.js'), offset: 33, limit: 12 }),
    native: [
      {
        label: 'literal-撑到唯一的尾锚点',
        steps: (dir) => [{
          tool: 'edit',
          args: {
            file_path: join(dir, 'src/handlers.js'),
            old_string: "  return res.send({ id: 4 })\n}\n",
            new_string: "  return res.send({ id: 4 })\n}\n\nfunction audit(entry) {\n  return { at: Date.now(), entry }\n}\n",
          },
        }],
      },
      {
        label: 'literal-只用重复的 `}`（会失败：命中 20 处）',
        steps: (dir) => [{
          tool: 'edit',
          args: {
            file_path: join(dir, 'src/handlers.js'),
            old_string: '}\n',
            new_string: "}\n\nfunction audit(entry) {\n  return { at: Date.now(), entry }\n}\n",
          },
        }],
      },
    ],
    plugin: [
      {
        label: 'lines:40 + mode:after',
        steps: (dir) => [{
          tool: 'edit_text',
          args: {
            file_path: join(dir, 'src/handlers.js'),
            lines: '40',
            mode: 'after',
            new_text: 'function audit(entry) {\n  return { at: Date.now(), entry }\n}\n\n',
          },
        }],
      },
    ],
  },
  {
    id: 'near-miss-whitespace',
    title: '锚点差一个尾随空格：原生失败→重读→重试，插件宽松命中',
    why: '失败不只是错误文本：原生拿不到任何线索，只能再读一次文件（读结果的 token 是大头）。',
    seed: { 'src/server.js': SERVER_JS },
    expect: { 'src/server.js': SERVER_JS.replace('  maxConnections = 128   ', '  maxConnections = 256   ') },
    read: (dir) => ({ file_path: join(dir, 'src/server.js') }),
    native: [
      {
        label: 'literal-丢空格（失败）→ read → 重试',
        steps: (dir) => [
          { tool: 'edit', args: { file_path: join(dir, 'src/server.js'), old_string: '  maxConnections = 128\n', new_string: '  maxConnections = 256\n' } },
          { tool: 'read', args: { file_path: join(dir, 'src/server.js') } },
          { tool: 'edit', args: { file_path: join(dir, 'src/server.js'), old_string: '  maxConnections = 128   ', new_string: '  maxConnections = 256   ' } },
        ],
      },
    ],
    plugin: [
      {
        label: 'old_text-丢空格（宽松命中）',
        steps: (dir) => [{
          tool: 'edit_text',
          args: { file_path: join(dir, 'src/server.js'), old_text: '  maxConnections = 128', new_text: '  maxConnections = 256' },
        }],
      },
    ],
  },
  {
    id: 'ambiguity-replace-all',
    title: '同一行出现 5 次、要全改：count vs replace_all',
    why: '两边都一次成功；差别只在参数名长度与结果文本。',
    seed: { 'src/retry.js': RETRY_JS },
    expect: { 'src/retry.js': RETRY_JS.replaceAll('const RETRY_LIMIT = 3', 'const RETRY_LIMIT = 5') },
    read: (dir) => ({ file_path: join(dir, 'src/retry.js') }),
    native: [
      {
        label: 'replace_all: true',
        steps: (dir) => [{
          tool: 'edit',
          args: { file_path: join(dir, 'src/retry.js'), old_string: 'const RETRY_LIMIT = 3', new_string: 'const RETRY_LIMIT = 5', replace_all: true },
        }],
      },
    ],
    plugin: [
      {
        label: 'count: 5',
        steps: (dir) => [{
          tool: 'edit_text',
          args: { file_path: join(dir, 'src/retry.js'), old_text: 'const RETRY_LIMIT = 3', new_text: 'const RETRY_LIMIT = 5', count: 5 },
        }],
      },
    ],
  },
  {
    id: 'whole-file-rewrite',
    title: '整文件重写（60 行）：write vs write_text',
    why: '入参完全一样，差在结果文本（原生回显路径）与 schema。',
    seed: { 'src/items.js': REWRITE_JS },
    expect: { 'src/items.js': REWRITE_NEXT },
    read: (dir) => ({ file_path: join(dir, 'src/items.js') }),
    native: [
      { label: 'write', steps: (dir) => [{ tool: 'write', args: { file_path: join(dir, 'src/items.js'), content: REWRITE_NEXT } }] },
    ],
    plugin: [
      { label: 'write_text', steps: (dir) => [{ tool: 'write_text', args: { file_path: join(dir, 'src/items.js'), content: REWRITE_NEXT } }] },
    ],
  },
  {
    id: 'create-file',
    title: '新建文件（含两层新目录）',
    why: '同上：入参一样，差在结果与 schema 的升权字段。',
    seed: { 'README.md': '# demo\n' },
    expect: { 'src/deep/module.js': 'export const created = true\n' },
    native: [
      { label: 'write', steps: (dir) => [{ tool: 'write', args: { file_path: join(dir, 'src/deep/module.js'), content: 'export const created = true\n' } }] },
    ],
    plugin: [
      { label: 'write_text', steps: (dir) => [{ tool: 'write_text', args: { file_path: join(dir, 'src/deep/module.js'), content: 'export const created = true\n' } }] },
    ],
  },
  {
    id: 'long-single-line',
    title: '单行 96 KB 压缩文件里改一个值',
    why: '反例：lines 锚点在这种文件里是灾难（要重发 96 KB 整行），两侧都只能用短字面锚点。',
    seed: { 'dist/bundle.js': MIN_JS },
    expect: { 'dist/bundle.js': MIN_JS.replace('TARGET_VALUE', 'TARGET_VALUE_2') },
    read: (dir) => ({ file_path: join(dir, 'dist/bundle.js') }),
    native: [
      {
        label: 'literal-短片段',
        steps: (dir) => [{
          tool: 'edit',
          args: { file_path: join(dir, 'dist/bundle.js'), old_string: 'TARGET_VALUE', new_string: 'TARGET_VALUE_2' },
        }],
      },
    ],
    plugin: [
      {
        label: 'old_text-短片段',
        steps: (dir) => [{
          tool: 'edit_text',
          args: { file_path: join(dir, 'dist/bundle.js'), old_text: 'TARGET_VALUE', new_text: 'TARGET_VALUE_2' },
        }],
      },
    ],
  },
  {
    id: 'batch-renames',
    title: '一次会话里的 6 次连续小改动（同一文件）',
    why: '结果文本的固定差 ×6，加上静态开销在多次调用上的摊薄。',
    seed: { 'src/config.js': CONFIG_JS },
    expect: {
      'src/config.js': CONFIG_JS
        .replace('  port: 8080,', '  port: 9090,')
        .replace('  retries: 3,', '  retries: 5,')
        .replace('  verbose: false,', '  verbose: true,')
        .replace("  logLevel: 'info',", "  logLevel: 'warn',")
        .replace('  min: 2,', '  min: 4,')
        .replace('  max: 10,', '  max: 24,'),
    },
    read: (dir) => ({ file_path: join(dir, 'src/config.js') }),
    native: [
      {
        label: '6 × literal',
        steps: (dir) => [
          ['  port: 8080,', '  port: 9090,'],
          ['  retries: 3,', '  retries: 5,'],
          ['  verbose: false,', '  verbose: true,'],
          ["  logLevel: 'info',", "  logLevel: 'warn',"],
          ['  min: 2,', '  min: 4,'],
          ['  max: 10,', '  max: 24,'],
        ].map(([old_string, new_string]) => ({ tool: 'edit', args: { file_path: join(dir, 'src/config.js'), old_string, new_string } })),
      },
    ],
    plugin: [
      {
        label: '6 × lines:n',
        steps: (dir) => [
          ['4', '  port: 9090,\n'],
          ['6', '  retries: 5,\n'],
          ['7', '  verbose: true,\n'],
          ['8', "  logLevel: 'warn',\n"],
          ['16', '  min: 4,\n'],
          ['17', '  max: 24,\n'],
        ].map(([lines, new_text]) => ({ tool: 'edit_text', args: { file_path: join(dir, 'src/config.js'), lines, new_text } })),
      },
    ],
  },
  {
    id: 'miss-with-typo',
    title: '锚点抄错（文件里根本没有）：原生再读一次，插件给候选',
    why: '插件的失败提示更大，但它带着候选行，模型可能不用再读；原生只能重读。',
    seed: { 'src/typo.js': TYPO_JS },
    expect: { 'src/typo.js': TYPO_JS.replace('  retryDelayMs: 250,', '  retryDelayMs: 500,') },
    read: (dir) => ({ file_path: join(dir, 'src/typo.js') }),
    native: [
      {
        label: '错锚点（失败）→ read → 重试',
        steps: (dir) => [
          { tool: 'edit', args: { file_path: join(dir, 'src/typo.js'), old_string: '  retryDelayMs: 250000,', new_string: '  retryDelayMs: 500,' } },
          { tool: 'read', args: { file_path: join(dir, 'src/typo.js') } },
          { tool: 'edit', args: { file_path: join(dir, 'src/typo.js'), old_string: '  retryDelayMs: 250,', new_string: '  retryDelayMs: 500,' } },
        ],
      },
    ],
    plugin: [
      {
        label: '错 old_text（失败，带候选）→ 直接重试',
        steps: (dir) => [
          { tool: 'edit_text', args: { file_path: join(dir, 'src/typo.js'), old_text: '  retryDelayMs: 250000,', new_text: '  retryDelayMs: 500,' } },
          { tool: 'edit_text', args: { file_path: join(dir, 'src/typo.js'), old_text: '  retryDelayMs: 250,', new_text: '  retryDelayMs: 500,' } },
        ],
      },
    ],
  },
  {
    id: 'bom-crlf-fidelity',
    title: 'BOM + CRLF 文件的小改动：token 相同，字节不同',
    why: 'token 账上打平，但原生丢掉 BOM/把 CRLF 抹平——修回来要额外一轮 read+write。',
    seed: { 'data/manifest.json': BOM_CRLF },
    expectLoose: true,
    read: (dir) => ({ file_path: join(dir, 'data/manifest.json') }),
    native: [
      {
        label: 'edit-字面锚点',
        steps: (dir) => [{
          tool: 'edit',
          args: { file_path: join(dir, 'data/manifest.json'), old_string: '"version": "1.0.0"', new_string: '"version": "1.1.0"' },
        }],
      },
    ],
    plugin: [
      {
        label: 'old_text-字面锚点',
        steps: (dir) => [{
          tool: 'edit_text',
          args: { file_path: join(dir, 'data/manifest.json'), old_text: '"version": "1.0.0"', new_text: '"version": "1.1.0"' },
        }],
      },
    ],
  },
]

// ── 6. 跑分 ───────────────────────────────────────────────────────────────────

/** 铺种子文件（每个候选写法一份全新副本，互不污染）。 */
function seedFiles(dir, seed) {
  for (const [rel, text] of Object.entries(seed)) {
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text, 'utf8')
  }
}

/**
 * 一个作业目录工厂。两侧各占一个**同长度**的子目录（`native` / `plugin`），
 * 这样两侧入参里的绝对路径只差一个字符，路径长度对计价的贡献对等。
 */
function makeFactory(root) {
  return {
    dirFor(side, tag) {
      const dir = join(root, side, tag)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      return dir
    },
  }
}

async function runScenario(scenario, factory) {
  // 共享 read：两侧参数完全相同，所以单独计价、不计入 Δ（Δ 只反映工具设计差异）。
  const sharedDir = factory.dirFor('native', `${scenario.id}-shared`)
  seedFiles(sharedDir, scenario.seed)
  const sharedHarness = await mount('native', sharedDir)
  let sharedTokens = 0
  if (typeof scenario.read === 'function') {
    const args = scenario.read(sharedDir)
    const result = await executeIn(sharedHarness, 'read', args, `${scenario.id}-shared-read`)
    sharedTokens = callTokens('read', args) + resultTokens(result.content)
  }

  const runs = { native: [], plugin: [] }
  for (const side of ['native', 'plugin']) {
    // 每次跑候选都重新铺一遍种子（每个候选一份全新副本）。
    for (const [index, option] of scenario[side].entries()) {
      const dir = factory.dirFor(side, `${scenario.id}-${index}`)
      seedFiles(dir, scenario.seed)
      const harness = await mount(side === 'native' ? 'native' : 'plugin', dir)
      const steps = option.steps(dir)
      const priced = []
      let failedSteps = 0
      let firstError = null
      for (const [stepIndex, step] of steps.entries()) {
        const result = await executeIn(harness, step.tool, step.args, `${scenario.id}-${side}-${index}-${stepIndex}`)
        const text = resultText(result)
        const ok = result.isError !== true
        if (!ok) {
          failedSteps += 1
          if (firstError === null) firstError = text
        }
        priced.push({
          tool: step.tool,
          args: step.args,
          ok,
          text,
          argsTokens: callTokens(step.tool, step.args),
          resultTokens: resultTokens(result.content),
          argsBytes: bytes(JSON.stringify(step.args)),
          resultBytes: bytes(text),
        })
      }
      // 多步写法里"中途失败后重试"是**正常**流程（那正是重试场景要量的事），
      // 所以判定看最后一步与最终内容，而不是"中途有没有红过"。
      const lastOk = priced.at(-1)?.ok === true
      // 最终内容对账要覆盖 seed ∪ expect：新建文件只出现在 expect 里。
      const watched = [...new Set([...Object.keys(scenario.seed), ...Object.keys(scenario.expect ?? {})])]
      const finalText = Object.fromEntries(watched.map((rel) => {
        try {
          return [rel, readFileSync(join(dir, rel), 'utf8')]
        } catch {
          return [rel, null]
        }
      }))
      const fidelity = scenario.expectLoose === true
        ? Object.keys(scenario.seed).every((rel) => existsSync(join(dir, rel)))
        : Object.entries(scenario.expect).every(([rel, want]) => finalText[rel] === want)
      runs[side].push({
        label: option.label,
        ok: lastOk,
        failedSteps,
        error: firstError,
        fidelity,
        mismatch: fidelity ? null : firstMismatch(scenario.expect ?? {}, finalText),
        steps: priced,
        calls: priced.length,
        argsTokens: priced.reduce((sum, step) => sum + step.argsTokens, 0),
        resultTokens: priced.reduce((sum, step) => sum + step.resultTokens, 0),
        totalTokens: priced.reduce((sum, step) => sum + step.argsTokens + step.resultTokens, 0),
        finalText,
      })
    }
  }

  const eligible = (list) => list.filter((run) => run.ok && run.fidelity)
  const bestOf = (list) => eligible(list).reduce((best, run) => (best === null || run.totalTokens < best.totalTokens ? run : best), null)
  return {
    id: scenario.id,
    title: scenario.title,
    why: scenario.why,
    sharedTokens,
    native: runs.native,
    plugin: runs.plugin,
    nativeBest: bestOf(runs.native),
    pluginBest: bestOf(runs.plugin),
    nativeAnyOk: runs.native.some((run) => run.ok && run.fidelity),
    pluginAnyOk: runs.plugin.some((run) => run.ok && run.fidelity),
  }
}

// ── 7. 会话聚合 ───────────────────────────────────────────────────────────────

/**
 * 一个"典型工作日"的调用构成（可核对、可改）。用来把单次差异放大成会话级结论：
 * 静态开销每请求付一次，动态开销每次调用付一次。
 */
const SESSION_MIX = [
  ['small-unique-edit', 20],
  ['repeated-block-edit', 5],
  ['block-rewrite', 3],
  ['insert-after-brace', 5],
  ['near-miss-whitespace', 2],
  ['ambiguity-replace-all', 3],
  ['whole-file-rewrite', 2],
  ['create-file', 3],
  ['long-single-line', 2],
  ['batch-renames', 1],
]

function sessionAggregate(results, staticRows) {
  const byId = new Map(results.map((row) => [row.id, row]))
  const mix = []
  let nativeCalls = 0
  let pluginCalls = 0
  let nativeDynamic = 0
  let pluginDynamic = 0
  let shared = 0
  for (const [id, count] of SESSION_MIX) {
    const row = byId.get(id)
    if (row === undefined || row.nativeBest === null || row.pluginBest === null) continue
    nativeCalls += row.nativeBest.calls * count
    pluginCalls += row.pluginBest.calls * count
    nativeDynamic += row.nativeBest.totalTokens * count
    pluginDynamic += row.pluginBest.totalTokens * count
    shared += row.sharedTokens * count
    mix.push({ id, count, nativeCalls: row.nativeBest.calls, pluginCalls: row.pluginBest.calls, native: row.nativeBest.totalTokens, plugin: row.pluginBest.totalTokens })
  }
  const findStatic = (needle) => staticRows.find((row) => row.label.includes(needle)) ?? null
  const nativeStatic = findStatic('danger-full-access')
  const pluginStatic = findStatic('无 escape')
  const pluginOnlyStatic = findStatic('插件（guidance short）')
  return {
    mix,
    nativeCalls,
    pluginCalls,
    shared,
    nativeDynamic,
    pluginDynamic,
    dynamicDelta: nativeDynamic - pluginDynamic,
    // 静态按"请求"付：一次工具调用占一次请求，所以请求数就取各自的调用数（插件调用更少的场合同样体现在这里）。
    nativeTurns: nativeCalls,
    pluginTurns: pluginCalls,
    staticNative: nativeStatic === null ? 0 : nativeStatic.totalTokens,
    staticPluginMasked: pluginStatic === null ? 0 : pluginStatic.totalTokens,
    staticPluginOnly: pluginOnlyStatic === null ? 0 : pluginOnlyStatic.totalTokens,
  }
}

// ── 8. 真实会话日志 ───────────────────────────────────────────────────────────

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 会话日志是多帧 zstd（边跑边追加），Node 只解第一帧，所以按魔数切帧再拼。 */
function decodeFrames(buffer) {
  const offsets = []
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1]
      && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) offsets.push(i)
  }
  if (offsets.length === 0) return buffer.toString('utf8')
  const parts = []
  let index = 0
  while (index < offsets.length) {
    let next = index + 1
    for (;;) {
      const slice = buffer.subarray(offsets[index], next < offsets.length ? offsets[next] : buffer.length)
      try {
        parts.push(zstdDecompressSync(slice))
        break
      } catch (error) {
        next += 1
        if (next > offsets.length) throw error
      }
    }
    index = next
  }
  return Buffer.concat(parts).toString('utf8')
}

function readEvents(file) {
  const raw = readFileSync(file)
  const text = file.endsWith('.zstd') ? decodeFrames(raw) : raw.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 正在写入的会话最后一行可能被截断：忽略。
    }
  }
  return events
}

function collectLogs(target) {
  if (!existsSync(target)) return []
  if (statSync(target).isFile()) return [target]
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  walk(target)
  return files
}

/**
 * 结果文本的形状分类。
 *
 * 关键：会话日志横跨本插件的多个版本——早期版本会把 diff 正文与路径回显进模型上下文（README 里
 * 记为已修掉的形状）。把两者混在一起平均会得出"插件更贵"的假结论，所以这里先分类，再只拿
 * **当前形状**（`WROTE` / `FAIL` 两行）与原生对照。
 */
function classifyResult(tool, text) {
  const first = text.split('\n')[0]
  if (tool === 'edit_text' || tool === 'write_text') {
    if (first === 'WROTE') return 'current-ok'
    if (first === 'FAIL') return 'current-fail'
    return 'legacy'
  }
  if (tool === 'edit' || tool === 'write') {
    if (first.startsWith('<path>') || first.startsWith('The file ')) return 'native-ok'
    if (first.startsWith('Error: ')) return 'error'
    return 'legacy'
  }
  return 'other'
}

/**
 * 扫真实会话日志，把**实际发生过**的 edit/write/edit_text/write_text 调用按同一套计价器算一遍。
 * 这是合成场景的锚：真实入参与真实结果的平均值。
 */
function logsReport() {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const files = collectLogs(root)
  const buckets = new Map()
  let sessions = 0
  for (const file of files) {
    const events = readEvents(file)
    const calls = new Map()
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      for (const block of event.data?.message?.content ?? []) if (block.type === 'tool-call') calls.set(block.id, block)
    }
    let touched = false
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      const call = calls.get(event.data?.message?.source?.callId)
      const name = call?.name
      if (!['edit', 'write', 'edit_text', 'write_text'].includes(name)) continue
      const content = (event.data?.message?.content ?? [])
        .flatMap((block) => (block.type === 'tool-result' ? (block.content ?? []) : []))
      const args = call?.arguments ?? {}
      const text = content.map((block) => block.text ?? '').join('')
      const shape = classifyResult(name, text)
      const key = `${name}|${shape}`
      const record = buckets.get(key) ?? { tool: name, shape, calls: 0, argsTokens: 0, resultTokens: 0, argBytes: 0, resultBytes: 0, worst: 0 }
      record.calls += 1
      record.argsTokens += callTokens(name, args)
      record.resultTokens += resultTokens(content)
      record.argBytes += bytes(JSON.stringify(args))
      record.resultBytes += bytes(text)
      record.worst = Math.max(record.worst, bytes(text))
      buckets.set(key, record)
      touched = true
    }
    if (touched) sessions += 1
  }
  const perBucket = [...buckets.values()].sort((a, b) => (a.tool === b.tool ? a.shape.localeCompare(b.shape) : a.tool.localeCompare(b.tool)))
  const avg = (record, key) => record[key] / record.calls
  /** 只取可比子集：两边都成功的当前形状。 */
  const pick = (tool, shape) => perBucket.find((record) => record.tool === tool && record.shape === shape) ?? null
  return {
    scanned: files.length,
    sessions,
    perBucket,
    nativeOk: ['edit', 'write'].map((tool) => pick(tool, 'native-ok')).filter(Boolean),
    pluginOk: ['edit_text', 'write_text'].map((tool) => pick(tool, 'current-ok')).filter(Boolean),
    nativeErr: ['edit', 'write'].map((tool) => pick(tool, 'error')).filter(Boolean),
    pluginErr: ['edit_text', 'write_text'].map((tool) => pick(tool, 'current-fail')).filter(Boolean),
    legacy: perBucket.filter((record) => record.shape === 'legacy'),
    avg,
  }
}

// ── 9. 报表 ───────────────────────────────────────────────────────────────────

const pad = (value, width) => String(value).padStart(width)
const padEnd = (value, width) => String(value).padEnd(width)

/** 内容校验失败时给出第一处差异，省得靠猜（输出里也用它说明"反例为什么是反例"）。 */
function firstMismatch(expected, actual) {
  for (const [rel, want] of Object.entries(expected)) {
    const got = actual[rel]
    if (got === want) continue
    if (got === null || got === undefined) return `${rel}: 文件不存在`
    const limit = Math.min(want.length, got.length)
    let at = 0
    while (at < limit && want[at] === got[at]) at += 1
    return `${rel}: 第 ${at} 字符起不同 want=${JSON.stringify(want.slice(at, at + 24))} got=${JSON.stringify(got.slice(at, at + 24))}`
  }
  return '内容与期望不符'
}

function printStatic(rows) {
  console.log('=== 1. 静态开销（每次请求都要重发的那部分：工具 schema + 系统提示词引导段）')
  console.log(`${padEnd('组合', 46)}${pad('schema B', 10)}${pad('引导 B', 9)}${pad('合计 B', 9)}${pad('token', 8)}  工具`)
  for (const row of rows) {
    console.log(
      padEnd(row.label, 46)
      + pad(row.toolsBytes, 10) + pad(row.promptBytes, 9) + pad(row.totalBytes, 9)
      + pad(tok(row.totalTokens), 8) + '  ' + row.toolNames.join(','),
    )
  }
  const nativePlan = rows.find((row) => row.label.includes('danger-full-access'))
  const pluginPlan = rows.find((row) => row.label.includes('无 escape'))
  if (nativePlan !== undefined && pluginPlan !== undefined) {
    const delta = nativePlan.totalTokens - pluginPlan.totalTokens
    const direction = delta >= 0 ? `省 ${tok(delta)}` : `多花 ${tok(-delta)}`
    console.log('')
    console.log(`  原生方案 ${tok(nativePlan.totalTokens)} tok/请求 → 插件方案 ${tok(pluginPlan.totalTokens)} tok/请求：每请求${direction}（${Math.abs(pct(delta, nativePlan.totalTokens)).toFixed(0)}%）`)
  }
  console.log('')
}

function printScenarios(results) {
  console.log('=== 2. 逐场景（每侧取自己"最短且真跑通"的写法；共享的 read 单列，不计入 Δ）')
  console.log(`${padEnd('场景', 34)}${pad('原生写法', 26)}${pad('原生 tok', 9)}${pad('插件写法', 26)}${pad('插件 tok', 9)}${pad('Δtoken', 9)}${pad('Δ%', 8)}${pad('共享read', 9)}`)
  for (const row of results) {
    const n = row.nativeBest
    const p = row.pluginBest
    if (n === null || p === null) {
      console.log(`${padEnd(row.title, 34)}${padEnd(n === null ? '(无可用写法)' : n.label, 26)}${pad('-', 9)}${padEnd(p === null ? '(无可用写法)' : p.label, 26)}${pad('-', 9)}`)
      continue
    }
    const delta = n.totalTokens - p.totalTokens
    console.log(
      padEnd(row.title, 34)
      + padEnd(n.label, 26) + pad(tok(n.totalTokens), 9)
      + padEnd(p.label, 26) + pad(tok(p.totalTokens), 9)
      + pad(signed(tok(delta)), 9) + pad(`${pct(delta, n.totalTokens).toFixed(0)}%`, 8) + pad(tok(row.sharedTokens), 9),
    )
  }
  console.log('')
}

function printOptions(results) {
  console.log('=== 3. 候选写法明细（✗ = 真跑失败，不参与取优）')
  for (const row of results) {
    console.log(`  ── ${row.title}`)
    console.log(`      为什么这么设计：${row.why}`)
    for (const side of ['native', 'plugin']) {
      for (const run of row[side]) {
        const usable = run.ok && run.fidelity
        const mark = usable ? (run.failedSteps > 0 ? '◐' : '✓') : '✗'
        const retry = run.failedSteps > 0 && usable ? `（含 ${run.failedSteps} 次失败重试）` : ''
        const why = usable ? retry : `  ${String(run.mismatch ?? run.error ?? '未通过').split('\n')[0].slice(0, 96)}`
        console.log(`      ${mark} ${padEnd(side, 7)} ${padEnd(run.label, 40)} 调用 ${run.calls}  入参 ${pad(tok(run.argsTokens), 5)}  结果 ${pad(tok(run.resultTokens), 5)}  合计 ${pad(tok(run.totalTokens), 5)} tok${why}`)
      }
    }
    const seen = []
    for (const line of (row.pluginBest?.steps ?? [])) seen.push(`${line.tool} → ${JSON.stringify(line.text.split('\n')[0]).slice(0, 60)}`)
    if (seen.length > 0) console.log(`      插件结果形状：${seen.join(' | ')}`)
  }
  console.log('')
}

function printSession(aggregate) {
  const nativeTotal = aggregate.staticNative * aggregate.nativeTurns + aggregate.nativeDynamic
  const pluginTotal = aggregate.staticPluginMasked * aggregate.pluginTurns + aggregate.pluginDynamic
  console.log(`=== 4. 会话聚合（典型工作日构成 ×：原生 ${aggregate.nativeCalls} 次调用 / 插件 ${aggregate.pluginCalls} 次调用）`)
  console.log(`${padEnd('项目', 40)}${pad('原生 tok', 12)}${pad('插件 tok', 12)}${pad('Δtoken', 10)}`)
  console.log(`${padEnd(`静态（×${aggregate.nativeTurns}/${aggregate.pluginTurns} 次请求）`, 40)}${pad(tok(aggregate.staticNative * aggregate.nativeTurns), 12)}${pad(tok(aggregate.staticPluginMasked * aggregate.pluginTurns), 12)}${pad(signed(tok(aggregate.staticNative * aggregate.nativeTurns - aggregate.staticPluginMasked * aggregate.pluginTurns)), 10)}`)
  console.log(`${padEnd('动态（调用入参 + 结果）', 40)}${pad(tok(aggregate.nativeDynamic), 12)}${pad(tok(aggregate.pluginDynamic), 12)}${pad(signed(tok(aggregate.dynamicDelta)), 10)}`)
  console.log(`${padEnd('共享 read（两侧相同，不含 Δ）', 40)}${pad(tok(aggregate.shared), 12)}${pad(tok(aggregate.shared), 12)}${pad('0', 10)}`)
  console.log(`${padEnd('合计（含共享 read）', 40)}${pad(tok(nativeTotal + aggregate.shared), 12)}${pad(tok(pluginTotal + aggregate.shared), 12)}${pad(signed(tok(nativeTotal - pluginTotal)), 10)}  ${pct(nativeTotal - pluginTotal, nativeTotal).toFixed(0)}%`)
  console.log('')
  console.log('  构成（调用数 × 单次 tok）：')
  for (const item of aggregate.mix) {
    const delta = (item.native - item.plugin) * item.count
    console.log(`    ${padEnd(item.id, 26)} ×${pad(item.count, 3)}   原生 ${pad(tok(item.native * item.count), 7)}  插件 ${pad(tok(item.plugin * item.count), 7)}  ${pad(signed(tok(delta)), 8)}`)
  }
  console.log('')
}

function printLogs(logs) {
  console.log(`=== 5. 真实会话日志（扫 ${logs.scanned} 个日志文件，${logs.sessions} 个会话有文本编辑调用）`)
  if (logs.perBucket.length === 0) {
    console.log('  没有找到 edit/write/edit_text/write_text 的调用记录')
    console.log('')
    return
  }
  console.log(`${padEnd('工具', 13)}${padEnd('形状', 14)}${pad('调用数', 8)}${pad('平均入参', 10)}${pad('平均结果', 10)}${pad('平均合计', 10)}${pad('最大结果B', 11)}`)
  for (const record of logs.perBucket) {
    console.log(
      padEnd(record.tool, 13) + padEnd(record.shape, 14) + pad(record.calls, 8)
      + pad(logs.avg(record, 'argsTokens').toFixed(1), 10)
      + pad(logs.avg(record, 'resultTokens').toFixed(1), 10)
      + pad((logs.avg(record, 'argsTokens') + logs.avg(record, 'resultTokens')).toFixed(1), 10)
      + pad(record.worst, 11),
    )
  }
  const sum = (records, key) => records.reduce((acc, record) => acc + logs.avg(record, key) * record.calls, 0)
  const calls = (records) => records.reduce((acc, record) => acc + record.calls, 0)
  const nativeOk = logs.nativeOk
  const pluginOk = logs.pluginOk
  const nativeCalls = calls(nativeOk)
  const pluginCalls = calls(pluginOk)
  if (nativeCalls > 0 && pluginCalls > 0) {
    const nPer = (sum(nativeOk, 'argsTokens') + sum(nativeOk, 'resultTokens')) / nativeCalls
    const pPer = (sum(pluginOk, 'argsTokens') + sum(pluginOk, 'resultTokens')) / pluginCalls
    console.log('')
    console.log(`  可比子集（都只算"成功"的调用）：`)
    console.log(`    原生 edit/write   成功 ${nativeCalls} 次：入参 ${(sum(nativeOk, 'argsTokens') / nativeCalls).toFixed(1)} + 结果 ${(sum(nativeOk, 'resultTokens') / nativeCalls).toFixed(1)} = ${nPer.toFixed(1)} tok/次`)
    console.log(`    插件 edit_text/write_text 成功 ${pluginCalls} 次：入参 ${(sum(pluginOk, 'argsTokens') / pluginCalls).toFixed(1)} + 结果 ${(sum(pluginOk, 'resultTokens') / pluginCalls).toFixed(1)} = ${pPer.toFixed(1)} tok/次`)
    console.log(`    实测每次差 ${nPer - pPer >= 0 ? '省' : '多花'} ${Math.abs(nPer - pPer).toFixed(1)} tok`)
  }
  const legacy = logs.legacy
  const legacyCalls = calls(legacy)
  if (legacyCalls > 0) {
    console.log(`  另有过时形状 ${legacyCalls} 次（本插件早期版本回显 diff / 路径的会话，已修掉，不计入上面的对照）`)
  }
  console.log('')
}

function markdownReport({ staticRows, results, aggregate, logs }) {
  const lines = []
  lines.push('# Token 消耗实测：原生 write/edit vs dsh-tool-text-editor')
  lines.push('')
  lines.push(`> 由 \`node tools/bench-tokens.mjs --md\` 生成，计价器 = \`@deepseek-ai/dsh-token-meter\` 的 \`estimateContent\`（\`ceil(chars/4)\` + 每块 4 token）。`)
  lines.push('')
  lines.push('## 静态开销（每个请求）')
  lines.push('')
  lines.push('| 组合 | schema B | 引导 B | 合计 B | token | 工具 |')
  lines.push('|---|---:|---:|---:|---:|---|')
  for (const row of staticRows) {
    lines.push(`| ${row.label} | ${row.toolsBytes} | ${row.promptBytes} | ${row.totalBytes} | ${tok(row.totalTokens)} | ${row.toolNames.join(', ')} |`)
  }
  lines.push('')
  lines.push('## 逐场景')
  lines.push('')
  lines.push('| 场景 | 原生写法 | 原生 tok | 插件写法 | 插件 tok | Δtoken | Δ% | 共享 read |')
  lines.push('|---|---|---:|---|---:|---:|---:|---:|')
  for (const row of results) {
    const n = row.nativeBest
    const p = row.pluginBest
    if (n === null || p === null) continue
    const delta = n.totalTokens - p.totalTokens
    lines.push(`| ${row.title} | ${n.label} | ${tok(n.totalTokens)} | ${p.label} | ${tok(p.totalTokens)} | ${signed(tok(delta))} | ${pct(delta, n.totalTokens).toFixed(0)}% | ${tok(row.sharedTokens)} |`)
  }
  lines.push('')
  lines.push('## 会话聚合')
  lines.push('')
  lines.push('| 项目 | 原生 tok | 插件 tok | Δtoken |')
  lines.push('|---|---:|---:|---:|')
  lines.push(`| 静态（×${aggregate.nativeTurns}/${aggregate.pluginTurns} 次请求） | ${tok(aggregate.staticNative * aggregate.nativeTurns)} | ${tok(aggregate.staticPluginMasked * aggregate.pluginTurns)} | ${signed(tok(aggregate.staticNative * aggregate.nativeTurns - aggregate.staticPluginMasked * aggregate.pluginTurns))} |`)
  lines.push(`| 动态（${aggregate.nativeCalls}/${aggregate.pluginCalls} 次调用） | ${tok(aggregate.nativeDynamic)} | ${tok(aggregate.pluginDynamic)} | ${signed(tok(aggregate.dynamicDelta))} |`)
  const nativeTotal = aggregate.staticNative * aggregate.nativeTurns + aggregate.nativeDynamic
  const pluginTotal = aggregate.staticPluginMasked * aggregate.pluginTurns + aggregate.pluginDynamic
  lines.push(`| **合计** | **${tok(nativeTotal)}** | **${tok(pluginTotal)}** | **${signed(tok(nativeTotal - pluginTotal))}** |`)
  lines.push('')
  if (logs !== null && logs.perBucket.length > 0) {
    lines.push('## 真实会话日志')
    lines.push('')
    lines.push('| 工具 | 形状 | 调用数 | 平均入参 | 平均结果 | 平均合计 | 最大结果 B |')
    lines.push('|---|---|---:|---:|---:|---:|---:|')
    for (const record of logs.perBucket) {
      lines.push(`| ${record.tool} | ${record.shape} | ${record.calls} | ${logs.avg(record, 'argsTokens').toFixed(1)} | ${logs.avg(record, 'resultTokens').toFixed(1)} | ${(logs.avg(record, 'argsTokens') + logs.avg(record, 'resultTokens')).toFixed(1)} | ${record.worst} |`)
    }
    lines.push('')
  }
  return lines.join('\n') + '\n'
}

// ── 10. 跑 ────────────────────────────────────────────────────────────────────

const staticRows = await staticReport()
const root = mkdtempSync(join(tmpdir(), 'dsh-bench-'))
const factory = makeFactory(root)

const selected = SCENARIOS.filter((scenario) => ONLY === '' || scenario.id.includes(ONLY) || scenario.title.includes(ONLY))
const results = []
for (const scenario of selected) results.push(await runScenario(scenario, factory))

const aggregate = sessionAggregate(results, staticRows)
const logs = WITH_LOGS ? logsReport() : null

printStatic(staticRows)
printScenarios(results)
printOptions(results)
printSession(aggregate)
if (logs !== null) printLogs(logs)

// 结论行：静态回本点与净胜。
const nativeStaticRow = staticRows.find((row) => row.label.includes('danger-full-access'))
const maskedRow = staticRows.find((row) => row.label.includes('无 escape'))
const perRequestGain = nativeStaticRow.totalTokens - maskedRow.totalTokens
const sessionNative = aggregate.staticNative * aggregate.nativeTurns + aggregate.nativeDynamic
const sessionPlugin = aggregate.staticPluginMasked * aggregate.pluginTurns + aggregate.pluginDynamic
const perCallGain = aggregate.nativeCalls === 0 ? 0 : aggregate.dynamicDelta / aggregate.nativeCalls
console.log('=== 6. 结论')
console.log(`  静态：原生 ${tok(nativeStaticRow.totalTokens)} → 插件（屏蔽原生）${tok(maskedRow.totalTokens)} tok/请求，每请求省 ${tok(perRequestGain)}`)
console.log(`  动态：原生 ${aggregate.nativeCalls} 次调用 ${tok(aggregate.nativeDynamic)} tok，插件 ${aggregate.pluginCalls} 次调用 ${tok(aggregate.pluginDynamic)} tok，省 ${tok(aggregate.dynamicDelta)}（单次平均 ${perCallGain.toFixed(1)} tok）`)
console.log(`  合计：原生 ${tok(sessionNative + aggregate.shared)} vs 插件 ${tok(sessionPlugin + aggregate.shared)} token（含共享 read ${tok(aggregate.shared)}），省 ${pct(sessionNative - sessionPlugin, sessionNative).toFixed(1)}%`)
console.log(`  作业目录：${root}`)
if (JSON_OUT !== '') {
  writeFileSync(JSON_OUT, JSON.stringify({ static: staticRows, scenarios: results, aggregate, logs }, null, 2), 'utf8')
  console.log(`  已写入 JSON：${JSON_OUT}`)
}
if (MD_OUT !== '') {
  writeFileSync(MD_OUT, markdownReport({ staticRows, results, aggregate, logs }), 'utf8')
  console.log(`  已写入 Markdown：${MD_OUT}`)
}

// 门禁：插件侧每个场景都必须有"真跑通且内容正确"的写法，且不出现比原生明显更贵的场景。
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
if (ASSERT) {
  console.log('')
  for (const row of results) {
    if (row.pluginBest === null) check(`${row.id}: 插件有可用写法`, false, '所有候选都失败或内容不对')
    else check(`${row.id}: 插件写法真跑通`, true, row.pluginBest.label)
  }
  const overCap = results.flatMap((row) => row.plugin.flatMap((run) => run.steps.filter((step) => step.resultBytes > 2048).map((step) => `${row.id}/${run.label}=${step.resultBytes}B`)))
  check('插件单条结果 <= 2048 B', overCap.length === 0, overCap.join(', '))
  const totalDelta = sessionNative - sessionPlugin
  check('会话总账插件更省', totalDelta > 0, `Δ=${tok(totalDelta)} tok`)
  check('静态开销插件更省', perRequestGain > 0, `Δ=${tok(perRequestGain)} tok/请求`)
}

rmSync(root, { recursive: true, force: true })
process.exitCode = failures === 0 ? 0 : 1
