// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * editor.mjs —— dsh 模型工具插件：`edit_text` / `write_text`。
 *
 * 为什么存在（三条，其余都是附加）：原生 `write` / `edit` 由 `@deepseek-ai/dsh-fs-local` 实现，
 *   1. **丢 UTF-8 BOM**：该文件没有 BOM 处理，Node 的 `TextDecoder` 默认吞掉前导 BOM 字节；
 *   2. **改写行尾**：`writeText` 不按原文件风格还原，CRLF 文件被拍成 LF；
 *   3. **只做精确匹配**：`old_string` 差一个空格就报 `FS_EDIT_NOT_FOUND`，没有回退。
 * 本插件用**进程内 Node 实现**（`lib/core.mjs`）做同样的事，把这三点修好，并把备份、台账与
 * `grep`/`lines` 锚点作为可选便利一起带上。
 *
 * 与原生工具的关系：注册的是两个**不与原生重名**的工具，原生 `edit`/`write` 原样保留，
 * 因此没有同名注册冲突，回退就是给 preset 行加 `disabled: true`。
 *
 * 依赖：**零**。只用 `node:` 内置模块 —— 不启动解释器或外部命令，不 import 任何包，没有构建
 * 步骤、没有第三方依赖、没有外部运行时。因此本文件既能被 preset 行用绝对路径加载，也能被 link
 * 进 profile 后按包名加载（preset 行的裸包名走宿主基址解析，模块内部的裸 import 走文件真实路径
 * 解析；零依赖让两种挂载方式都成立）。内嵌的 JSON Schema 是用 dsh 自己的
 * `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema` 生成的（生成脚本在仓库里，见
 * `tools/gen-schema.mjs`；它不随包发布）。
 *
 * 有意为之的取舍：
 *   * 写盘**不经过** `ctx.fs`：绕过 fs 观察策略（先读后写 / 版本新鲜度）、沙箱与
 *     `sandbox_permissions` 审批升权、原生原子写与 Windows DACL 保留。原生原子写与本插件的
 *     临时文件 + fsync + rename 等价，这段绕过的代价已在 README 写明。正因为这条路径上没有第二个
 *     强制点，插件把会话文件策略里**唯一禁止写入的那一档**镜像了回来：`read-only` 会话下在
 *     任何 I/O 之前拒写（见 `isReadOnly`）。
 *   * 模型可见文本只有一行统计（外加必要的警告）：**既不回显改动内容，也不回显路径**——结果与调用
 *     一一绑定，`new_text` 与 `file_path` 都在调用方自己的那一轮里。成功路径是 `WROTE` 加
 *     `replace@17 +1/-1`，失败路径是 `FAIL` 加完整原因。理由与实测数字见 `renderResult`。
 *   * "哪个文件、改了什么"落在**呈现通道**：`presentCall` / `presentationMeta` / `presentResult`
 *     给 GUI 画 diff 卡片，载荷有上限（`core.PRESENT_MAX_*`），且永不进入模型上下文。
 *   * `lines` / `before <行号>` 是**盲锚点**：行号错了不会报错，会改在别的地方。
 *   * 同目标串行只覆盖**本进程内**；跨进程（另一个 dsh 实例、你手边的编辑器）仍可能互相覆盖。
 *
 * 配置（本插件没有 Config schema，preset 行的 `config:` 字段原样透传）：
 *   backup: boolean               默认 true（落盘前备份到 artifactsDir/backups）
 *   ledger: boolean               默认 true（追加 artifactsDir/edits.log）
 *   artifactsDir: string          默认 <工作区>/.dsh
 *   newFileBom: boolean           默认 false（新建文件是否写 BOM）
 *   guidance: 'full' | 'short' | false  默认 'full'；短版去掉"优先于原生"那半句（原生已被
 *                                 `lib/mask.mjs` 屏蔽时才该用），false 则整段不注册
 *   root: string                  没有 agent 会话时的回退工作区
 * 新建文件的行尾推断可用环境变量 `DSH_TEXT_EDITOR_EOL` = lf | crlf 覆盖（见 lib/core.mjs）。
 */

import { UsageError, applyPlan, toLf } from './core.mjs'

export const name = 'tool-text-editor'

/** 只消费宿主服务（工具注册表 / 系统提示词）；不发布任何服务。 */
export const inject = ['tools', 'systemPrompt']

