// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * probe-mask.mjs —— 用真实 dsh 包验证门禁（`lib/mask.mjs`）在注册表里的效果。
 *
 * 分工：self-test 钉住本模块自身的行为；"看不见还是也调不动"由 dsh 注册表决定，只能在真实 `dsh-tools`
 * 上验证。这里复刻 `dsh-agent-presets` 的挂载形状（常驻作用域 + agent 作用域父级到它），门禁行用**真实
 * 作用域上下文**挂载（`apply` 阶段就要把守卫注册到该层），agent 走**真实 `ctx.agents` 注册表**：
 * `agent/created` 由注册表按作用域派发。
 *
 * 断言：本组合的 agent 没有 write / edit、直呼其名得到 `UNKNOWN_TOOL`、原生引导消失，别的组合照旧看得见
 * 也调得动；常驻作用域仍注册着它们（可见性组合，非权限边界）；没有建档事件的 agent 第一次调用被守卫否决
 * 并就地收窄；`guard` 档可见但调不动且点名 `edit_text` / `write_text`；宿主平面（没有作用域）的门禁行只否决
 * 不收窄，并留下一条 warn。
 *
 * 组合时序（建档前挂载 / 换 preset）由 `tools/repro-mask.mjs` 用真实 `dsh-agent-presets` 验证。
 * 需要装有 `@deepseek-ai/cordis` / `dsh-tools` / `dsh-scope` / `dsh-system-prompt` / `dsh-agent` 的 dsh：
 * 入口按常见布局枚举，`DSH_PACKAGES_ROOT` 可显式指定。用法 `node tools/probe-mask.mjs`。
 * 退出码：0 全过，1 有失败，2 找不到 dsh 包。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply as applyMask } from '../lib/mask.mjs'

const PACKAGES = ['cordis', 'dsh-agent', 'dsh-scope', 'dsh-system-prompt', 'dsh-tools']

/** 找一份 dsh 的 `@deepseek-ai` 包目录（枚举同 `tools/measure-context.mjs`）。 */
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
  return candidates.find((dir) => PACKAGES.every((pkg) => existsSync(join(dir, pkg, 'lib', 'index.js'))))
}

const root = findPackages()
if (root === undefined) {
  console.error(`SKIP 找不到齐备的 dsh 包（需要 ${PACKAGES.join(' / ')}）`)
  console.error('     用 DSH_PACKAGES_ROOT 指向含这些包的 @deepseek-ai 目录后重跑。')
  process.exit(2)
}

const entry = (pkg) => pathToFileURL(join(root, pkg, 'lib', 'index.js')).href
const { Context } = await import(entry('cordis'))
const { ToolRuntime } = await import(entry('dsh-tools'))
const { SystemPrompt, renderPrompt } = await import(entry('dsh-system-prompt'))
const { createScope } = await import(entry('dsh-scope'))
const { AgentRegistry } = await import(entry('dsh-agent'))

