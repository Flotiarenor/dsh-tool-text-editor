// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * audit-session.mjs —— 用真实会话日志核对两个工具进入模型上下文的字节数。
 *
 * `tool/result` 事件的 `data.message.content` 即**进入模型上下文的那份文本**；日志在 `<DSH_HOME>/sessions/`，
 * 分帧 zstd（Node 只解第一帧，故按魔数切帧）。对账列：入参字节 | 模型可见字节 | 倍率 | 行数。
 *
 * 检查三项：**形状**（成功 `WROTE` 加统计/警告行，失败 `FAIL` 加原因；出现 diff 头尾、备份名或临时文件名即
 * 报告）、**路径回显**（成功结果不得含本次调用的 `file_path`）、**上限**（单条超过 `--cap`，默认 1024 B）。
 * `--assert` 下有泄漏或超限即退出码 1。
 *
 * `--tools` 只打印每轮真正下发的工具表（`request/header` 的 `data.header.tools[].name`）：表里还有原生
 * `write` / `edit` 说明门禁（`lib/mask.mjs`）没生效——这是唯一判据，`--assert` 下同样退出码 1。
 *
 * 用法：node tools/audit-session.mjs [<文件|目录>] [--top N] [--cap N] [--assert] [--tools]
 * 给单个文件时另打逐调用明细。退出码 2 = 无会话日志或 `--cap` 非法；零依赖，只用 `node:` 内置模块。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const WATCHED = ['edit_text', 'write_text']
/** 门禁要收窄掉的原生名字：还在工具表里就说明门禁没生效。 */
const NATIVE = ['write', 'edit']
/** 允许形状（见文件头）；关键字后跟路径的旧版本形状由 `LEGACY_TEXT` 识别。 */
const ALLOWED_TEXT = /^(WROTE|FAIL)(\n(?!\S*\.tmp\b)[^\n]*)*$/
/** **历史**形状：只用来把旧会话与新回归分开，不该让 `--assert` 永远失败。 */
const LEGACY_TEXT = /^(WROTE|FAIL)( [^\n]*)?(\n(?!\S*\.tmp\b)[^\n]*)*$/
/** 当前形状不该出现的痕迹：临时文件名、早期 diff 头尾、备份名、dry-run 行。 */
const FORBIDDEN = [/\S*\.tmp\b/, /^=== /m, /^@@ /m, /^OK /m, /^备份 /m, /^DRY RUN /m]
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
const TOOLS = hasFlag('--tools')
const bytes = (value) => Buffer.byteLength(value ?? '', 'utf8')

// 上限非数字必须报错：`bytes > NaN` 恒为 false，门禁会静默全过。
if (!Number.isFinite(CAP) || CAP < 0) {
  console.error(`FAIL --cap 需要一个非负字节数，收到 ${JSON.stringify(flagValue('--cap', ''))}`)
  process.exit(2)
}

/**
 * `tool-call` 块的参数是 JSON **字符串**，不是对象：字节量字符串本身，读字段要先解析。
 */
function callArguments(call) {
  const text = typeof call?.arguments === 'string' ? call.arguments : ''
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { text, value: parsed !== null && typeof parsed === 'object' ? parsed : {} }
}

/**
 * 解不开的段并入下一帧（段内可能碰巧出现魔数）；**尾部解不开的帧丢弃**——会话追加中读到半个尾帧是常态。
 */
function decodeFrames(buffer) {
  const offsets = []
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (ZSTD_MAGIC.every((byte, index) => buffer[i + index] === byte)) offsets.push(i)
  }
  if (offsets.length === 0) return buffer.toString('utf8')
  const parts = []
  let index = 0
  while (index < offsets.length) {
    let next = index + 1
    let decoded = false
    for (; next <= offsets.length && !decoded; next += 1) {
      const slice = buffer.subarray(offsets[index], next < offsets.length ? offsets[next] : buffer.length)
      try {
        parts.push(zstdDecompressSync(slice))
        decoded = true
      } catch {
        // 解不开就并入下一帧。
      }
    }
    if (!decoded) break
    index = next - 1
  }
  return Buffer.concat(parts).toString('utf8')
}

