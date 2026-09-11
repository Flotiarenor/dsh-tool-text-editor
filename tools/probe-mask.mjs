// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * probe-mask.mjs —— 用**真实的** dsh 包验证门禁（`lib/mask.mjs`）在注册表里的实际效果。
 *
 * 为什么单独有这么一个工具：self-test 里的门禁用假 ctx 钉住"本模块自己的行为"，而"被拒的名字到底
 * 是**看不见**还是**看不见也调不动**"由 dsh 的注册表决定——那件事只能在真实的 `dsh-tools` 上验证。
 * 这里复刻 `dsh-agent-presets` 的挂载形状（preset 常驻作用域 + agent 作用域父级到它），把合成的
 * `read`/`write`/`edit` 与它们的引导段注册进常驻层，门禁行也用**真实的作用域上下文**挂上去
 * （`apply` 阶段就要把守卫注册到那一层），agent 走**真实的 `ctx.agents` 注册表**：`agent/created`
 * 由注册表按作用域派发，不再手工投递。然后断言：
 *
 *   * 加入本组合的 agent：工具表里没有 write / edit；直呼其名得到 UNKNOWN_TOOL（**不是**"藏起来但
 *     还能调"）；原生那两段引导随之消失；
 *   * 别的组合里的 agent 照旧看得见、也调得动（这就是"屏蔽之后还能测吗"的答案：换一个组合即可）；
 *   * 常驻作用域自己看：工具**仍然注册在注册表里**——门禁是可见性组合，不是权限边界；
 *   * **没有经过建档事件**的 agent（只把作用域父级到常驻键）也拦得住：第一次调用被守卫否决，并且
 *     被顺手收窄，于是下一次请求的工具表就干净了（`apply` 阶段挂守卫的意义）；
 *   * `mode: 'guard'` 下工具保持可见、调用被否决，且原因里点名 `edit_text` / `write_text`；
 *   * `escape: true` 下原生**名字**看不见，但 `native_*` 能跑同一个执行体；
 *   * `scope: 'global'` 下所有 agent 都看得见、都调不动。
 *
 * **组合时序**（建档前挂载 / 换 preset）不在这里验：那是 `tools/repro-mask.mjs` 的事，它用真实的
 * `dsh-agent-presets` 跑 `mount()` / `recompose()`。
 *
 * 需要一份装有 `@deepseek-ai/cordis` / `dsh-tools` / `dsh-scope` / `dsh-system-prompt` / `dsh-agent`
 * 的 dsh：入口按常见布局去找（`DSH_PACKAGES_ROOT` 可显式指定）。找不到时退出码 2（"这次没跑成"）。
 *
 * 用法：
 *   node tools/probe-mask.mjs
 *   $env:DSH_PACKAGES_ROOT = '<dsh profile>/node_modules/@deepseek-ai'; node tools/probe-mask.mjs
 * 退出码：0 全过，1 有失败，2 找不到 dsh 包。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply as applyMask } from '../lib/mask.mjs'

const PACKAGES = ['cordis', 'dsh-agent', 'dsh-scope', 'dsh-system-prompt', 'dsh-tools']

/**
 * 找一份 dsh 的 `@deepseek-ai` 包目录（与 `tools/measure-context.mjs` 同一套布局枚举）。
 * @returns 含全部所需包的目录，或 `undefined`。
 */
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

/** 一个最小的工具定义（schema 会被注册表校验，所以字段必须齐全）。 */
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

/** 与 `dsh-tool-fs` 同形的行：原生工具 + 本插件的两个工具 + **按可见性求值**的引导段。 */
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

