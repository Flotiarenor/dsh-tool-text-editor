// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * measure-context.mjs —— 测量两个工具进入模型上下文的字节数。
 *
 * 把 `lib/editor.mjs` 的 `apply()` 挂到模拟 ctx 上，走真实的 `execute()` → `output.render()` 路径（宿主即如此
 * 调用），逐场景输出：入参字节 | 模型可见字节 | 倍率 | 行数。契约是"模型可见文本与输入规模无关"，场景集因此
 * 覆盖大文件、单行压缩文件、宽数据行、超长单行替换与失败路径（未命中 / 目录目标）。
 *
 * 用法：node tools/measure-context.mjs [--cap N] [--static] [--vs-native]
 *   --cap N      任一场景的模型可见字节 > N 即退出码 1（`npm test` 用它守住 2 KB 预算）
 *   --static     只量静态开销（引导段 / 描述 / schema），不跑场景
 *   --vs-native  追加宿主自带 `write` / `edit` 的静态开销；找不到 dsh 时打印 SKIP，退出码不变
 * 退出码 2 = `--cap` 不是字节数。仅在临时目录作业；零依赖，只用 `node:` 内置模块。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply } from '../lib/editor.mjs'

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)
const flagValue = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const CAP = Number(flagValue('--cap', 'NaN'))
const bytes = (value) => Buffer.byteLength(value ?? '', 'utf8')

// 缺省 `--cap` 不设上限；值不是字节数必须报错，否则门禁静默失效。
if (hasFlag('--cap') && (!Number.isFinite(CAP) || CAP < 0)) {
  console.error(`FAIL --cap 需要一个非负字节数，收到 ${JSON.stringify(flagValue('--cap', ''))}`)
  process.exit(2)
}

/** 每次都用干净的注册表注册一遍工具。 */
function makeTools(config = {}) {
  const registered = []
  apply(
    { systemPrompt: { section: () => {} }, tools: { register: (tool) => registered.push(tool) } },
    config,
  )
  return new Map(registered.map((tool) => [tool.name, tool]))
}

async function probe(label, toolName, args) {
  const tool = makeTools().get(toolName)
  const value = await tool.execute(args, { agent: { session: { header: { cwd: args.__ws } } } })
  const rendered = tool.output.render(args, value)
  const visible = rendered.map((block) => block.text ?? '').join('')
  const visibleBytes = bytes(visible)
  const argBytes = bytes(JSON.stringify({ ...args, __ws: undefined }))
  return {
    label,
    tool: toolName,
    argBytes,
    visibleBytes,
    ratio: argBytes === 0 ? 0 : visibleBytes / argBytes,
    lines: visible === '' ? 0 : visible.split('\n').length,
    firstLine: visible.split('\n')[0].slice(0, 44).replace(/\s+/g, ' '),
  }
}

const long = (n) => 'x'.repeat(n)

/** 场景表：函数拿到工作区，返回探针入参。 */
const SCENARIOS = [
  ['write: 45 lines', 'write_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'big.txt'),
    content: Array.from({ length: 45 }, (_, i) => `row ${String(i + 1).padStart(3, '0')} | payload alpha-${String(i + 1).padStart(4, '0')} | filler`).join('\n') + '\n',
  })],
  ['write: 200-line rewrite', 'write_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'full.txt'),
    content: Array.from({ length: 200 }, (_, i) => `line ${i} ${'y'.repeat(60)}`).join('\n') + '\n',
  })],
  ['write: 12-line new file', 'write_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'small.txt'),
    content: Array.from({ length: 12 }, (_, i) => `key${i} = ${i}`).join('\n') + '\n',
  })],
  ['write: single 200 KB line (minified)', 'write_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'min.js'),
    content: 'const a=' + long(200_000) + ';\n',
  })],
  ['write: 20 lines x 5 KB = 100 KB', 'write_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'wide.txt'),
    content: Array.from({ length: 20 }, (_, i) => `L${i} ${long(4990)}`).join('\n') + '\n',
  })],
  ['write: 400 KB single line', 'write_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'huge.txt'),
    content: long(400_000) + '\n',
  })],
  ['edit: swap one 200 KB line', 'edit_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'min.js'),
    old_text: 'const a=' + long(200_000) + ';',
    new_text: 'const a=' + long(100_000) + ';',
  })],
  ['edit: one line in a normal file', 'edit_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'small.txt'),
    old_text: 'key3 = 3',
    new_text: 'key3 = 33',
  })],
  ['edit: miss with a 5 KB anchor', 'edit_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'wide.txt'),
    old_text: 'NOT PRESENT ' + long(5000),
    new_text: 'x',
  })],
  ['write: new file under a missing directory', 'write_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'made', 'up', 'deep.txt'),
    content: 'created under a fresh directory\n',
  })],
  ['edit: target is a directory', 'edit_text', (ws) => ({
    __ws: ws,
    file_path: join(ws, 'made'),
    old_text: 'created',
    new_text: 'x',
  })],
]

