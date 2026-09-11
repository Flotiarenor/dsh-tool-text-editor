// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * audit-session.mjs —— 以**真实会话日志**核对两个工具进入模型上下文的字节数。
 *
 * `tools/measure-context.mjs` 测量构造场景，本脚本核对已发生的调用：dsh 把每个工具结果按
 * `tool/result` 事件写入会话日志（`<DSH_HOME>/sessions/<工作区>/session-<id>/session.jsonl.zstd`），
 * 事件中的 `data.message.content` 即**进入模型上下文的那份文本**。因此可以逐调用对账：
 *
 *   工具名 | 入参字节 | 模型可见字节 | 倍率 | 行数
 *
 * 另做两项检查：
 *   * **形状与泄漏** —— 成功必须形如 `WROTE <路径>` 加统计/警告行，失败形如 `FAIL <路径>` 加原因；
 *     出现 diff 正文、`=== ` 头、`OK ` 尾、备份名或内部临时文件名即报告；
 *   * **超限** —— 单条结果超过 `--cap`（默认 1024 B）即报告，配合 `--assert` 时退出码 1。
 *
 * 会话日志为**分帧 zstd**（边运行边追加），Node 的解压 API 只解第一帧，故此处自行按魔数切帧。
 * 零依赖，只用 `node:` 内置模块；不写入任何文件。
 *
 * 用法：
 *   node tools/audit-session.mjs                          # 扫 ~/.dsh/sessions 下的全部会话
 *   node tools/audit-session.mjs <session.jsonl.zstd>      # 只看一个会话（给出逐调用明细）
 *   node tools/audit-session.mjs <目录> --top 8            # 每个会话列出最大的 8 条结果
 *   node tools/audit-session.mjs <文件> --cap 512 --assert
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const WATCHED = ['edit_text', 'write_text']
/**
 * 模型可见文本的**允许形状**：成功是 `WROTE <路径>` 加可选的一行统计与警告，失败是 `FAIL <路径>`
 * 加原因。除此之外的一切（diff 正文、`=== ` 头、`OK ` 尾、备份名、内部临时文件名）都算泄漏——
 * 被编辑的文件内容不参与匹配，因为渲染结果里本就不该出现它。
 */
const ALLOWED_TEXT = /^(WROTE|FAIL)( [^\n]*)?(\n(?!\S*\.tmp\b)[^\n]*)*$/
const FORBIDDEN = [/\S*\.tmp\b/, /^=== /m, /^OK /m, /^备份 /m, /^DRY RUN /m]
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)
const flagValue = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const TOP = Number(flagValue('--top', '3'))
const CAP = Number(flagValue('--cap', '1024'))
const ASSERT = hasFlag('--assert')
const bytes = (value) => Buffer.byteLength(value ?? '', 'utf8')

/**
 * 解出日志的全部 zstd 帧。
 * 会话日志逐帧追加：`zstdDecompressSync` 只解第一帧，其余帧被静默丢弃（症状是日志有数 MB，却只解出
 * 数百字节）。此处按魔数切帧，并以"解不开则并入下一帧"覆盖魔数误判。
 */
function decodeFrames(buffer) {
  const offsets = []
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1]
      && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) offsets.push(i)
  }
  if (offsets.length === 0) return buffer.toString('utf8')
  const parts = []
  let index = 0
  while (index < offsets.length) {
    let next = index + 1
    for (;;) {
      const slice = buffer.subarray(offsets[index], next < offsets.length ? offsets[next] : buffer.length)
      try {
        parts.push(zstdDecompressSync(slice))
        break
      } catch (error) {
        next += 1
        if (next > offsets.length) throw error
      }
    }
    index = next
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 读取会话日志 → 事件数组。`undefined` 表示这个文件不是会话日志。 */
function readEvents(file) {
  const raw = readFileSync(file)
  const text = file.endsWith('.zstd') ? decodeFrames(raw) : raw.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 会话正在写入时最后一行可能被截断：忽略，不当成错误。
    }
  }
  return events
}

