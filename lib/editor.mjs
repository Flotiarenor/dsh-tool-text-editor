// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * editor.mjs —— dsh 模型工具插件：`edit_text` / `write_text`。
 *
 * 为什么存在：dsh 原生的 `write` / `edit` 在 Windows 上会丢掉 UTF-8 BOM，原生 `write` 还会把
 * CRLF 文件改写成 LF（实测确认；`@deepseek-ai/dsh-fs-local` 全文没有 BOM 处理，Node 的
 * `TextDecoder` 默认吞掉前导 BOM 字节）。本插件用**进程内 Node 实现**（`lib/core.mjs`）做同样
 * 的事，但把 BOM 与行尾保真、dry-run diff、自动备份、编辑台账、grep/lines 锚点一起带上。
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
 *   * 模型可见的结果文本**刻意很省**：路径只出现一次，只有一行统计加受预算约束的 diff 正文
 *     （`brief` / `diff`）；备份名等细节只留在台账与 `stdout` 里。完整 diff 走
 *     `presentationMeta` 的 UI 卡片 —— 那条路径不进模型上下文。理由见 `lib/core.mjs` 头部。
 *   * `lines` / `before <行号>` 是**盲锚点**：行号错了不会报错，会改在别的地方。
 *   * 同目标串行只覆盖**本进程内**；跨进程（另一个 dsh 实例、你手边的编辑器）仍可能互相覆盖。
 *
 * 配置（本插件没有 Config schema，preset 行的 `config:` 字段原样透传）：
 *   backup: boolean               默认 true（落盘前备份到 artifactsDir/backups）
 *   ledger: boolean               默认 true（追加 artifactsDir/edits.log）
 *   artifactsDir: string          默认 <工作区>/.dsh
 *   newFileBom: boolean           默认 false（新建文件是否写 BOM）
 *   context: number               人读 diff 的上下文行数，默认 3（只影响 stdout 与 UI 卡片）
 *   diff: 'auto'|'full'|'none'    模型可见 diff 正文的默认策略，默认 'auto'
 *   maxDiffLines: number          模型可见 diff 正文的行数预算，默认 30
 *   root: string                  没有 agent 会话时的回退工作区
 * 新建文件的行尾推断可用环境变量 `DSH_TEXT_EDITOR_EOL` = lf | crlf 覆盖（见 lib/core.mjs）。
 */

import { DIFF_MODES, UsageError, applyPlan, hunksFromDiff, toLf } from './core.mjs'

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
  + 'the file existing CRLF/LF style, print a unified diff, back the previous content up, and accept `grep` '
  + 'or `lines` anchors so the old text never has to be copied by hand. The built-in `write` tool drops the '
  + 'BOM and rewrites a CRLF file as LF, and the built-in `edit` tool drops the BOM; use the built-ins '
  + 'only when a `_text` call reports that it cannot run.'

const EDIT_DESCRIPTION =
  'Edit one existing text file. Preserves the UTF-8 BOM and the file line-ending style, backs the previous '
  + 'content up, and returns a stat line plus the changed lines when the diff is small (see '
  + '`diff`). Give exactly ONE anchor: `old_text` (literal, '
  + 'copied from `read`), `grep` (a regular expression whose matching line/block becomes the anchor), or '
  + '`lines` (e.g. "263:270"). `mode` defaults to `replace`; use `after`/`before` to insert beside a '
  + '`grep`/`lines` anchor, `append`/`prepend` for the file ends. Prefer `old_text`/`grep`: a wrong line '
  + 'number does not fail, it edits the wrong place. A literal that occurs more than once is refused unless '
  + '`nth` or `count` says which/how many. Set `dry_run` to preview without writing.'

const WRITE_DESCRIPTION =
  'Create or completely replace one text file. Preserves the UTF-8 BOM and the file line-ending style, backs '
  + 'the previous content up, and returns a stat line instead of echoing the content '
  + 'back (see `diff`). Creation needs no flag: '
  + 'the tool detects whether the target exists, and a brand-new file follows the line-ending style of its '
  + 'sibling files. Set `dry_run` to preview without writing.'

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
    strict: { type: 'boolean', description: 'Disable relaxed matching.' },
    diff: { type: 'string', description: 'Diff detail in the result: auto (default, small changes only) | full (always, capped) | none.', enum: DIFF_MODES },
    dry_run: { type: 'boolean', description: 'Print the diff without writing.' },
    note: { type: 'string', description: 'One-line reason recorded in the edit ledger.' },
  },
  required: ['file_path', 'new_text'],
}

