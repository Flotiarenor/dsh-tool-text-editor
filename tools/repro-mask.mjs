// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * repro-mask.mjs —— 用**真实的** `dsh-agent-presets` 驱动门禁（`lib/mask.mjs`），验证两条组合路径。
 *
 * 为什么不能只靠 `probe-mask.mjs`：那个探针手工把 `agent/created` 递给监听器，验的是"监听器被调用之后
 * 注册表语义对不对"，从来没有验过**这个事件会不会被投递**。GUI 真实流程不是"preset 挂好之后再建 agent"，
 * 而是"先按默认 preset 建 agent，再把用户选的 preset 重新挂上去"（`AgentPresets.recompose()`）——
 * 重挂是父级 re-link，不是重建 agent，`agent/created` 早就在错误的组合下发完了。所以这里：
 *
 *   * 真栈：真 `Loader` + 真 `AgentPresets` + 真 `AgentRegistry`（`ctx.agents`），preset 是临时目录里
 *     真实的 `agent.cordis.yml`，行是真实的模块文件（本仓库的 `lib/mask.mjs` 按绝对路径入列）；
 *   * 两条路径都断言"收窄后的工具表"，而不是断言事件有没有到；
 *   * 顺带断言"未加入本 preset 的兄弟 agent 照旧看得见原生工具"（门禁是组合事实，不是全局开关）。
 *
 * 需要一份装有 `@deepseek-ai/cordis` / `dsh-tools` / `dsh-scope` / `dsh-system-prompt` / `dsh-agent` /
 * `dsh-agent-presets` / `dsh-session-projection` / `cordis-plugin-loader` 的 dsh：入口按常见布局去找
 * （`DSH_PACKAGES_ROOT` 可显式指定）。找不到时退出码 2（"这次没跑成"）。
 *
 * 用法：
 *   node tools/repro-mask.mjs
 *   $env:DSH_PACKAGES_ROOT = '<dsh profile>/node_modules/@deepseek-ai'; node tools/repro-mask.mjs
 * 退出码：0 全过，1 有失败，2 找不到 dsh 包。
 */

import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
/** 本次跑出来的临时 preset 根目录：正常路径由 `dispose()` 删，任何一步抛出时由退出钩子兜底。 */
const temporary = new Set()
process.on('exit', () => {
  for (const dir of temporary) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 退出阶段的清理失败不该掩盖真正的失败原因。
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

/**
 * 找一份 dsh 的 `@deepseek-ai` 包目录（与 `tools/probe-mask.mjs` 同一套布局枚举）。
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

const entry = (pkg, file = 'lib/index.js') => pathToFileURL(join(root, pkg, file)).href
const { Context } = await import(entry('cordis'))
const { Loader } = await import(entry('cordis-plugin-loader'))
const { SystemPrompt } = await import(entry('dsh-system-prompt'))
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

/**
 * 合成"原生 tool-fs"行：注册 `read` / `write` / `edit`，并按 0.1.5-rc.2 的形状把引导段写成
 * **按可见性求值**的函数（`dsh-tool-fs` 就是这么写的）——这样"引导是否还在"就是可见性的函数，
 * 不需要门禁去注册空段遮蔽。
 */
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

/**
 * 搭一套"宿主平面 + 两个 preset"的真栈。
 * @param options - `maskRow` 为门禁行的行配置（`undefined` 表示不加这一行）。
 * @returns 驱动用的句柄集合。
 */
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
  // `masked` 就是真实组合的形状：原生工具行 + 本插件的编辑行 + 门禁行（按绝对路径入列，跑的是仓库里的真文件）。
  const editorRow = `- name: ${join(REPO, 'lib', 'editor.mjs')}\n`
  await writeFile(join(presetsRoot, 'plain', 'agent.cordis.yml'), '- name: ./native-tools.mjs\n')
  await writeFile(join(presetsRoot, 'native', 'agent.cordis.yml'), '- name: ./native-tools.mjs\n')
  await writeFile(
    join(presetsRoot, 'masked', 'agent.cordis.yml'),
    '- name: ./native-tools.mjs\n' + editorRow + row(maskRow),
  )

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(join(dir, 'harness') + '\\').href
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
      const original = c.logger?.warn?.bind(c.logger)
      if (original !== undefined) c.logger.warn = (...args) => { warnings.push(args.join(' ')); original(...args) }
    },
  })

  /**
   * 造一个 agent 并把它登记进真注册表（`announce()` 会发 `agent/created`，作用域按 agent 作用域过滤）。
   * 作用域上下文从声明了 `tools` / `systemPrompt` 的上下文里铸出来——真实系统里这一步由 agent 工厂做，
   * 少了它会得到 "cannot get property tools without inject"。
   * @param id - agent 与 session 共用的 id。
   * @param preset - 建档时加入的 preset，`undefined` 表示先不加入任何 preset（GUI 里"先建后换"的形态）。
   * @returns 已登记的 agent。
   */
  const spawn = async (id, preset) => {
    const agent = { id, session: { id } }
    agent.ctx = createScope(host, agent).ctx
    if (preset !== undefined) await ctx.agentPresets.mount(agent.ctx, preset)
    ctx.agents.register(agent)
    return agent
  }

  /**
   * 造一个**子 agent**：它不挂载 preset，而是加入父 agent 已经在跑的那个常驻组合（`composeFrom()`，
   * 与 `dsh-tool-subagent` 的 spawn/fork 同一条路）。
   * @param id - 子 agent 与 session 共用的 id。
   * @param parent - 父 agent（必须已经加入某个 preset）。
   * @returns 已登记的子 agent。
   */
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
    text: async (agent) => {
      const { renderPrompt } = await import(entry('dsh-system-prompt'))
      return renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }))
    },
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

