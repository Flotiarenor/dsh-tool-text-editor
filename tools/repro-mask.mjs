// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * repro-mask.mjs —— 用真实 `dsh-agent-presets` 驱动门禁（`lib/mask.mjs`），验证组合时序。
 *
 * 与 `probe-mask.mjs` 的分工：那个探针自己搭常驻作用域，够不到 `recompose()` 的父级 re-link。GUI 的真实
 * 流程是"先按默认 preset 建 agent，再换成用户选的 preset"；re-link 不是重建 agent，`agent/created` 早就在
 * 旧组合下发完了——只认建档事件的实现整整一轮没生效。
 *
 * 真栈，不 mock：真 `Loader` / `AgentPresets` / `AgentRegistry`，preset 与行都是临时目录里的真文件
 * （`lib/mask.mjs` 按绝对路径入列）；各条路径断言收窄后的工具表而不是事件投递。
 *
 * 需要装有 `@deepseek-ai/cordis` / `dsh-tools` / `dsh-scope` / `dsh-system-prompt` / `dsh-agent` /
 * `dsh-agent-presets` / `dsh-session-projection` / `cordis-plugin-loader` 的 dsh：入口按常见布局枚举，
 * `DSH_PACKAGES_ROOT` 可显式指定。用法 `node tools/repro-mask.mjs`；退出码 0 全过 / 1 有失败 / 2 找不到包。
 */

import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
/** 临时 preset 根目录：正常路径由 `dispose()` 删，抛错时由退出钩子兜底。 */
const temporary = new Set()
process.on('exit', () => {
  for (const dir of temporary) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不该掩盖真正的失败原因。
    }
  }
})

const PACKAGES = [
  'cordis',
  'cordis-plugin-loader',
  'dsh-agent',
  'dsh-agent-presets',
  'dsh-session-projection',
  'dsh-scope',
  'dsh-system-prompt',
  'dsh-tools',
]

/** 找一份 dsh 的 `@deepseek-ai` 包目录（枚举同 `probe-mask.mjs`）。 */
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
const { Loader } = await import(entry('cordis-plugin-loader'))
const { SystemPrompt, renderPrompt } = await import(entry('dsh-system-prompt'))
const { ToolRuntime } = await import(entry('dsh-tools'))
const { SessionProjectionRegistry } = await import(entry('dsh-session-projection'))
const { AgentRegistry } = await import(entry('dsh-agent'))
const { AgentPresets } = await import(entry('dsh-agent-presets'))
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

/** 把 `warn` 收进 `sink`，供断言检查。 */
function captureWarnings(ctx, sink) {
  const warn = ctx.logger?.warn?.bind(ctx.logger)
  if (warn === undefined) return
  ctx.logger.warn = (...args) => {
    sink.push(args.join(' '))
    warn(...args)
  }
}

/** 合成"原生 tool-fs"行：`read` / `write` / `edit` + 按 `dsh-tool-fs` 形状写成按可见性求值的引导段。 */
const NATIVE_ROW = `export const inject = ['tools', 'systemPrompt']
const tool = (name) => ({
  name,
  description: name + ' tool',
  parameters: { type: 'object', properties: {} },
  output: {
    schema: { type: 'object', properties: { ran: { type: 'string' } }, required: ['ran'], additionalProperties: false },
    render: () => [{ type: 'text', text: name + ' ran' }],
  },
  execute: async () => ({ ran: name }),
})
export function apply(ctx) {
  for (const name of ['read', 'write', 'edit']) ctx.tools.register(tool(name))
  ctx.systemPrompt.section({ name: 'tool:read', order: 100, text: 'Use the read tool for files.' })
  ctx.systemPrompt.section({
    name: 'tool:write',
    order: 101,
    text: ({ scope }) => ctx.tools.get('write', scope) === undefined ? '' : 'Use the write tool to create files.',
  })
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: 102,
    text: ({ scope }) => ctx.tools.get('edit', scope) === undefined ? '' : 'Use the edit tool for targeted changes.',
  })
}
`