/** 每个请求都要带的静态开销（可前缀缓存，但仍占预算）；顺带量引导段三档（`full` / `short` / `off`）。 */
async function staticReport() {
  const registered = []
  const guidanceOf = (config) => {
    let text = ''
    apply(
      {
        systemPrompt: { section: (section) => { text = section.text } },
        tools: { register: (tool) => registered.push(tool) },
      },
      config,
    )
    return text
  }
  const guidance = guidanceOf({})
  let total = bytes(guidance)
  console.log('=== static overhead (sent with every request)')
  console.log(`  ${String(total).padStart(6)} B  system prompt section`)
  for (const tool of registered) {
    const description = bytes(tool.description)
    const schema = bytes(JSON.stringify(tool.parameters))
    total += description + schema
    console.log(`  ${String(description).padStart(6)} B  ${tool.name} description`)
    console.log(`  ${String(schema).padStart(6)} B  ${tool.name} parameter schema (${Object.keys(tool.parameters.properties).length} props)`)
  }
  console.log(`  ${String(total).padStart(6)} B  TOTAL (guidance: full)`)
  console.log('  --- guidance variants')
  registered.length = 0
  const short = guidanceOf({ guidance: 'short' })
  registered.length = 0
  const off = guidanceOf({ guidance: false })
  console.log(`  ${String(bytes(short)).padStart(6)} B  guidance: short   (${bytes(short) - bytes(guidance)} B)`)
  console.log(`  ${String(bytes(off)).padStart(6)} B  guidance: false   (${bytes(off) - bytes(guidance)} B)`)
  return total
}

/** 找一个宿主自带的 `dsh-tool-fs`：`DSH_TOOL_FS_ENTRY` → profile 的 `node_modules` → npm 全局前缀。 */
function findToolFs() {
  const candidates = []
  const add = (root, nested) => {
    if (typeof root !== 'string' || root === '') return
    candidates.push(join(root, '@deepseek-ai', 'dsh-tool-fs', 'lib', 'index.js'))
    if (nested) candidates.push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tool-fs', 'lib', 'index.js'))
  }
  const explicit = process.env.DSH_TOOL_FS_ENTRY
  if (typeof explicit === 'string' && explicit !== '') candidates.push(explicit)
  add(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules'), false)
  const globalRoots = process.platform === 'win32'
    ? [process.env.APPDATA === undefined ? '' : join(process.env.APPDATA, 'npm', 'node_modules')]
    : ['/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.npm-global', 'lib', 'node_modules')]
  for (const root of globalRoots) add(root, true)
  return candidates.find((candidate) => existsSync(candidate))
}

/** `applyReadTool` 注册时会问 `getSectionOrder('TOOL_READ')`，缺了直接抛；数值只影响打印的 `order=`。 */
const SECTION_ORDERS = {
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
}

/** 0.1.5-rc.2 起原生引导段的 `text` 是 `({ scope }) => …` 函数，直接量 `section.text` 量到的是函数源码。 */
function sectionText(section, scope) {
  return typeof section.text === 'function' ? section.text({ scope }) : section.text
}