/** 一个会话里所有工具调用的对账结果。 */
function audit(file) {
  const events = readEvents(file)
  const calls = new Map()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) {
      if (block.type === 'tool-call') calls.set(block.id, block)
    }
  }
  const perTool = new Map()
  const rows = []
  const leaks = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const call = calls.get(event.data?.message?.source?.callId)
    const name = call?.name ?? '(unknown)'
    const text = (event.data?.message?.content ?? [])
      .map((block) => (block.type === 'tool-result' ? (block.content ?? []).map((content) => content.text ?? '').join('') : ''))
      .join('')
    if (WATCHED.includes(name)) {
      const hit = FORBIDDEN.filter((pattern) => pattern.test(text))
      if (!ALLOWED_TEXT.test(text)) hit.push(/unexpected shape/)
      if (hit.length > 0) leaks.push(`${name} (${hit.map(String).join(' ')})`)
    }
    const record = perTool.get(name) ?? { calls: 0, argBytes: 0, visibleBytes: 0, worstBytes: 0, worstLabel: '' }
    record.calls += 1
    record.argBytes += bytes(JSON.stringify(call?.arguments ?? {}))
    record.visibleBytes += bytes(text)
    if (bytes(text) > record.worstBytes) {
      record.worstBytes = bytes(text)
      record.worstLabel = text.split('\n')[0].slice(0, 56)
    }
    perTool.set(name, record)
    if (WATCHED.includes(name)) {
      const argBytes = bytes(JSON.stringify(call?.arguments ?? {}))
      rows.push({
        name,
        argBytes,
        visibleBytes: bytes(text),
        ratio: argBytes === 0 ? 0 : bytes(text) / argBytes,
        lines: text === '' ? 0 : text.split('\n').length,
        head: text.split('\n')[0].slice(0, 56),
        time: typeof event.time === 'number' ? new Date(event.time).toISOString().slice(11, 19) : '',
      })
    }
  }
  return { perTool, rows, leaks }
}

/** 目标：一个会话文件，或一棵会话目录。 */
function collect(target) {
  const stat = statSync(target)
  if (stat.isFile()) return [target]
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  walk(target)
  return files
}

const target = argv.find((value) => !value.startsWith('--') && !/^\d+$/.test(value))
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const files = collect(target)
if (files.length === 0) {
  console.error(`SKIP 没有会话日志：${target}`)
  process.exit(2)
}

let overCap = 0
let leaked = 0
let watchedCalls = 0
let watchedVisible = 0

for (const file of files) {
  const { perTool, rows, leaks } = audit(file)
  const textTools = [...perTool.entries()].filter(([name]) => WATCHED.includes(name))
  // 有这两个工具的调用就只看它们，否则退化成"这次会话里所有工具"的概览。
  const shown = textTools.length > 0 ? textTools : [...perTool.entries()]
  console.log(`\n=== ${file}  (${(statSync(file).size / 1024).toFixed(0)} KiB)`)
  if (shown.length === 0) {
    console.log('  no tool results')
    continue
  }
  let calls = 0
  let argBytes = 0
  let visibleBytes = 0
  let worst = 0
  for (const [name, record] of shown) {
    calls += record.calls
    argBytes += record.argBytes
    visibleBytes += record.visibleBytes
    worst = Math.max(worst, record.worstBytes)
    console.log(`  ${name.padEnd(16)} calls=${String(record.calls).padStart(3)}  args=${String(record.argBytes).padStart(8)} B  `
      + `result=${String(record.visibleBytes).padStart(8)} B  worst=${String(record.worstBytes).padStart(6)} B  ${record.worstLabel}`)
  }
  console.log(`  ${'TOTAL'.padEnd(16)} calls=${calls}  args=${argBytes} B  result=${visibleBytes} B  worst=${worst} B`)

  for (const row of rows) watchedCalls += 1
  for (const row of rows) watchedVisible += row.visibleBytes

  const biggest = [...rows].sort((a, b) => b.visibleBytes - a.visibleBytes).slice(0, Number.isFinite(TOP) ? TOP : 3)
  if (biggest.length > 0) {
    console.log(`  --- largest model-visible results (top ${biggest.length})`)
    for (const row of biggest) {
      console.log(`  ${row.time}  ${row.name.padEnd(10)} args=${String(row.argBytes).padStart(7)} B  visible=${String(row.visibleBytes).padStart(7)} B  `
        + `ratio=${row.ratio.toFixed(2)}x  lines=${row.lines}  ${row.head}`)
    }
  }
  if (files.length === 1) {
    console.log('  --- every call')
    for (const row of rows) {
      console.log(`  ${row.time}  ${row.name.padEnd(10)} args=${String(row.argBytes).padStart(7)} B  visible=${String(row.visibleBytes).padStart(7)} B  `
        + `ratio=${row.ratio.toFixed(2)}x  lines=${String(row.lines).padStart(4)}  ${row.head}`)
    }
  }
  const over = rows.filter((row) => row.visibleBytes > CAP)
  overCap += over.length
  for (const row of over) console.log(`  OVER CAP  ${row.visibleBytes} B > ${CAP} B  ${row.name}  ${row.head}`)
  leaked += leaks.length
  if (leaks.length > 0) console.log(`  LEAK  ${leaks.length} result(s) with unexpected text: ${[...new Set(leaks)].slice(0, 3).join(' | ')}`)
}

console.log('')
console.log(`scanned ${files.length} session log(s): ${watchedCalls} text-editor calls, ${watchedVisible} B of model-visible text total`)
console.log(leaked === 0 ? 'text check        : every result matches the documented shape' : `text check        : ${leaked} result(s) with unexpected text`)
console.log(overCap === 0 ? `cap check         : every result <= ${CAP} B` : `cap check         : ${overCap} result(s) over ${CAP} B`)
if (ASSERT && (leaked > 0 || overCap > 0)) process.exitCode = 1