/** 搭一套"宿主平面 + 两个 preset"的真栈；`maskRow` 是门禁行的行配置，`undefined` 表示不加这一行。 */
async function harness(maskRow) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mask-repro-'))
  temporary.add(dir)
  const presetsRoot = join(dir, 'presets')
  const row = (config) => {
    const lines = [`- name: ${join(REPO, 'lib', 'mask.mjs')}`]
    if (config !== undefined) {
      lines.push('  config:')
      for (const [key, value] of Object.entries(config)) lines.push(`    ${key}: ${String(value)}`)
    }
    return lines.join('\n') + '\n'
  }
  for (const id of ['plain', 'native', 'masked']) {
    await mkdir(join(presetsRoot, id), { recursive: true })
    await writeFile(join(presetsRoot, id, 'native-tools.mjs'), NATIVE_ROW)
  }
  // `masked` 是真实组合的形状：原生工具行 + 编辑行 + 门禁行（后两行按绝对路径，跑真文件）。
  const editorRow = `- name: ${join(REPO, 'lib', 'editor.mjs')}\n`
  await writeFile(join(presetsRoot, 'plain', 'agent.cordis.yml'), '- name: ./native-tools.mjs\n')
  await writeFile(join(presetsRoot, 'native', 'agent.cordis.yml'), '- name: ./native-tools.mjs\n')
  await writeFile(
    join(presetsRoot, 'masked', 'agent.cordis.yml'),
    '- name: ./native-tools.mjs\n' + editorRow + row(maskRow),
  )

  const ctx = new Context()
  // `AgentPresets` 要求 `ctx.baseUrl`（解析组合里的包名行用）；这里指向一个不存在的 harness 目录。
  ctx.baseUrl = pathToFileURL(join(dir, 'harness') + '/').href
  const warnings = []
  await ctx.plugin(Loader, {})
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentPresets, {
    default: 'plain',
    roots: [{ path: presetsRoot, trust: 'user' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  let host
  await ctx.plugin({
    name: 'repro-host',
    inject: ['tools', 'systemPrompt'],
    apply(c) {
      host = c
      captureWarnings(c, warnings)
    },
  })

  /** 造一个 agent 并登记进真注册表（`agent/created` 按 agent 作用域过滤后派发）。作用域必须从声明了
   * `tools` / `systemPrompt` 的上下文铸出，否则报 "cannot get property tools without inject"。 */
  const spawn = async (id, preset) => {
    const agent = { id, session: { id } }
    agent.ctx = createScope(host, agent).ctx
    if (preset !== undefined) await ctx.agentPresets.mount(agent.ctx, preset)
    ctx.agents.register(agent)
    return agent
  }

  /** 造一个子 agent：不挂载 preset，只加入父 agent 跑的常驻组合（同 `dsh-tool-subagent`）。 */
  const spawnChild = (id, parent) => {
    const agent = { id, session: { id } }
    agent.ctx = createScope(host, agent).ctx
    ctx.agentPresets.composeFrom(agent.ctx, parent.ctx)
    ctx.agents.register(agent)
    return agent
  }

  return {
    ctx,
    warnings,
    spawn,
    spawnChild,
    names: (agent) => ctx.tools.schemas(agent).map((schema) => schema.name).sort().join(','),
    visible: (agent, name) => ctx.tools.get(name, agent) !== undefined,
    text: async (agent) => renderPrompt(await ctx.systemPrompt.assemble({ scope: agent })),
    call: async (agent, name) => ctx.tools.execute({
      callId: `repro-${agent.id}-${name}`,
      name,
      arguments: {},
      agent,
      signal: new AbortController().signal,
    }),
    dispose: async () => {
      temporary.delete(dir)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const MASKED = 'edit_text,read,write_text'

// ── 路径一：建档时加入 ──

{
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:create', 'masked')
  check('create: the agent joined the masked preset', (await h.ctx.agentPresets.composedPreset(agent.ctx)) === 'masked')
  const createNames = h.names(agent)
  check('create: the native tools are gone from the catalog', createNames === MASKED, createNames)
  const refusal = await h.call(agent, 'edit')
  check(
    'create: calling the native by name does not run it',
    refusal.isError === true,
    JSON.stringify(refusal).slice(0, 160),
  )
  await h.dispose()
}

// ── 路径二：先建后换 ──

{
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:swap', 'plain')
  const watched = h.names(agent)
  check('swap: before the switch the agent sees the natives', watched === 'edit,read,write', watched)

  await h.ctx.agentPresets.recompose(agent.ctx, 'masked')

  const composed = await h.ctx.agentPresets.composedPreset(agent.ctx)
  check('swap: the switch really recomposed the agent', composed === 'masked', String(composed))
  const swapped = h.names(agent)
  check(
    'swap: the native tools are gone from the catalog after the switch',
    swapped === MASKED,
    `${watched} -> ${swapped}`,
  )
  check('swap: the native tool is not visible to the agent', h.visible(agent, 'edit') === false)
  const refusal = await h.call(agent, 'edit')
  check(
    'swap: calling the native by name does not run it',
    refusal.isError === true,
    JSON.stringify(refusal).slice(0, 200),
  )
  const text = await h.text(agent)
  check(
    'swap: the native guidance is gone with the native tools',
    !/write tool|edit tool/.test(text) && /read tool/.test(text),
    JSON.stringify(text.slice(0, 160)),
  )
  check('swap: the mask row logged no failure', h.warnings.length === 0, JSON.stringify(h.warnings).slice(0, 200))
  await h.dispose()
}

// ── 路径三：首次绑定 ──

{
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:fresh', undefined)
  const bare = h.names(agent)
  check('fresh: an agent with no preset sees only the global layer', bare === '', bare)
  await h.ctx.agentPresets.recompose(agent.ctx, 'masked')
  const fresh = h.names(agent)
  check('fresh: the first switch narrows the catalog too', fresh === MASKED, fresh)
  const refusal = await h.call(agent, 'edit')
  check('fresh: the native does not run', refusal.isError === true, JSON.stringify(refusal).slice(0, 160))
  await h.dispose()
}

// ── 路径四：换出去 ──

{
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:leave', 'masked')
  const narrow = h.names(agent)
  check('leave: the agent starts narrow', narrow === MASKED, narrow)
  await h.ctx.agentPresets.recompose(agent.ctx, 'native')
  // 收窄注册在 agent 自己的层上，不随 preset 更换消失；不撤销的话它在原生组合里既没有原生名字、也没有
  // 本插件的名字，一个写工具都不剩。
  const left = h.names(agent)
  check(
    'leave: switching back to a native preset brings the natives back',
    left === 'edit,read,write',
    left,
  )
  const ran = await h.call(agent, 'edit')
  check('leave: and the native runs again', ran.isError !== true, JSON.stringify(ran).slice(0, 160))
  await h.dispose()
}

// ── 路径五：子 agent ──

{
  const h = await harness({ mode: 'deny' })
  const parent = await h.spawn('agent:parent', 'masked')
  const child = h.spawnChild('agent:child', parent)
  check('child: the child joined the same composition', (await h.ctx.agentPresets.composedPreset(child.ctx)) === 'masked')
  const childNames = h.names(child)
  check('child: the child is masked like its parent', childNames === MASKED, childNames)
  const refusal = await h.call(child, 'write')
  check('child: the native does not run for the child either', refusal.isError === true, JSON.stringify(refusal).slice(0, 160))
  await h.dispose()
}

// ── 路径六：别人的守卫 ──

{
  // `dsh-subagent-in-process-driver` 就这样：守卫挂在子 agent 自己的层上，对任何 exec 都回一句理由（只看
  // 自己的结构化输出状态，不看 `exec.name`）。探测因此只认自己的哨兵：`guardReason()` 先走全局层，再按
  // `chainLayers()` 从最远的祖先层走起，本行在常驻层上先被问到。
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:foreign-guard', 'plain')
  agent.ctx.tools.guard(() => 'foreign guard: no tool may run')
  await h.ctx.agentPresets.recompose(agent.ctx, 'masked')
  const foreign = h.names(agent)
  check(
    'foreign guard: a foreign guard answering every call does not confuse the membership probe',
    foreign === MASKED,
    foreign,
  )
  await h.dispose()
}

// ── 对照组：另一个 preset ──

{
  const h = await harness({ mode: 'deny' })
  const ours = await h.spawn('agent:ours', 'masked')
  const control = await h.spawn('agent:control', 'native')
  const oursNames = h.names(ours)
  check('control: the masked preset narrows its own agent', oursNames === MASKED, oursNames)
  const controlNames = h.names(control)
  check('control: a sibling preset keeps the natives', controlNames === 'edit,read,write', controlNames)
  const ran = await h.call(control, 'edit')
  check('control: the sibling can still run the native', ran.isError !== true, JSON.stringify(ran).slice(0, 160))
  await h.dispose()
}

console.log('')
console.log(`${checks - failures}/${checks} checks passed  (dsh packages: ${root})`)
process.exitCode = failures === 0 ? 0 : 1
