// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * measure-context.mjs —— 测量两个工具进入模型上下文的字节数。
 *
 * 工具结果按追加方式进入会话历史，单次调用返回的字节数是本插件的核心指标。本脚本把
 * `lib/editor.mjs` 的 `apply()` 挂到模拟 ctx 上，走真实的 `execute()` → `output.render()` 路径
 * （宿主即如此调用），逐场景输出：
 *
 *   入参字节 | 模型可见字节 | 倍率 | 行数
 *
 * 契约是"模型可见文本与输入规模无关"：成功路径固定为 `WROTE` 加一行统计，因此场景集特意
 * 覆盖大文件、压缩为单行的大文件、宽数据行、超长单行的替换，以及失败路径（歧义 / 目录目标 /
 * 补齐父目录）。
 *
 * 仅在临时目录中作业，不修改仓库文件。零依赖，只用 `node:` 内置模块。
 *
 * 用法：
 *   node tools/measure-context.mjs                 # 打印矩阵
 *   node tools/measure-context.mjs --cap 2048      # 任一场景模型可见字节 > 上限 → 退出码 1
 *   node tools/measure-context.mjs --static        # 只量静态开销（描述 / schema / 引导段）
 *   node tools/measure-context.mjs --vs-native     # 追加宿主自带 write / edit 的同一组数据
 *
 * `--vs-native` 需要一个装有 `@deepseek-ai/dsh-tool-fs` 的 dsh：入口按常见布局去找，也可以用
 * `DSH_TOOL_FS_ENTRY` 显式指定；找不到时打印 SKIP，退出码不变（不是失败，只是没跑成）。
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

/** 注册一遍工具（每次都用干净的注册表，避免配置串味）。 */
function makeTools(config = {}) {
  const registered = []
  apply(
    { systemPrompt: { section: () => {} }, tools: { register: (tool) => registered.push(tool) } },
    config,
  )
  return new Map(registered.map((tool) => [tool.name, tool]))
}

/** 一个场景：跑一次工具，量出入参与模型可见文本。 */
async function probe(label, toolName, args, config) {
  const tools = makeTools(config)
  const tool = tools.get(toolName)
  const value = await tool.execute(args, { agent: { session: { header: { cwd: args.__ws } } } })
  const rendered = tool.output.render(args, value)
  const visible = rendered.map((block) => block.text ?? '').join('')
  const argBytes = bytes(JSON.stringify({ ...args, __ws: undefined }))
  return {
    label,
    tool: toolName,
    ok: value.ok,
    argBytes,
    visibleBytes: bytes(visible),
    ratio: argBytes === 0 ? 0 : bytes(visible) / argBytes,
    lines: visible === '' ? 0 : visible.split('\n').length,
    firstLine: visible.split('\n')[0].slice(0, 44).replace(/\s+/g, ' '),
  }
}

const long = (n) => 'x'.repeat(n)

/** 场景表：每个函数拿到工作区，返回探针入参。 */
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

/**
 * 静态开销：请求里每次都带的那部分（可前缀缓存，但仍占预算）。
 *
 * 顺带量出引导段三档的字节数：`full`（默认，含"优先于原生"）、`short`（原生已被门禁屏蔽时用）、
 * `off`（不注册）。
 */
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
  let total = 0
  console.log('=== static overhead (sent with every request)')
  for (const [label, text] of [['system prompt section', guidance]]) {
    total += bytes(text)
    console.log(`  ${String(bytes(text)).padStart(6)} B  ${label}`)
  }
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

/**
 * 查找宿主自带的 `dsh-tool-fs`，用于对照原生 `write` / `edit` 的静态开销。
 * 顺序：`DSH_TOOL_FS_ENTRY` → dsh profile 的 node_modules → npm 全局前缀。
 */
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

/** 原生 write / edit 的静态开销（沙箱升权字段随组合出现，这里按"有沙箱"计）。 */
async function nativeReport() {
  const entry = findToolFs()
  if (entry === undefined) {
    console.log('SKIP 找不到 @deepseek-ai/dsh-tool-fs（用 DSH_TOOL_FS_ENTRY 指定入口后重跑）')
    return
  }
  const mod = await import(pathToFileURL(entry).href)
  const registered = []
  const sections = []
  const sandboxCtx = {
    tools: { register: (tool) => registered.push(tool) },
    systemPrompt: { section: (section) => sections.push(section) },
    fs: { sandboxMode: 'workspace-write' },
    emit() {},
    provide() {},
    inject() {},
    get: () => ({}),
    scope: {},
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
    sectionTotal += bytes(section.text)
    console.log(`  ${section.name.padEnd(8)} order=${String(section.order).padStart(4)}  ${String(bytes(section.text)).padStart(4)} B  guidance section`)
  }
  console.log(`  native write + edit sections: ${sectionTotal} B`)
  console.log(`  => masking both (lib/mask.mjs) removes ${schemaTotal + sectionTotal} B per request`)
}

// ── 跑起来 ──────────────────────────────────────────────────────────────────

if (hasFlag('--static') || hasFlag('--vs-native')) {
  await staticReport()
  if (hasFlag('--vs-native')) await nativeReport()
  process.exit(0)
}

const ws = mkdtempSync(join(tmpdir(), 'dsh-measure-context-'))
const rows = []
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
rmSync(ws, { recursive: true, force: true })

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