/** 原生 `write` / `edit` 的静态开销（升权字段按"有沙箱"计）。 */
async function nativeReport() {
  const entry = findToolFs()
  if (entry === undefined) {
    console.log('SKIP 找不到 @deepseek-ai/dsh-tool-fs（用 DSH_TOOL_FS_ENTRY 指定入口后重跑）')
    return
  }
  const mod = await import(pathToFileURL(entry).href)
  const registered = []
  const sections = []
  const scope = { kind: 'scope' }
  const sandboxCtx = {
    // 壳上下文要提供 `section` / `getSectionOrder`（缺后者 `applyReadTool` 抛错），以及一个"原生工具可见"的
    // `tools.get`，否则按可见性求值的引导段渲染为空。
    tools: {
      register: (tool) => registered.push(tool),
      get: (name) => (name === 'read' || name === 'write' || name === 'edit' ? { name } : undefined),
    },
    systemPrompt: {
      section: (section) => sections.push(section),
      getSectionOrder: (name) => SECTION_ORDERS[name],
    },
    fs: { sandboxMode: 'workspace-write' },
    emit() {},
    provide() {},
    inject() {},
    get: () => ({}),
    scope,
    effect: () => {},
  }
  ;(mod.default ?? mod).apply(sandboxCtx, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 262144, readStreamMinSize: 4096 })
  console.log(`\n=== native tools from dsh-tool-fs (${entry})`)
  let schemaTotal = 0
  for (const tool of registered.filter((tool) => tool.name === 'write' || tool.name === 'edit')) {
    const description = bytes(tool.description)
    const schema = bytes(JSON.stringify(tool.parameters))
    schemaTotal += description + schema
    console.log(`  ${tool.name.padEnd(8)} desc=${String(description).padStart(4)} B  params=${String(schema).padStart(4)} B`)
  }
  console.log(`  native write + edit schemas : ${schemaTotal} B`)
  let sectionTotal = 0
  for (const section of sections.filter((section) => section.name === 'tool:write' || section.name === 'tool:edit')) {
    const text = sectionText(section, scope)
    sectionTotal += bytes(text)
    console.log(`  ${section.name.padEnd(8)} order=${String(section.order).padStart(4)}  ${String(bytes(text)).padStart(4)} B  guidance section`)
  }
  console.log(`  native write + edit sections: ${sectionTotal} B`)
  console.log(`  => masking both (lib/mask.mjs) removes ${schemaTotal + sectionTotal} B per request`)
}

// ── 跑起来 ──

if (hasFlag('--static') || hasFlag('--vs-native')) {
  await staticReport()
  if (hasFlag('--vs-native')) await nativeReport()
  process.exit(0)
}

const ws = mkdtempSync(join(tmpdir(), 'dsh-measure-context-'))
const rows = []
try {
  for (const [label, toolName, build] of SCENARIOS) {
    rows.push(await probe(label, toolName, build(ws)))
  }

  console.log('scenario                                   tool        args   visible   ratio  lines  result')
  for (const row of rows) {
    console.log(
      row.label.padEnd(41) + '  ' + row.tool.padEnd(10)
      + String(row.argBytes).padStart(7) + ' ' + String(row.visibleBytes).padStart(8)
      + '  ' + row.ratio.toFixed(3).padStart(5) + 'x' + String(row.lines).padStart(6) + '  ' + row.firstLine,
    )
  }

  const worst = rows.reduce((a, b) => (b.visibleBytes > a.visibleBytes ? b : a))
  const totalVisible = rows.reduce((sum, row) => sum + row.visibleBytes, 0)
  const totalArgs = rows.reduce((sum, row) => sum + row.argBytes, 0)
  console.log('')
  console.log(`worst single result : ${worst.visibleBytes} B  (${worst.label})`)
  console.log(`totals              : args ${totalArgs} B -> model-visible ${totalVisible} B  (${(totalVisible / totalArgs).toFixed(3)}x)`)
  console.log(`workspace           : ${ws}`)
} finally {
  // 场景抛错也要删掉工作区。
  rmSync(ws, { recursive: true, force: true })
}

if (Number.isFinite(CAP)) {
  const over = rows.filter((row) => row.visibleBytes > CAP)
  if (over.length > 0) {
    console.log('')
    for (const row of over) console.log(`OVER CAP ${row.visibleBytes} B > ${CAP} B  ${row.label}`)
    process.exitCode = 1
  } else {
    console.log(`\nOK — every scenario stays within ${CAP} B of model-visible text`)
  }
}
