// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * probe-mask.mjs —— 用**真实的** dsh 包验证门禁（`lib/mask.mjs`）在注册表里的实际效果。
 *
 * 为什么单独有这么一个工具：self-test 里的门禁用假 ctx 钉住"本模块自己的行为"，而"被拒的名字到底
 * 是**看不见**还是**看不见也调不动**"由 dsh 的注册表决定——那件事只能在真实的 `dsh-tools` 上验证。
 * 这里复刻 `dsh-agent-presets` 的挂载形状（preset 常驻作用域 + agent 作用域父级到它），把合成的
 * `read`/`write`/`edit` 与它们的引导段注册进常驻层，再用假 `agent/created` 事件驱动门禁，然后断言：
 *
 *   * 受限 agent 的工具表里没有 write / edit；
 *   * 受限 agent 直呼 `edit` / `write` 得到 UNKNOWN_TOOL（**不是**"藏起来但还能调"）；
 *   * 未受限的兄弟 agent 照旧看得见、也调得动（这就是"屏蔽之后还能测吗"的答案：换一个 agent 即可）；
 *   * 受限 agent 的系统提示词里没有原生那两段引导，而未受限的那位有；
 *   * 常驻作用域自己看：工具**仍然注册在注册表里**——门禁是可见性组合，不是权限边界；
 *   * `mode: 'guard'` 下工具保持可见、调用被否决，且原因里点名 `edit_text` / `write_text`。
 *
 * 需要一份装有 `@deepseek-ai/dsh-tools` / `dsh-scope` / `dsh-system-prompt` / `cordis` 的 dsh：
 * 入口按常见布局去找（`DSH_PACKAGES_ROOT` 可显式指定）。找不到时退出码 2（"这次没跑成"）。
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

const PACKAGES = ['cordis', 'dsh-tools', 'dsh-scope', 'dsh-system-prompt']

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
  console.error('SKIP 找不到齐备的 dsh 包（需要 cordis / dsh-tools / dsh-scope / dsh-system-prompt）')
  console.error('     用 DSH_PACKAGES_ROOT 指向含这些包的 @deepseek-ai 目录后重跑。')
  process.exit(2)
}

const entry = (pkg) => pathToFileURL(join(root, pkg, 'lib', 'index.js')).href
const { Context } = await import(entry('cordis'))
const { ToolRuntime } = await import(entry('dsh-tools'))
const { SystemPrompt, renderPrompt } = await import(entry('dsh-system-prompt'))
const { createScope } = await import(entry('dsh-scope'))

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

/**
 * 搭一套与 dsh 挂载形状一致的环境。
 * @param mode - 门禁模式（`deny` / `guard`）。
 * @returns 上下文、注册表、作用域键与"已创建的 agent"。
 */
async function harness(mode) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  let host
  await ctx.plugin({ name: 'host', inject: ['tools', 'systemPrompt'], apply(c) { host = c } })

  const standingKey = { kind: 'standing', id: 'preset:texteditor' }
  const standing = createScope(host, standingKey)
  // 常驻层：等价于 preset 里的 tool-fs 行 + 我们的编辑工具行。
  await standing.ctx.plugin({
    name: 'fake-tool-fs',
    inject: ['tools', 'systemPrompt'],
    apply(c) {
      for (const name of ['read', 'write', 'edit']) c.tools.register(tool(name))
      for (const name of ['edit_text', 'write_text']) c.tools.register(tool(name))
      c.systemPrompt.section({ name: 'tool:read', order: 100, text: 'Use the read tool for files.' })
      c.systemPrompt.section({ name: 'tool:write', order: 101, text: 'Use the write tool to create files.' })
      c.systemPrompt.section({ name: 'tool:edit', order: 102, text: 'Use the edit tool for targeted changes.' })
    },
  })

  // 门禁行注册在常驻作用域上；它的监听器由 agent/created 驱动。
  const listeners = []
  applyMask({ on: (event, listener) => listeners.push([event, listener]), logger: { warn: () => {} } }, { mode })

  /** 一个加入本 preset 的 agent：作用域键就是 agent 本身（与 dsh 一致），并带上自己的作用域上下文。 */
  const join = (id) => {
    const agent = { id, kind: 'agent' }
    const scope = createScope(host, agent, { parent: standingKey })
    agent.ctx = scope.ctx
    return agent
  }
  const created = (agent) => listeners.forEach(([event, listener]) => {
    if (event === 'agent/created') listener({ agent })
  })

  return { ctx, host, standingKey, join, created }
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
  const { ctx, standingKey, join, created } = await harness('deny')
  const masked = join('agent:masked')
  const control = join('agent:control')

  check('deny: before the event the agent sees the natives', names(ctx, masked) === 'edit,edit_text,read,write,write_text', names(ctx, masked))
  created(masked)

  check('deny: the masked agent no longer sees write / edit', names(ctx, masked) === 'edit_text,read,write_text', names(ctx, masked))
  check('deny: a sibling agent never passed to the listener keeps them', names(ctx, control) === 'edit,edit_text,read,write,write_text', names(ctx, control))
  check('deny: the preset scope still has them registered (not an authority boundary)', names(ctx, standingKey) === 'edit,edit_text,read,write,write_text', names(ctx, standingKey))

  const denied = await ctx.tools.execute(call(masked, 'edit', 'deny-edit'))
  check(
    'deny: calling edit by name is UNKNOWN_TOOL, not a hidden back door',
    denied.isError === true && denied.error?.info?.code === 'UNKNOWN_TOOL',
    JSON.stringify(denied.error ?? denied).slice(0, 160),
  )
  const allowed = await ctx.tools.execute(call(control, 'edit', 'control-edit'))
  check('deny: the control agent still executes edit (testing stays possible)', allowed.isError !== true, JSON.stringify(allowed).slice(0, 160))

  const maskedText = await textOf(ctx, masked)
  const controlText = await textOf(ctx, control)
  check(
    'deny: the native guidance is gone for the masked agent, kept for the control',
    !/write tool|edit tool/.test(maskedText) && /write tool/.test(controlText) && /edit tool/.test(controlText),
    JSON.stringify([maskedText, controlText]),
  )
  check('deny: the read guidance survives on both', /read tool/.test(maskedText) && /read tool/.test(controlText))
}

// ── guard 模式 ──────────────────────────────────────────────────────────────

{
  const { ctx, join, created } = await harness('guard')
  const watched = join('agent:watched')
  created(watched)

  check('guard: the tools stay visible', names(ctx, watched) === 'edit,edit_text,read,write,write_text', names(ctx, watched))
  const refused = await ctx.tools.execute(call(watched, 'edit', 'guard-edit'))
  const body = JSON.stringify(refused)
  check(
    'guard: the call is refused with a reason that points at our tools',
    refused.isError === true && /edit_text/.test(body) && /write_text/.test(body),
    body.slice(0, 200),
  )
  const ok = await ctx.tools.execute(call(watched, 'edit_text', 'guard-ours'))
  check('guard: our own tool is unaffected', ok.isError !== true, JSON.stringify(ok).slice(0, 120))
}

console.log('')
console.log(`${checks - failures}/${checks} checks passed  (dsh packages: ${root})`)
process.exitCode = failures === 0 ? 0 : 1