function readEvents(file) {
  const raw = readFileSync(file)
  const text = file.endsWith('.zstd') ? decodeFrames(raw) : raw.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 写入中的最后一行可能被截断：忽略。
    }
  }
  return events
}

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
  let legacyShapes = 0
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const call = calls.get(event.data?.message?.source?.callId)
    const name = call?.name ?? '(unknown)'
    const text = (event.data?.message?.content ?? [])
      .map((block) => (block.type === 'tool-result' ? (block.content ?? []).map((content) => content.text ?? '').join('') : ''))
      .join('')
    const watched = WATCHED.includes(name)
    const args = callArguments(call)
    const argBytes = bytes(args.text)
    const visibleBytes = bytes(text)
    if (watched) {
      const allowed = ALLOWED_TEXT.test(text)
      if (!allowed && LEGACY_TEXT.test(text)) {
        // 旧形状只计数，不判泄漏，也不查路径回显。
        legacyShapes += 1
      } else {
        const hit = FORBIDDEN.filter((pattern) => pattern.test(text))
        if (!allowed) hit.push(/unexpected shape/)
        // 成功结果不得回显路径（失败原因可以，它要指名文件）。
        const given = args.value.file_path
        if (text.startsWith('WROTE') && typeof given === 'string' && given !== '' && text.includes(given)) {
          hit.push(/echoed file_path/)
        }
        if (hit.length > 0) leaks.push(`${name} (${hit.map(String).join(' ')})`)
      }
    }
    const record = perTool.get(name) ?? { calls: 0, argBytes: 0, visibleBytes: 0, worstBytes: 0, worstLabel: '' }
    record.calls += 1
    record.argBytes += argBytes
    record.visibleBytes += visibleBytes
    if (visibleBytes > record.worstBytes) {
      record.worstBytes = visibleBytes
      record.worstLabel = text.split('\n')[0].slice(0, 56)
    }
    perTool.set(name, record)
    if (watched) {
      rows.push({
        name,
        argBytes,
        visibleBytes,
        ratio: argBytes === 0 ? 0 : visibleBytes / argBytes,
        lines: text === '' ? 0 : text.split('\n').length,
        head: text.split('\n')[0].slice(0, 56),
        time: typeof event.time === 'number' ? new Date(event.time).toISOString().slice(11, 19) : '',
      })
    }
  }
  return { perTool, rows, leaks, legacyShapes }
}

/** 每轮真正下发的工具表（工具表变了宿主才写一条 `request/header`）。 */
function toolTables(file) {
  const tables = []
  for (const event of readEvents(file)) {
    if (event.type !== 'request/header') continue
    const names = (event.data?.header?.tools ?? []).map((tool) => tool.name).sort()
    tables.push({
      seq: event.seq,
      time: new Date(event.time ?? 0).toISOString().slice(11, 19),
      reason: event.data?.reason,
      names,
    })
  }
  return tables
}

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

if (TOOLS) {
  // ── `--tools`：只打印工具表 ─────────────────────────────────────────────────
  let narrowedSessions = 0
  let openSessions = 0
  let headerlessSessions = 0
  for (const file of files) {
    const tables = toolTables(file)
    console.log(`\n=== ${file}  (${(statSync(file).size / 1024).toFixed(0)} KiB)`)
    if (tables.length === 0) {
      headerlessSessions += 1
      console.log('  no request/header yet')
      continue
    }
    for (const [index, table] of tables.entries()) {
      const natives = NATIVE.filter((name) => table.names.includes(name))
      const ours = WATCHED.filter((name) => table.names.includes(name))
      console.log(`  header #${index + 1}  seq=${table.seq}  ${table.time}  ${table.names.length} tools  reason=${table.reason ?? '-'}`)
      console.log(`      native write/edit: ${natives.length > 0 ? `PRESENT (${natives.join(', ')})` : 'masked'}`
        + `   our tools: ${ours.length > 0 ? ours.join(', ') : 'absent'}`)
      if (index === tables.length - 1) console.log(`      ${table.names.join(', ')}`)
    }
    // 判定只看最后一条 header（模型当前拿到的那张表）。
    if (NATIVE.every((name) => !tables.at(-1).names.includes(name))) narrowedSessions += 1
    else openSessions += 1
  }
  console.log('')
  console.log(`scanned ${files.length} session log(s): the last header of ${narrowedSessions} has no native write/edit, `
    + `${openSessions} still does, ${headerlessSessions} has no header at all`)
  console.log(openSessions === 0
    ? 'mask check        : every session ends on a narrowed tool table'
    : 'mask check        : sessions whose last header still lists the natives either predate the fix or run a preset without the mask row')
  // 不用 `process.exit()`：它会丢掉未刷进管道的日志。`--assert` 把这张表变成门禁。
  if (ASSERT && openSessions > 0) process.exitCode = 1
} else {
  let overCap = 0
  let leaked = 0
  let legacy = 0
  let watchedCalls = 0
  let watchedVisible = 0

  for (const file of files) {
    const { perTool, rows, leaks, legacyShapes } = audit(file)
    legacy += legacyShapes
    const allTools = [...perTool.entries()]
    const textTools = allTools.filter(([name]) => WATCHED.includes(name))
    // 有这两个工具的调用就只看它们，否则概览全部工具。
    const shown = textTools.length > 0 ? textTools : allTools
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

    for (const row of rows) {
      watchedCalls += 1
      watchedVisible += row.visibleBytes
    }

    const biggest = rows.toSorted((a, b) => b.visibleBytes - a.visibleBytes).slice(0, Number.isFinite(TOP) ? TOP : 3)
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
    if (legacyShapes > 0) console.log(`  LEGACY  ${legacyShapes} result(s) in the older shape (WROTE/FAIL followed by a path); pre-change sessions only`)
  }

  console.log('')
  console.log(`scanned ${files.length} session log(s): ${watchedCalls} text-editor calls, ${watchedVisible} B of model-visible text total`)
  console.log(leaked === 0 ? 'text check        : every result matches the documented shape' : `text check        : ${leaked} result(s) with unexpected text`)
  console.log(legacy === 0 ? 'legacy check      : no pre-change results found' : `legacy check      : ${legacy} result(s) from before the path echo was dropped (informational)`)
  console.log(overCap === 0 ? `cap check         : every result <= ${CAP} B` : `cap check         : ${overCap} result(s) over ${CAP} B`)
  if (ASSERT && (leaked > 0 || overCap > 0)) process.exitCode = 1
}