const NATIVES = 'edit,read,write'
const MASKED = 'edit_text,read,write_text'

// ── 路径一：建档时就加入门禁 preset（这条今天就是通的） ──────────────────────────

{
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:create', 'masked')
  check('create: the agent joined the masked preset', (await h.ctx.agentPresets.composedPreset(agent.ctx)) === 'masked')
  check('create: the native tools are gone from the catalog', h.names(agent) === MASKED, h.names(agent))
  const refusal = await h.call(agent, 'edit')
  check(
    'create: calling the native by name does not run it',
    refusal.isError === true,
    JSON.stringify(refusal).slice(0, 160),
  )
  await h.dispose()
}

// ── 路径二：先建后换（`recompose()`）—— 这正是 GUI 走的路，也是本工具的立身之本 ────────

{
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:swap', 'plain')
  check('swap: before the switch the agent sees the natives', h.names(agent) === 'edit,read,write', h.names(agent))
  const watched = h.names(agent)

  await h.ctx.agentPresets.recompose(agent.ctx, 'masked')

  check(
    'swap: the switch really recomposed the agent',
    (await h.ctx.agentPresets.composedPreset(agent.ctx)) === 'masked',
    String(await h.ctx.agentPresets.composedPreset(agent.ctx)),
  )
  check(
    'swap: the native tools are gone from the catalog after the switch',
    h.names(agent) === MASKED,
    `${watched} -> ${h.names(agent)}`,
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

// ── 路径三：建档时**没有** preset，第一次换才绑定（重挂而不是 rebind） ──────────────

{
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:fresh', undefined)
  check('fresh: an agent with no preset sees only the global layer', h.names(agent) === '', h.names(agent))
  await h.ctx.agentPresets.recompose(agent.ctx, 'masked')
  check('fresh: the first switch narrows the catalog too', h.names(agent) === MASKED, h.names(agent))
  const refusal = await h.call(agent, 'edit')
  check('fresh: the native does not run', refusal.isError === true, JSON.stringify(refusal).slice(0, 160))
  await h.dispose()
}

// ── 路径四：反方向换出去——门禁必须把自己注册的东西撤掉 ─────────────────────────

{
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:leave', 'masked')
  check('leave: the agent starts narrow', h.names(agent) === MASKED, h.names(agent))
  await h.ctx.agentPresets.recompose(agent.ctx, 'native')
  // 收窄注册在 **agent 自己的层**上，不随 preset 更换自动消失。不撤销的话，这个 agent 在原生组合里
  // 既看不见原生名字、也看不见本插件的名字——等于一个写工具都没有。
  check(
    'leave: switching back to a native preset brings the natives back',
    h.names(agent) === 'edit,read,write',
    h.names(agent),
  )
  const ran = await h.call(agent, 'edit')
  check('leave: and the native runs again', ran.isError !== true, JSON.stringify(ran).slice(0, 160))
  await h.dispose()
}

// ── 路径五：子 agent（`composeFrom()` 加入父组合，不自己 mount） ────────────────

{
  const h = await harness({ mode: 'deny' })
  const parent = await h.spawn('agent:parent', 'masked')
  const child = h.spawnChild('agent:child', parent)
  check('child: the child joined the same composition', (await h.ctx.agentPresets.composedPreset(child.ctx)) === 'masked')
  check('child: the child is masked like its parent', h.names(child) === MASKED, h.names(child))
  const refusal = await h.call(child, 'write')
  check('child: the native does not run for the child either', refusal.isError === true, JSON.stringify(refusal).slice(0, 160))
  await h.dispose()
}

// ── 路径六：宿主里还有**别人的守卫**时，归属判据不能被蒙对 ───────────────────────

{
  // `dsh-subagent-in-process-driver` 就是这样的宿主插件：它给子 agent 自己的层挂一个守卫，
  // 对**任何** exec 都回一句理由（它只看自己的结构化输出状态，完全不看 `exec.name`）。
  // 本行的归属探测必须只认自己的哨兵——`guardReason()` 先走全局层，再按 `chainLayers()` 从最远的
  // 祖先层开始走，本行挂在常驻层上，因此先被问到、先答哨兵。
  const h = await harness({ mode: 'deny' })
  const agent = await h.spawn('agent:foreign-guard', 'plain')
  agent.ctx.tools.guard(() => 'foreign guard: no tool may run')
  await h.ctx.agentPresets.recompose(agent.ctx, 'masked')
  check(
    'foreign guard: a foreign guard answering every call does not confuse the membership probe',
    h.names(agent) === MASKED,
    h.names(agent),
  )
  await h.dispose()
}

// ── 对照组：另一个 preset 的 agent 不受影响（门禁是组合事实，不是全局开关） ──────────

{
  const h = await harness({ mode: 'deny' })
  const ours = await h.spawn('agent:ours', 'masked')
  const control = await h.spawn('agent:control', 'native')
  check('control: the masked preset narrows its own agent', h.names(ours) === MASKED, h.names(ours))
  check('control: a sibling preset keeps the natives', h.names(control) === 'edit,read,write', h.names(control))
  const ran = await h.call(control, 'edit')
  check('control: the sibling can still run the native', ran.isError !== true, JSON.stringify(ran).slice(0, 160))
  await h.dispose()
}

console.log('')
console.log(`${checks - failures}/${checks} checks passed  (dsh packages: ${root})`)
process.exitCode = failures === 0 ? 0 : 1