export const WRITE_PARAMETERS = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Target file, resolved against the session working directory when relative.' },
    content: { type: 'string', description: 'Complete new file content.' },
    diff: { type: 'string', description: 'Diff detail in the result: auto (default, small changes only) | full (always, capped) | none.', enum: DIFF_MODES },
    dry_run: { type: 'boolean', description: 'Print the diff without writing.' },
    note: { type: 'string', description: 'One-line reason recorded in the edit ledger.' },
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
    wrote: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    brief: { type: 'string' },
    diff: { type: 'string' },
  },
  required: ['path', 'ok', 'wrote', 'dryRun', 'stdout', 'stderr', 'brief', 'diff'],
}

/**
 * 模型可见的结果文本：**一行统计（+ 受预算约束的 diff 正文）**。
 *
 * 这里刻意不复述任何东西：路径只出现一次，备份名只留在台账与 `stdout` 里，完整 diff 交给
 * UI 卡片。工具结果是 append-only 的会话历史、永不缓存，所以每个字节都要问一句"模型真需要吗"；
 * 失败时相反 —— 原因必须完整，因为下一次调用要靠它自救。
 */
function renderResult(_args, value) {
  const where = value.path === '' ? '' : ' ' + value.path
  if (!value.ok) {
    const detail = [value.stderr.trim(), value.stdout.trim()].filter((part) => part !== '').join('\n')
    return [{ type: 'text', text: 'FAIL' + where + '\n' + (detail === '' ? '(no output)' : detail) }]
  }
  const head = value.dryRun ? 'DRY RUN' + where + ' (nothing written)' : 'WROTE' + where
  const body = [value.brief, value.diff].map((part) => part.trim()).filter((part) => part !== '')
  return [{ type: 'text', text: [head, ...body].join('\n') }]
}

/**
 * UI diff 卡片：**完整** diff（含配置的上下文行）只走这条路径。
 * 元数据随 `tool/result` 持久化，供实时与回放两条路径使用；模型永远看不到它。
 */
function presentationMeta(_args, value) {
  const diffs = value.ok === true && value.wrote === true ? hunksFromDiff(value.stdout, value.path) : []
  return { diffs, path: value.path }
}

/** 有 diff 卡片可用就交给 UI；否则返回 `undefined`，让宿主回退到文本渲染。 */
function presentResult(_args, result) {
  if (result.isError === true) return undefined
  const meta = result.meta
  const diffs = meta !== null && typeof meta === 'object' && Array.isArray(meta.diffs) ? meta.diffs : []
  if (diffs.length === 0) return undefined
  const title = typeof meta.path === 'string' && meta.path !== '' ? meta.path : undefined
  return title === undefined ? { card: 'diff', diffs } : { card: 'diff', title, diffs }
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

function booleanArg(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new UsageError(`${label} must be a boolean`)
  return value
}

function diffModeArg(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !DIFF_MODES.includes(value)) {
    throw new UsageError('diff must be one of ' + DIFF_MODES.join(' / '))
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
    strict: booleanArg(args.strict, 'strict') === true,
    dryRun: booleanArg(args.dry_run, 'dry_run') === true,
    diff: diffModeArg(args.diff),
    note: stringArg(args.note, 'note') ?? '',
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
    dryRun: booleanArg(args.dry_run, 'dry_run') === true,
    diff: diffModeArg(args.diff),
    note: stringArg(args.note, 'note') ?? '',
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
  return {
    path: typeof path === 'string' ? path : '',
    ok: false,
    wrote: false,
    dryRun: false,
    stdout: '',
    stderr: message,
    brief: '',
    diff: '',
  }
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
    context: Number.isFinite(settings.context) ? settings.context : undefined,
    newFileBom: settings.newFileBom === true,
    ...(Number.isFinite(settings.maxDiffLines) && settings.maxDiffLines >= 1
      ? { maxDiffLines: Math.floor(settings.maxDiffLines) }
      : {}),
  }
  /** 配置层的默认 diff 策略；逐调用的 `diff` 参数优先于它。 */
  const diffDefault = DIFF_MODES.includes(settings.diff) ? settings.diff : 'auto'

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
      diff: plan.diff ?? diffDefault,
      tool: plan.kind === 'write' ? WRITE_TOOL : EDIT_TOOL,
    })
  }

  ctx.tools.register({
    name: EDIT_TOOL,
    description: EDIT_DESCRIPTION,
    parameters: EDIT_PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderResult, presentationMeta },
    presentResult,
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
    output: { schema: OUTPUT_SCHEMA, render: renderResult, presentationMeta },
    presentResult,
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