const EDIT_TOOL = 'edit_text'
const WRITE_TOOL = 'write_text'
const TIMEOUT_MS = 60_000
const EDIT_MODES = ['replace', 'after', 'before', 'append', 'prepend']

/** 工具引导（order 116，落在工具引导区间 100–199）。文本里不能出现双花括号（会被当提示词变量）。 */
const GUIDANCE_FULL =
  'Prefer `edit_text`/`write_text` over the built-in `edit`/`write` for text changes: they keep the UTF-8 '
  + 'BOM and the file CRLF/LF style. The built-ins drop the BOM, and `write` flattens CRLF to LF; use them '
  + 'only when a `_text` call cannot run.'

/**
 * `guidance: 'short'` 用的文本：原生 `edit`/`write` 已被 `lib/mask.mjs` 从这个 agent 的可见面去掉，
 * "prefer … over the built-in" 这半句成了死重（模型看不到那两个工具），所以只留"用哪个、保什么"。
 */
const GUIDANCE_SHORT =
  'Use `edit_text` for targeted changes and `write_text` to create or replace a file: both keep the UTF-8 '
  + 'BOM and the file CRLF/LF style, and report one stat line.'

/** `guidance` 的合法取值。 */
const GUIDANCE_MODES = ['full', 'short', false]

const EDIT_DESCRIPTION =
  'Edit one existing text file. Preserves the BOM and line endings; returns one stat line '
  + '(`replace@17 +1/-1`) instead of echoing the change. Give exactly ONE anchor: `old_text`, `grep` '
  + '(regex) or `lines`. Prefer `old_text`/`grep`: a wrong line number edits the wrong place without '
  + 'failing. A literal matching more than once is refused unless `count` declares how many you expect; a near '
  + 'miss returns the closest candidates.'

const WRITE_DESCRIPTION =
  'Create or completely replace one text file. Preserves the BOM and line endings; returns one stat line '
  + 'instead of echoing the content. A missing target is created, parent directories included; a new file '
  + 'borrows its siblings\' line-ending style.'

/** 参数 schema（等价于 defineTool 对 `tools/gen-schema.mjs` 里 DSL 的产物；那里会校验二者一致）。 */
export const EDIT_PARAMETERS = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Target file; relative resolves against the session cwd.' },
    new_text: { type: 'string', description: 'Replacement / inserted text.' },
    old_text: { type: 'string', description: 'Literal anchor text (exactly one anchor source).' },
    grep: { type: 'string', description: 'Regex anchor: the matching line block, its trailing newline included.' },
    lines: { type: 'string', description: 'Line anchor, e.g. "263:270" or "120"; trailing newline included.' },
    mode: { type: 'string', description: 'replace (default) substitutes the anchor; after/before insert beside a grep/lines anchor; append/prepend use the file ends.', enum: EDIT_MODES },
    count: { type: 'number', description: 'Declare the expected number of hits (mismatch refuses to write); for `lines` anchors it declares how many lines the anchor covers.' },
  },
  required: ['file_path', 'new_text'],
}

export const WRITE_PARAMETERS = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Target file; relative resolves against the session cwd.' },
    content: { type: 'string', description: 'Complete new file content.' },
  },
  required: ['file_path', 'content'],
}

/**
 * 两个工具共用的规范返回值。一切都在进程内完成，所以只有结果，没有退出码或后端标记。
 *
 * 前四个字段是**模型通道**的依据（`render` 只读它们）；后三个是**呈现通道**（GUI diff 卡片）的载荷，
 * 只经 `output.presentationMeta` 投影进会话日志，永远不进模型上下文。失败值只需前四个字段。
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    ok: { type: 'boolean' },
    brief: { type: 'string' },
    stderr: { type: 'string' },
    operation: { type: 'string', enum: ['create', 'update'] },
    hunks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          oldText: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          newText: { type: 'string' },
        },
        required: ['oldText', 'newText'],
      },
    },
    hunksTruncated: { type: 'boolean' },
  },
  required: ['path', 'ok', 'brief', 'stderr'],
}

/**
 * 模型可见的结果文本：**一行统计**（成功）或**完整失败原因**（失败）。
 *
 * 成功路径不回显改动内容：调用方刚发过 `new_text`，`brief` 里的 `replace@17 +1/-1` 已经说明改在
 * 哪几行、改了多少；要看正文时 `read` 一次即可。失败路径相反——原因必须完整，它决定下一次调用。
 *
 * **不回显路径**：结果与调用一一绑定（`tool/result` 带 `source.callId`），调用参数里的 `file_path`
 * 就在同一轮历史里，逐字回显它新信息量为零。实测（本机 79 个会话、86 条当前形状的结果）成功路径
 * 单条平均 116 B，其中 `WROTE <路径>` 一行占 55.6 B；去掉路径后降到 66 B（−43%）。
 * "是哪个文件、改了什么"改由呈现通道承担：`presentCall` / `presentationMeta` / `presentResult`。
 */
