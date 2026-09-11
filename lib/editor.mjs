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
 *     临时文件 + fsync + rename 等价，这段绕过的代价已在 README 写明。
 *   * 模型可见文本只有一行统计（外加必要的警告）：**不回显改动内容**，理由见 `lib/core.mjs` 头部。
 *     成功路径的形状是 `WROTE <路径>` 加 `replace@17 +1/-1`，失败路径是完整原因。
 *   * `lines` / `before <行号>` 是**盲锚点**：行号错了不会报错，会改在别的地方。
 *   * 同目标串行只覆盖**本进程内**；跨进程（另一个 dsh 实例、你手边的编辑器）仍可能互相覆盖。
 *
 * 配置（本插件没有 Config schema，preset 行的 `config:` 字段原样透传）：
 *   backup: boolean               默认 true（落盘前备份到 artifactsDir/backups）
 *   ledger: boolean               默认 true（追加 artifactsDir/edits.log）
 *   artifactsDir: string          默认 <工作区>/.dsh
 *   newFileBom: boolean           默认 false（新建文件是否写 BOM）
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
const GUIDANCE =
  'Prefer `edit_text` and `write_text` for text changes in this workspace: they preserve a UTF-8 BOM and '
  + 'the file existing CRLF/LF style, back the previous content up, and accept `grep` or `lines` anchors so '
  + 'the old text never has to be copied by hand. The built-in `write` tool drops the BOM and rewrites a '
  + 'CRLF file as LF, and the built-in `edit` tool drops the BOM; use the built-ins only when a `_text` '
  + 'call reports that it cannot run.'

const EDIT_DESCRIPTION =
  'Edit one existing text file. Preserves the UTF-8 BOM and the file line-ending style, backs the previous '
  + 'content up, and returns one stat line such as `replace@17 +1/-1` instead of echoing the change. '
  + 'Give exactly ONE anchor: `old_text` (literal, from `read`), `grep` (regex), or `lines` (e.g. "263:270"). '
  + '`mode` defaults to `replace`; `after`/`before` insert beside a `grep`/`lines` anchor, `append`/`prepend` '
  + 'use the file ends. Prefer `old_text`/`grep` over `lines`: a wrong line number does not fail, it edits the '
  + 'wrong place. A literal that matches more than once is refused unless `nth` or `count` disambiguates it; '
  + 'a near miss returns the closest candidates.'

const WRITE_DESCRIPTION =
  'Create or completely replace one text file. Preserves the UTF-8 BOM and the file line-ending style, backs '
  + 'the previous content up, and returns one stat line instead of echoing the content back. '
  + 'A missing target is created, missing parent directories included; a brand-new file follows the '
  + 'line-ending style of its sibling files.'

/** 参数 schema（等价于 defineTool 对 `tools/gen-schema.mjs` 里 DSL 的产物；那里会校验二者一致）。 */
export const EDIT_PARAMETERS = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Target file, resolved against the session working directory when relative.' },
    new_text: { type: 'string', description: 'Replacement / inserted text.' },
    old_text: { type: 'string', description: 'Literal anchor text to replace (exactly one anchor source).' },
    grep: { type: 'string', description: 'Regular-expression anchor: the matching line or line block is replaced.' },
    lines: { type: 'string', description: 'Line anchor, e.g. "263:270" or "120".' },
    mode: { type: 'string', description: 'Edit kind. Default replace.', enum: EDIT_MODES },
    count: { type: 'number', description: 'Require exactly N occurrences and replace all of them.' },
    nth: { type: 'number', description: 'Replace the k-th occurrence only (1-based).' },
  },
  required: ['file_path', 'new_text'],
}

export const WRITE_PARAMETERS = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Target file, resolved against the session working directory when relative.' },
    content: { type: 'string', description: 'Complete new file content.' },
  },
  required: ['file_path', 'content'],
}

/** 两个工具共用的规范返回值。一切都在进程内完成，所以只有结果，没有退出码或后端标记。 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    ok: { type: 'boolean' },
    brief: { type: 'string' },
    stderr: { type: 'string' },
  },
  required: ['path', 'ok', 'brief', 'stderr'],
}

/**
 * 模型可见的结果文本：**一行统计**（成功）或**完整失败原因**（失败）。
 *
 * 成功路径不回显改动内容：调用方刚发过 `new_text`，`brief` 里的 `replace@17 +1/-1` 已经说明改在
 * 哪几行、改了多少；要看正文时 `read` 一次即可。失败路径相反——原因必须完整，它决定下一次调用。
 */
function renderResult(_args, value) {
  const where = value.path === '' ? '' : ' ' + value.path
  if (!value.ok) {
    const detail = value.stderr.trim()
    return [{ type: 'text', text: 'FAIL' + where + '\n' + (detail === '' ? '(no reason given)' : detail) }]
  }
  const body = value.brief.trim()
  return [{ type: 'text', text: body === '' ? 'WROTE' + where : 'WROTE' + where + '\n' + body }]
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
  const nth = integerArg(args.nth, 'nth', 1)
  if (count !== undefined && nth !== undefined) throw new UsageError('count and nth are mutually exclusive')
  return {
    kind: 'edit',
    filePath,
    mode,
    newText: toLf(args.new_text),
    oldText: oldText === undefined ? null : toLf(oldText),
    anchor: grep !== undefined ? { value: grep } : lines !== undefined ? { value: lines } : null,
    count,
    nth,
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

/** 会话工作区；没有 agent 时退化为给出的 fallback。 */
function workspaceRoot(exec, fallback) {
  const session = exec && exec.agent && exec.agent.session
  const cwd = session && session.header ? session.header.cwd : undefined
  if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
  return fallback
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

  ctx.systemPrompt.section({ name: 'tool:edit_text', order: 116, text: GUIDANCE })

  /**
   * 组装上下文并执行。
   * @param plan - `planEdit` / `planWrite` 的结果。
   * @param exec - 工具执行上下文（提供会话工作区）。
   */
  async function run(plan, exec) {
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
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
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
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
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