/**
 * 搭一套与 dsh 挂载形状一致的环境。
 *
 * `masked` 组合 = 原生行 + 门禁行（真作用域上下文）；`other` 组合 = 只有原生行——它就是对照片：
 * 门禁影响的是"加入本组合的 agent"，不是"整台机器上的工具"。
 *
 * @param mode - 门禁模式（`deny` / `guard`）。
 * @param settings - 行配置的额外字段。
 * @returns 上下文、两个常驻作用域键、建 agent 的入口与警告收集。
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

  // 门禁行：`apply` 阶段就要把守卫注册到**本行的作用域层**上，所以必须用真实的作用域上下文挂，
  // 而不是一个 `{ on, logger }` 的壳——壳里的 `tools` 拿不到本行的层，守卫会落到全局层上去。
  const warnings = []
  await standing.ctx.plugin({
    name: 'fake-mask-row',
    inject: ['tools', 'systemPrompt'],
    apply(c) {
      const original = c.logger?.warn?.bind(c.logger)
      if (original !== undefined) c.logger.warn = (message) => { warnings.push(String(message)); original(message) }
      applyMask(c, { mode, ...settings })
    },
  })

  /**
   * 建一个 agent 并把作用域父级到给定常驻键。
   * @param id - agent 与 session 共用的 id。
   * @param parent - 父级常驻键；默认**不**加入任何组合（用来验"只靠守卫也拦得住"）。
   * @param announce - 是否登记进注册表（登记才会派发 `agent/created`）。
   * @returns the agent。
   */
  const join = (id, parent = undefined, announce = true) => {
    const agent = { id, session: { id } }
    agent.ctx = createScope(host, agent, parent === undefined ? {} : { parent }).ctx
    if (announce) ctx.agents.register(agent)
    return agent
  }

  return {
    ctx,
    warnings,
    standingKey,
    otherKey,
    join,
    /** 加入**本组合**：会收到 `agent/created`。 */
    masked: (id) => join(id, standingKey),
    /** 加入本组合但**不**登记：只能靠守卫那条路拦住它。 */
    silent: (id) => join(id, standingKey, false),
    /** 加入另一个组合：门禁不该碰它。 */
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

// ── deny 模式 ───────────────────────────────────────────────────────────────

{
  const { ctx, standingKey, masked, control, silent: silentAgent, warnings } = await harness('deny')
  const target = masked('agent:masked')
  const sibling = control('agent:control')

  check('deny: the masked agent no longer sees write / edit', names(ctx, target) === 'edit_text,read,write_text', names(ctx, target))
  check('deny: an agent of another composition keeps them', names(ctx, sibling) === 'edit,edit_text,read,write,write_text', names(ctx, sibling))
  check(
    'deny: the preset scope still has them registered (visibility composition, not an authority boundary)',
    names(ctx, standingKey) === 'edit,edit_text,read,write,write_text',
    names(ctx, standingKey),
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

  // 建档事件之外的那条路：作用域父级上来了，但**没有**登记进注册表（于是没有 agent/created）。
  // 守卫必须在第一次调用时拦住它，并顺手收窄，让下一次请求的工具表就干净了。
  const silent = silentAgent('agent:silent')
  check('deny: an unannounced agent starts out seeing the natives', names(ctx, silent) === 'edit,edit_text,read,write,write_text', names(ctx, silent))
  const blocked = await ctx.tools.execute(call(silent, 'edit', 'guarded-edit'))
  check(
    'deny: the apply-time guard blocks the first native call even without any creation event',
    blocked.isError === true && /edit_text/.test(JSON.stringify(blocked)),
    JSON.stringify(blocked).slice(0, 200),
  )
  check(
    'deny: that blocked call narrowed the agent right away',
    names(ctx, silent) === 'edit_text,read,write_text',
    names(ctx, silent),
  )
  check('deny: the mask row logged no failure', warnings.length === 0, JSON.stringify(warnings).slice(0, 200))
}

// ── guard 模式 ──────────────────────────────────────────────────────────────

{
  const { ctx, masked } = await harness('guard')
  const watched = masked('agent:watched')

  check('guard: the tools stay visible', names(ctx, watched) === 'edit,edit_text,read,write,write_text', names(ctx, watched))
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

// ── escape：看不见原生名，但能用 native_* 调到同一个执行体 ─────────────────────

{
  const { ctx, masked, control, warnings } = await harness('deny', { escape: true })
  const target = masked('agent:escape')
  const sibling = control('agent:escape-control')
  if (warnings.length > 0) console.log(`      mask warnings: ${JSON.stringify(warnings)}`)

  check('escape: the native names are gone from the catalog', names(ctx, target) === 'edit_text,native_edit,native_write,read,write_text', names(ctx, target))
  const direct = await ctx.tools.execute(call(target, 'edit', 'esc-direct'))
  check('escape: the direct native name is still UNKNOWN_TOOL', direct.error?.info?.code === 'UNKNOWN_TOOL', JSON.stringify(direct).slice(0, 140))
  const viaEscape = await ctx.tools.execute(call(target, 'native_edit', 'esc-via'))
  check('escape: the escape name runs the native body', viaEscape.isError !== true && /edit ran/.test(JSON.stringify(viaEscape)), JSON.stringify(viaEscape).slice(0, 140))
  check(
    'escape: the escape parameters are the native ones',
    JSON.stringify(ctx.tools.get('native_edit', target).parameters) === JSON.stringify(ctx.tools.get('edit', sibling).parameters),
  )
  // 逃生口**不进提示词**：描述只陈述事实（跑的是哪个原生工具、它的代价），不带任何"何时该用"的指令——
  // 用不用由调用方在对话里点名，不该由提示词让模型自己去权衡。
  const escapeDescription = ctx.tools.get('native_edit', target).description
  check(
    'escape: the description states facts and gives no usage policy',
    !/\bonly\b|\bshould\b|\bprefer\b|instead|unless|explicitly/i.test(escapeDescription),
    escapeDescription,
  )
  check('escape: another composition keeps the plain native names', names(ctx, sibling) === 'edit,edit_text,read,write,write_text', names(ctx, sibling))
}

// ── scope: 'global'：工具在**全局层**，门禁从宿主上下文挂 ───────────────────────

{
  // 全局形状：原生工具由宿主平面提供（等价于 profile 层的 tool-fs 行），没有任何 preset 参与。
  // 这才是 `scope: 'global'` 要覆盖的场景——preset 里的 agent 与没有 preset 的 agent 都看得见它们。
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const warnings = []
  await ctx.plugin({
    name: 'fake-global-tool-fs',
    inject: ['tools', 'systemPrompt'],
    apply(c) {
      for (const name of ['read', 'write', 'edit']) c.tools.register(tool(name))
      c.tools.register(tool('edit_text'))
      c.tools.register(tool('write_text'))
    },
  })
  await ctx.plugin({
    name: 'fake-global-mask-row',
    inject: ['tools', 'systemPrompt'],
    apply(c) {
      const original = c.logger?.warn?.bind(c.logger)
      if (original !== undefined) c.logger.warn = (message) => { warnings.push(String(message)); original(message) }
      applyMask(c, { mode: 'guard', scope: 'global' })
    },
  })
  const plain = { id: 'agent:plain', session: { id: 'agent:plain' }, ctx }
  ctx.agents.register(plain)
  if (warnings.length > 0) console.log(`      mask warnings: ${JSON.stringify(warnings)}`)
  check('global: every agent still sees the natives (guard keeps them visible)', names(ctx, plain) === 'edit,edit_text,read,write,write_text', names(ctx, plain))
  const denied = await ctx.tools.execute(call(plain, 'edit', 'global-edit'))
  check(
    'global: the call is refused with the reason pointing at our tools',
    denied.isError === true && /edit_text/.test(JSON.stringify(denied)),
    JSON.stringify(denied).slice(0, 140),
  )
  const ours = await ctx.tools.execute(call(plain, 'edit_text', 'global-ours'))
  check('global: our own tools are untouched', ours.isError !== true, JSON.stringify(ours).slice(0, 120))
}

console.log('')
console.log(`${checks - failures}/${checks} checks passed  (dsh packages: ${root})`)
process.exitCode = failures === 0 ? 0 : 1