function renderResult(_args, value) {
  if (!value.ok) {
    const detail = value.stderr.trim()
    return [{ type: 'text', text: 'FAIL\n' + (detail === '' ? '(no reason given)' : detail) }]
  }
  const body = value.brief.trim()
  return [{ type: 'text', text: body === '' ? 'WROTE' : 'WROTE\n' + body }]
}

function stringArg(value, label, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw new UsageError(`${label} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new UsageError(`${label} must be a string`)
  if (required && value.trim() === '') throw new UsageError(`${label} must be a non-empty string`)
  return value
}

function integerArg(value, label, minimum) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new UsageError(`${label} must be an integer >= ${minimum}`)
  }
  return value
}

/**
 * 校验并归一 `edit_text` 入参。
 * @throws {UsageError} 参数不合法（不会落盘）。
 */
export function planEdit(args) {
  const filePath = stringArg(args.file_path, 'file_path', { required: true })
  if (typeof args.new_text !== 'string') throw new UsageError('new_text must be a string')
  const mode = args.mode === undefined ? 'replace' : args.mode
  if (typeof mode !== 'string' || !EDIT_MODES.includes(mode)) {
    throw new UsageError('mode must be one of ' + EDIT_MODES.join(' / '))
  }
  const oldText = stringArg(args.old_text, 'old_text')
  const grep = stringArg(args.grep, 'grep')
  const lines = args.lines === undefined ? undefined : String(args.lines)
  const anchors = []
  if (oldText !== undefined) anchors.push('old_text')
  if (grep !== undefined) anchors.push('grep')
  if (lines !== undefined) anchors.push('lines')
  if (mode === 'replace') {
    if (anchors.length === 0) throw new UsageError('replace requires exactly one anchor: old_text, grep or lines')
    if (anchors.length > 1) throw new UsageError('give exactly one anchor, got ' + anchors.join(' + '))
  } else if (mode === 'after' || mode === 'before') {
    if (oldText !== undefined) throw new UsageError(mode + ' takes grep or lines, not old_text')
    if (anchors.length !== 1) throw new UsageError(mode + ' requires exactly one of grep / lines')
  } else if (anchors.length > 0) {
    throw new UsageError(mode + ' takes no anchor, got ' + anchors.join(' + '))
  }
  const count = integerArg(args.count, 'count', 1)
  return {
    kind: 'edit',
    filePath,
    mode,
    newText: toLf(args.new_text),
    oldText: oldText === undefined ? null : toLf(oldText),
    anchor: grep !== undefined ? { value: grep } : lines !== undefined ? { value: lines } : null,
    count,
  }
}

/** 校验并归一 `write_text` 入参。 */
export function planWrite(args) {
  const filePath = stringArg(args.file_path, 'file_path', { required: true })
  if (typeof args.content !== 'string') throw new UsageError('content must be a string')
  return {
    kind: 'write',
    filePath,
    content: toLf(args.content),
  }
}

/**
 * 会话工作区；没有 agent 时退化为给出的 fallback。 */
function workspaceRoot(exec, fallback) {
  const session = exec && exec.agent && exec.agent.session
  const cwd = session && session.header ? session.header.cwd : undefined
  if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
  return fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// 呈现通道：GUI 的 diff 卡片（不进模型上下文）
// ─────────────────────────────────────────────────────────────────────────────
//
// 模型那边只有一行统计，于是"改了哪个文件、改了什么"由这一段承担：
//   * `presentCall(args)`      —— 待定卡片：意图完全来自参数（纯函数，宿主在流式与回放两条路径上都调）；
//   * `presentationMeta(args, value)` —— 结果侧投影：已落盘的 hunk，随会话日志持久化；
//   * `presentResult(args, result)`   —— 把投影窄化成卡片视图，畸形或空投影一律回落到原始结果文本。
// 三者都必须**不抛异常**：宿主（api-proxy）会 catch 并降级成通用卡片，但那等于这段功能白写。

/** presenter 拿到的是未校验的参数（模型可以发任何东西），所以每一步都要窄化。 */
function recordOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** 非空字符串，其余一律 `undefined`。 */
function stringOf(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 回放时的畸形 meta 防护：只接受完整形状的 FileDiff。 */
function isFileDiff(value) {
  const diff = recordOf(value)
  if (diff === null) return false
  return typeof diff.path === 'string'
    && (diff.oldText === null || typeof diff.oldText === 'string')
    && typeof diff.newText === 'string'
}

/** 待定卡片（`edit_text`）：`grep` / `lines` 锚点没有现成的 old 文本，按新增侧展示。 */
function presentEditCall(args) {
  const call = recordOf(args)
  if (call === null) return undefined
  const path = stringOf(call.file_path)
  if (path === undefined || typeof call.new_text !== 'string') return undefined
  return {
    card: 'diff',
    title: 'Edit ' + path,
    diffs: [{ path, oldText: stringOf(call.old_text) ?? null, newText: call.new_text }],
    locations: [{ path }],
  }
}

/** 待定卡片（`write_text`）：参数看不出目标是否已存在，按整篇展示；结果侧会用真实 hunk 修正。 */
function presentWriteCall(args) {
  const call = recordOf(args)
  if (call === null) return undefined
  const path = stringOf(call.file_path)
  if (path === undefined || typeof call.content !== 'string') return undefined
  return {
    card: 'diff',
    title: 'Write ' + path,
    diffs: [{ path, oldText: null, newText: call.content }],
    locations: [{ path }],
  }
}

/** 结果侧投影：hunk + 标题，进会话日志。失败或没有可展示的 hunk 时给空 `diffs`。 */
function presentEditMeta(args, value) {
  const result = recordOf(value)
  if (result === null || result.ok !== true) return { diffs: [] }
  const call = recordOf(args)
  const path = stringOf(call === null ? undefined : call.file_path) ?? stringOf(result.path) ?? ''
  const diffs = []
  for (const hunk of Array.isArray(result.hunks) ? result.hunks : []) {
    const entry = recordOf(hunk)
    if (entry === null || typeof entry.newText !== 'string') continue
    diffs.push({
      path,
      oldText: entry.oldText === null || typeof entry.oldText === 'string' ? entry.oldText : null,
      newText: entry.newText,
    })
  }
  const verb = result.operation === 'create' ? 'Write' : 'Edit'
  const suffix = result.hunksTruncated === true ? '（部分 diff）' : ''
  return { title: `${verb} ${path}${suffix}`, diffs }
}

/** 已落盘的结果卡片；空投影或畸形投影返回 `undefined`，让宿主回落到原始结果文本。 */
function presentEditResult(_args, result) {
  const settled = recordOf(result)
  if (settled === null || settled.isError === true) return undefined
  const meta = recordOf(settled.meta)
  if (meta === null || !Array.isArray(meta.diffs)) return undefined
  const diffs = meta.diffs.filter(isFileDiff)
  if (diffs.length === 0) return undefined
  return typeof meta.title === 'string'
    ? { card: 'diff', title: meta.title, diffs }
    : { card: 'diff', diffs }
}

// ─────────────────────────────────────────────────────────────────────────────
// 会话文件策略：read-only 时一并拒写
// ─────────────────────────────────────────────────────────────────────────────

/** read-only 会话里的拒写原因。说清"是策略，不是参数错"，否则调用方会浪费一次重试。 */
const READ_ONLY_REASON = '当前文件策略 read-only，拒绝写入（策略来自会话设置，不是路径问题）。'

/**
 * 会话当前是否处于 `read-only` 文件策略。
 *
 * 本插件的写入**绕开 `ctx.fs`**（fs seam 的变更原语只有 `writeText`/`editText`，会丢 BOM、拍平
 * CRLF），因此没有第二个强制点：沙箱、审批、`fs/observed` 都不在这条路径上。这里读宿主自己的
 * `sandboxPolicy` 归属方（`resolve({ session })`），把 read-only 这一档镜像回来——不新增任何提示词
 * 或 schema 字段，只在真的拒一次时产生一行失败原因。
 *
 * 刻意为之的取舍：`sandboxPolicy` 是**可选**消费（`ctx.get`，不进 `inject`），服务缺席或解析失败
 * 一律按"不是只读"处理——本工具不是安全边界，策略服务异常不该把写盘全禁掉。`workspace-write` 与
 * `danger-full-access` 仍走既有的常量护栏（见 README 已知限制）。
 *
 * @param ctx - 插件上下文（用于 `ctx.get('sandboxPolicy')`）。
 * @param exec - 工具执行上下文（提供会话）。
 * @returns 是否只读。
 */
function isReadOnly(ctx, exec) {
  // 模拟 ctx（自测与量测脚本）没有 `get`：当成"没有策略事实"。
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return false
  const policy = ctx.get('sandboxPolicy')
  if (policy === null || typeof policy !== 'object' || typeof policy.resolve !== 'function') return false
  try {
    const session = exec && exec.agent ? exec.agent.session : undefined
    const resolved = policy.resolve({ session })
    return recordOf(resolved) !== null && resolved.mode === 'read-only'
  } catch {
    return false
  }
}

function fail(path, message) {
  return { path: typeof path === 'string' ? path : '', ok: false, brief: '', stderr: message }
}

/**
 * 注册 `edit_text` / `write_text` 与工具引导段。
 * @param ctx - 插件上下文（注册随其 fiber 释放）。
 * @param config - preset 行配置（见文件头注释）。
 */
export function apply(ctx, config) {
  const settings = config === undefined || config === null ? {} : config
  const fallbackRoot = typeof settings.root === 'string' && settings.root !== '' ? settings.root : process.cwd()
  const artifactsDir = typeof settings.artifactsDir === 'string' && settings.artifactsDir !== ''
    ? settings.artifactsDir
    : undefined
  const planOptions = {
    backup: settings.backup !== false,
    log: settings.ledger !== false,
    newFileBom: settings.newFileBom === true,
  }
  const guidance = settings.guidance === undefined ? 'full' : settings.guidance
  if (!GUIDANCE_MODES.includes(guidance)) {
    throw new Error(`tool-text-editor: guidance must be one of full | short | false, got ${JSON.stringify(settings.guidance)}`)
  }

  // 引导段是可选的：屏蔽掉原生工具后（见 `lib/mask.mjs`），`guidance: 'short'` 省掉那半句已经作废的
  // "prefer … over the built-in"；`false` 则整段不注册（工具描述本身已经讲清用法）。
  if (guidance !== false) {
    ctx.systemPrompt.section({ name: 'tool:edit_text', order: 116, text: guidance === 'short' ? GUIDANCE_SHORT : GUIDANCE_FULL })
  }

  /**
   * 组装上下文并执行。
   * @param plan - `planEdit` / `planWrite` 的结果。
   * @param exec - 工具执行上下文（提供会话工作区）。
   */
  async function run(plan, exec) {
    if (isReadOnly(ctx, exec)) return fail(plan.filePath, READ_ONLY_REASON)
    const root = workspaceRoot(exec, fallbackRoot)
    return await applyPlan(plan, {
      root,
      ...(artifactsDir === undefined ? {} : { artifactsDir }),
      ...planOptions,
      tool: plan.kind === 'write' ? WRITE_TOOL : EDIT_TOOL,
    })
  }

  ctx.tools.register({
    name: EDIT_TOOL,
    description: EDIT_DESCRIPTION,
    parameters: EDIT_PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderResult, presentationMeta: presentEditMeta },
    presentCall: presentEditCall,
    presentResult: presentEditResult,
    timeoutMs: TIMEOUT_MS,
    async execute(args, exec) {
      let plan
      try {
        plan = planEdit(args)
      } catch (error) {
        if (error instanceof UsageError) return fail(args.file_path, error.message)
        throw error
      }
      return await run(plan, exec)
    },
  })

  ctx.tools.register({
    name: WRITE_TOOL,
    description: WRITE_DESCRIPTION,
    parameters: WRITE_PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderResult, presentationMeta: presentEditMeta },
    presentCall: presentWriteCall,
    presentResult: presentEditResult,
    timeoutMs: TIMEOUT_MS,
    async execute(args, exec) {
      let plan
      try {
        plan = planWrite(args)
      } catch (error) {
        if (error instanceof UsageError) return fail(args.file_path, error.message)
        throw error
      }
      return await run(plan, exec)
    },
  })
}