let checks = 0
let failures = 0
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${detail === '' ? '' : ' — ' + detail}`)
}

/** 最小工具定义：注册表会校验 schema，字段须齐全。 */
const tool = (name) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  output: {
    schema: {
      type: 'object',
      properties: { ran: { type: 'string' } },
      required: ['ran'],
      additionalProperties: false,
    },
    render: () => [{ type: 'text', text: `${name} ran` }],
  },
  execute: async () => ({ ran: name }),
})

/** 与 `dsh-tool-fs` 同形：原生三个工具、本插件两个工具、按可见性求值的引导段。 */
const nativeRow = {
  name: 'fake-tool-fs',
  inject: ['tools', 'systemPrompt'],
  apply(c) {
    for (const name of ['read', 'write', 'edit', 'edit_text', 'write_text']) c.tools.register(tool(name))
    c.systemPrompt.section({ name: 'tool:read', order: 100, text: 'Use the read tool for files.' })
    c.systemPrompt.section({
      name: 'tool:write',
      order: 101,
      text: ({ scope }) => (c.tools.get('write', scope) === undefined ? '' : 'Use the write tool to create files.'),
    })
    c.systemPrompt.section({
      name: 'tool:edit',
      order: 102,
      text: ({ scope }) => (c.tools.get('edit', scope) === undefined ? '' : 'Use the edit tool for targeted changes.'),
    })
  },
}

/** 把 `warn` 收进 `sink`，供断言检查。 */
function captureWarnings(ctx, sink) {
  const warn = ctx.logger?.warn?.bind(ctx.logger)
  if (warn === undefined) return
  ctx.logger.warn = (...args) => {
    sink.push(args.join(' '))
    warn(...args)
  }
}

/**
 * 搭一套与 dsh 挂载形状一致的环境：`masked` 组合 = 原生行 + 门禁行，`other` 组合 = 只有原生行（对照）。
 * `settings` 是 `mode` 之外的行配置；返回上下文、常驻作用域键、三个建 agent 的入口与警告收集。
 */
async function harness(mode, settings = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  let host
  await ctx.plugin({ name: 'host', inject: ['tools', 'systemPrompt'], apply(c) { host = c } })

  const standingKey = { kind: 'standing', id: 'preset:texteditor' }
  const otherKey = { kind: 'standing', id: 'preset:other' }
  const standing = createScope(host, standingKey)
  const other = createScope(host, otherKey)
  await standing.ctx.plugin(nativeRow)
  await other.ctx.plugin(nativeRow)

  // 门禁行必须用真实作用域上下文挂载：守卫在 `apply` 阶段就要落到本行的层上，而 `{ on, logger }` 这类
  // 壳里的 `tools` 拿不到本层，守卫会落到全局层。
  const warnings = []
  await standing.ctx.plugin({
    name: 'fake-mask-row',
    inject: ['tools', 'systemPrompt'],
    apply(c) {
      captureWarnings(c, warnings)
      applyMask(c, { mode, ...settings })
    },
  })

  /** 建一个 agent 并把作用域父级到 `parent`；`announce` 为真才登记（登记才发 `agent/created`）。 */
  const join = (id, parent, announce = true) => {
    const agent = { id, session: { id } }
    agent.ctx = createScope(host, agent, { parent }).ctx
    if (announce) ctx.agents.register(agent)
    return agent
  }

  return {
    ctx,
    warnings,
    standingKey,
    // `masked` / `silent` 加入本组合（后者不登记，只能靠守卫拦住），`control` 在另一个组合里。
    masked: (id) => join(id, standingKey),
    silent: (id) => join(id, standingKey, false),
    control: (id) => join(id, otherKey),
  }
}

const names = (ctx, scope) => ctx.tools.schemas(scope).map((schema) => schema.name).sort().join(',')
const textOf = async (ctx, scope) => renderPrompt(await ctx.systemPrompt.assemble({ scope }))
const call = (agent, name, callId) => ({
  callId,
  name,
  arguments: {},
  agent,
  signal: new AbortController().signal,
})

// ── deny 模式 ──

{
  const { ctx, standingKey, masked, control, silent: silentAgent, warnings } = await harness('deny')
  const target = masked('agent:masked')
  const sibling = control('agent:control')

  const maskedNames = names(ctx, target)
  check('deny: the masked agent no longer sees write / edit', maskedNames === 'edit_text,read,write_text', maskedNames)
  const siblingNames = names(ctx, sibling)
  check('deny: an agent of another composition keeps them', siblingNames === 'edit,edit_text,read,write,write_text', siblingNames)
  const standingNames = names(ctx, standingKey)
  check(
    'deny: the preset scope still has them registered (visibility composition, not an authority boundary)',
    standingNames === 'edit,edit_text,read,write,write_text',
    standingNames,
  )

  const denied = await ctx.tools.execute(call(target, 'edit', 'deny-edit'))
  check(
    'deny: calling edit by name is UNKNOWN_TOOL, not a hidden back door',
    denied.isError === true && denied.error?.info?.code === 'UNKNOWN_TOOL',
    JSON.stringify(denied.error ?? denied).slice(0, 160),
  )
  const allowed = await ctx.tools.execute(call(sibling, 'edit', 'control-edit'))
  check('deny: the control agent still executes edit (testing stays possible)', allowed.isError !== true, JSON.stringify(allowed).slice(0, 160))

  const maskedText = await textOf(ctx, target)
  const controlText = await textOf(ctx, sibling)
  check(
    'deny: the native guidance is gone for the masked agent, kept for the control',
    !/write tool|edit tool/.test(maskedText) && /write tool/.test(controlText) && /edit tool/.test(controlText),
    JSON.stringify([maskedText, controlText]),
  )
  check('deny: the read guidance survives on both', /read tool/.test(maskedText) && /read tool/.test(controlText))

  // 建档事件之外的通路：没有登记就没有 `agent/created`，只能靠守卫在第一次调用时拦住它并就地收窄。
  const silent = silentAgent('agent:silent')
  const silentNames = names(ctx, silent)
  check('deny: an unannounced agent starts out seeing the natives', silentNames === 'edit,edit_text,read,write,write_text', silentNames)
  const blocked = await ctx.tools.execute(call(silent, 'edit', 'guarded-edit'))
  const blockedBody = JSON.stringify(blocked)
  check(
    'deny: the apply-time guard blocks the first native call even without any creation event',
    blocked.isError === true && /edit_text/.test(blockedBody),
    blockedBody.slice(0, 200),
  )
  const narrowedNames = names(ctx, silent)
  check(
    'deny: that blocked call narrowed the agent right away',
    narrowedNames === 'edit_text,read,write_text',
    narrowedNames,
  )
  check('deny: the mask row logged no failure', warnings.length === 0, JSON.stringify(warnings).slice(0, 200))
}

// ── guard 模式 ──

{
  const { ctx, masked } = await harness('guard')
  const watched = masked('agent:watched')

  const watchedNames = names(ctx, watched)
  check('guard: the tools stay visible', watchedNames === 'edit,edit_text,read,write,write_text', watchedNames)
  const refused = await ctx.tools.execute(call(watched, 'edit', 'guard-edit'))
  const body = JSON.stringify(refused)
  check(
    'guard: the call is refused with a reason that points at our tools',
    refused.isError === true && /edit_text/.test(body) && /write_text/.test(body),
    body.slice(0, 200),
  )
  const ok = await ctx.tools.execute(call(watched, 'read', 'guard-read'))
  check('guard: other tools are unaffected', ok.isError !== true, JSON.stringify(ok).slice(0, 120))
}

// ── 宿主平面：没有作用域的门禁行只做否决，绝不收窄 ──

{
  // 宿主平面形状：原生工具由宿主平面提供（等价于 profile 层的 tool-fs 行），没有 preset 参与；门禁行也从
  // 宿主平面挂——它的上下文没有作用域，守卫因而落到全局层，那一档必须只否决、绝不收窄。
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const warnings = []
  await ctx.plugin({
    name: 'fake-global-tool-fs',
    inject: ['tools', 'systemPrompt'],
    apply(c) {
      for (const name of ['read', 'write', 'edit', 'edit_text', 'write_text']) c.tools.register(tool(name))
    },
  })
  await ctx.plugin({
    name: 'fake-global-mask-row',
    inject: ['tools', 'systemPrompt'],
    apply(c) {
      captureWarnings(c, warnings)
      applyMask(c, { mode: 'guard' })
    },
  })
  const plain = { id: 'agent:plain', session: { id: 'agent:plain' }, ctx }
  ctx.agents.register(plain)
  if (warnings.length > 0) console.log(`      mask warnings: ${JSON.stringify(warnings)}`)
  const plainNames = names(ctx, plain)
  check('host plane: every agent still sees the natives (guard only, no narrowing)', plainNames === 'edit,edit_text,read,write,write_text', plainNames)
  const denied = await ctx.tools.execute(call(plain, 'edit', 'global-edit'))
  const deniedBody = JSON.stringify(denied)
  check(
    'host plane: the call is refused with the reason pointing at our tools',
    denied.isError === true && /edit_text/.test(deniedBody),
    deniedBody.slice(0, 140),
  )
  const ours = await ctx.tools.execute(call(plain, 'edit_text', 'global-ours'))
  check('host plane: our own tools are untouched', ours.isError !== true, JSON.stringify(ours).slice(0, 120))
  check(
    'host plane: the degradation is logged once',
    warnings.some((message) => /宿主平面/.test(message)),
    JSON.stringify(warnings),
  )
}

console.log('')
console.log(`${checks - failures}/${checks} checks passed  (dsh packages: ${root})`)
process.exitCode = failures === 0 ? 0 : 1
