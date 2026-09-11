// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * core.mjs —— 文本编辑核心。纯 Node，只用 `node:` 内置模块，不启动任何子进程。
 *
 * 它承担 dsh 原生 `write`/`edit` 在 Windows 上做不到的事：
 *   * **保留 UTF-8 BOM**（原生工具会丢）；
 *   * **行尾跟随文件**（原生 `write` 会把 CRLF 文件拍成 LF）；
 *   * unified diff **分两层**：模型只看到一行统计加受预算约束的 diff 正文（`brief` / `diff`），
 *     完整细节留在 `stdout`（人类与 UI 卡片用）。落盘前自动备份，记编辑台账；
 *   * 锚点可以从目标取（`grep` 正则 / `lines` 行号），不必手抄旧文本；
 *   * 匹配失败时给"最接近的候选"，歧义时拒绝写盘而不是猜。
 *
 * 两条落盘保证：
 *   * **原子写**：同目录临时文件 + fsync + rename —— 中途被杀不会留下半个文件，也不会出现
 *     截断写造成的空文件；
 *   * **同目标串行**：进程内按目标路径排队，并行工具调用不会互相覆盖（跨进程不串行，
 *     那是另一件事，README 里写明了）。
 *
 * 备份与台账的格式：`<工作区>/.dsh/backups/<扁平化绝对路径>@<时间戳>` 与
 * `<工作区>/.dsh/edits.log` 里的 JSONL 记录（字段见 `appendLedger`）。
 *
 * `diff` / `maxDiffLines` / `maxDiffBytes` 的由来：工具结果按追加方式进入会话历史，不参与前缀缓存，
 * 因此单次调用回吐的字节随调用次数累积。"新建 / 整体重写" 的 unified diff 每一行都带 `+`，等同于
 * 整文件回显——实测回吐量与输入内容同量级（放大率 ≈ 1.0x）。故模型可见正文默认仅在改动较小时给出
 * （`auto`），其余情况只给统计行，由调用方决定是否另行读取文件；`none` 不给出正文，`full` 始终
 * 给出正文，但同样受上限约束。上限分三档：行数、字节、单行字符数——只约束行数时，压缩为单行的文件
 * （minified JS/CSS、单行 JSON、base64）会以"行数合规"为名整篇进入模型上下文，字节预算为此兜底。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf])
export const GUARD_DIRS = ['.git', '.dsh']
export const DEFAULT_CONTEXT = 3
/** 模型可见 diff 正文的默认行数预算：`auto` 超了就不给正文，`full` 也按它截断。 */
export const DEFAULT_MAX_DIFF_LINES = 30
/**
 * 模型可见 diff 正文的默认**字节**预算。
 *
 * 行数预算不足以约束字节数：`maxDiffLines` 只统计行数，单行可达数万字符（压缩后的 JS/CSS、单行
 * JSON、base64、宽数据行），此时"行数合规"但整篇内容仍进入模型上下文，放大率 ≈ 1.0x。实测命中该
 * 情形的最小改动包括：单行 200 KB 的新建、20 行 × 5 KB 的覆盖、替换一行 200 KB 的长行。
 */
export const DEFAULT_MAX_DIFF_BYTES = 4096
/** 单行字符上限：超出的行就地截断并标注省略了多少字符（`200` 与失败提示里的候选行一致）。 */
export const DEFAULT_MAX_DIFF_LINE_CHARS = 200
/** `diff` 的取值：`auto` 小改动才给正文 / `full` 总给（仍封顶）/ `none` 只给统计行。 */
export const DIFF_MODES = ['auto', 'full', 'none']
/** LCS 动态规划的格子上限：超过就退化成"整块替换"，避免大文件吃光内存。 */
const MAX_DIFF_CELLS = 4_000_000

/** 一次编辑用法错误（调用方原样返回给模型，不写盘）。 */
export class UsageError extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// 一、文本与字节
// ─────────────────────────────────────────────────────────────────────────────

/** 任意来源的文本归一为「无 BOM、\n 行尾」的逻辑文本。 */
export function toLf(text) {
  if (typeof text !== 'string') return text
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * 只看字节，判断 BOM / 行尾风格 / 是否可编辑。
 * @param bytes - 文件原始字节。
 * @returns { bom, eol, crlf, lf, mixed, binary, invalidUtf8 }
 */
export function analyzeBytes(bytes) {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = bom ? bytes.subarray(3) : bytes
  let crlf = 0
  let lf = 0
  let binary = false
  for (let i = 0; i < body.length; i += 1) {
    const byte = body[i]
    if (byte === 0) { binary = true; break }
    if (byte === 0x0a) {
      if (i > 0 && body[i - 1] === 0x0d) crlf += 1
      else lf += 1
    }
  }
  // 判定规则：有 CRLF 且 CRLF >= 独立 LF ⇒ CRLF（跟随多数派，平局算 CRLF）
  const eol = crlf > 0 && crlf >= lf ? '\r\n' : '\n'
  return { bom, eol, crlf, lf, mixed: crlf > 0 && lf > 0, binary, invalidUtf8: false }
}

/**
 * 解码为逻辑文本（无 BOM、\n 行尾）。非法 UTF-8 或二进制内容会被拒绝。
 * @param bytes - 文件原始字节。
 * @param label - 出错信息里用的显示路径。
 * @returns { text, info }
 * @throws {UsageError} 内容不可安全编辑时。
 */
export function decodeText(bytes, label) {
  const info = analyzeBytes(bytes)
  if (info.binary) {
    throw new UsageError(`${label}: 含 NUL 字节，看起来是二进制文件，拒绝编辑（本工具只处理 UTF-8 文本）`)
  }
  const body = info.bom ? bytes.subarray(3) : bytes
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch (error) {
    throw new UsageError(`${label}: 不是合法 UTF-8（${error && error.message ? error.message : 'decode error'}），拒绝写盘以免损坏文件`)
  }
  return { text: toLf(text), info }
}

/** 逻辑文本 → 目标字节（恢复行尾 + 恢复 BOM）。绝不经过任何换行翻译层。 */
export function encodeText(text, info) {
  const body = info.eol === '\n' ? text : text.replace(/\n/g, info.eol)
  const raw = Buffer.from(body, 'utf8')
  return info.bom ? Buffer.concat([UTF8_BOM_BYTES, raw]) : raw
}

/** 拆成"不带换行的行数组" + 末尾是否有换行。行号 = 下标 + 1。 */
export function splitLines(text) {
  const endsWithNl = text.endsWith('\n')
  if (text === '') return { lines: [], endsWithNl: false }
  const lines = text.split('\n')
  if (endsWithNl) lines.pop()
  return { lines, endsWithNl }
}

/** splitLines 的逆运算。 */
export function joinLines(lines, endsWithNl) {
  if (lines.length === 0) return ''
  return lines.join('\n') + (endsWithNl ? '\n' : '')
}

/** 逻辑文本 → 字符下标 → 行号（1-based）的查找表。 */
function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function offsetToLine(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、路径护栏与显示
// ─────────────────────────────────────────────────────────────────────────────

function normalizeKey(path) {
  return resolve(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 危险路径护栏：拒绝 `.git/`、`.dsh/` 内部，以及工作区之外的路径。
 * @param absPath - 绝对目标路径。
 * @param root - 工作区根。
 * @returns 错误说明，`null` 表示放行。
 */
export function guardTarget(absPath, root) {
  const norm = normalizeKey(absPath)
  const parts = norm.split('/')
  for (const dir of GUARD_DIRS) {
    if (parts.includes(dir)) {
      return `拒绝写入 ${dir}/ 内部（${absPath}）——那是 git / dsh 自己的地盘`
    }
  }
  const rootKey = normalizeKey(root)
  if (rootKey !== '' && norm !== rootKey && !norm.startsWith(rootKey + '/')) {
    return `目标在工作区之外：${absPath}（工作区根=${root}）`
  }
  return null
}

/** 工作区内的相对路径（用 / 分隔），用于 diff 头与台账。 */
export function relativeLabel(root, absPath) {
  const rel = relative(root, absPath)
  if (rel === '') return basename(absPath)
  if (rel.startsWith('..') || isAbsolute(rel)) return absPath.replace(/\\/g, '/')
  return rel.split(sep).join('/')
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、锚点定位：--lines / --grep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `263` | `263:270` | `263-270` | 负数从末尾算 → 1-based 闭区间。
 * @throws {UsageError} 格式错或越界。
 */
export function parseLinespec(spec, text) {
  const cleaned = String(spec).trim()
  const range = /^(-?\d+)\s*[:,-]\s*(-?\d+)$/.exec(cleaned)
  const single = /^-?\d+$/.exec(cleaned)
  let a
  let b
  if (range) {
    a = Number(range[1])
    b = Number(range[2])
  } else if (single) {
    a = Number(single[0])
    b = a
  } else {
    throw new UsageError(`lines 格式应为 263 或 263:270，收到 ${JSON.stringify(spec)}`)
  }
  const total = splitLines(text).lines.length
  if (a < 0) a = total + 1 + a
  if (b < 0) b = total + 1 + b
  if (a < 1 || b < 1 || a > total || b > total) {
    throw new UsageError(`lines ${spec} 超出范围（该文件共 ${total} 行）`)
  }
  return a > b ? { start: b, end: a } : { start: a, end: b }
}

/** 取第 startLine..endLine 行的**原文**（含各行的换行符，因此替换/删除不会留下空行）。 */
function rawRange(text, starts, startLine, endLine) {
  const from = starts[startLine - 1]
  const to = endLine < starts.length ? starts[endLine] : text.length
  return text.slice(from, to)
}

/**
 * 正则锚点：命中的那一行（多行正则取整块）。命中多处且未声明 count 时报错并列出候选行号。
 * @throws {UsageError} 未命中或多处歧义。
 */
export function grepSpan(pattern, text, ctx = 0, count = undefined) {
  let re
  try {
    re = new RegExp(pattern, 'gm')
  } catch (error) {
    throw new UsageError(`grep 不是合法正则：${error.message}`)
  }
  const starts = lineStarts(text)
  const { lines } = splitLines(text)
  const hits = []
  let match
  while ((match = re.exec(text)) !== null) {
    hits.push({ start: match.index, end: match.index + match[0].length })
    if (match[0].length === 0) re.lastIndex += 1
    if (hits.length > 5000) break
  }
  if (hits.length === 0) throw new UsageError(`grep ${JSON.stringify(pattern)} 在目标文件中没有命中`)
  if (hits.length > 1 && count !== hits.length) {
    const where = hits.slice(0, 8).map((h) => offsetToLine(starts, h.start)).join('、')
    throw new UsageError(`grep ${JSON.stringify(pattern)} 命中 ${hits.length} 处（行 ${where}）——写得更精确，或改用 lines/old_text，或用 count 声明命中数`)
  }
  const spans = hits.map((h) => ({
    start: Math.max(1, offsetToLine(starts, h.start) - ctx),
    end: Math.min(lines.length, offsetToLine(starts, Math.max(h.start, h.end - 1)) + ctx),
  }))
  if (spans.length === 1) {
    return { ...spans[0], raw: rawRange(text, starts, spans[0].start, spans[0].end) }
  }
  spans.sort((x, y) => x.start - y.start)
  const merged = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  const raw = merged.map((span) => rawRange(text, starts, span.start, span.end)).join('')
  return { start: merged[0].start, end: merged[merged.length - 1].end, raw }
}

/** `lines`（纯数字/区间）与 `grep`（正则）统一入口。 */
export function resolveAnchor(spec, text, ctx = 0, count = undefined) {
  const cleaned = String(spec).trim()
  const numeric = /^-?\d+(\s*[:,-]\s*-?\d+)?$/.test(cleaned)
  const span = numeric ? parseLinespec(cleaned, text) : grepSpan(cleaned, text, ctx, count)
  const starts = lineStarts(text)
  return { start: span.start, end: span.end, raw: span.raw ?? rawRange(text, starts, span.start, span.end) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 四、匹配：精确 → 宽松 → 最接近候选
// ─────────────────────────────────────────────────────────────────────────────

function normalizeLine(kind, line) {
  if (kind === 'ws') return line.replace(/[ \t]/g, '')
  if (kind === 'trail') return line.replace(/\s+$/, '')
  return line.trim()
}

/** 两段文本的相似度（0..1），基于字符级 LCS。 */
export function similarity(a, b) {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const n = a.length
  const m = b.length
  if (n * m > MAX_DIFF_CELLS) {
    // 太大就不做 DP：用长度比当粗略下界
    return Math.min(n, m) / Math.max(n, m)
  }
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)])
    }
  }
  return (2 * dp[0]) / (n + m)
}

function findAllExact(text, old) {
  const spans = []
  let from = 0
  while (true) {
    const index = text.indexOf(old, from)
    if (index < 0) break
    spans.push([index, index + old.length])
    from = index + Math.max(1, old.length)
  }
  return spans
}

/** 宽松匹配：滑窗比较归一化后的行块，相似度 ≥ 0.9 视为命中。 */
function relaxedMatch(text, old, kind) {
  const { lines } = splitLines(text)
  const oldLines = splitLines(old).lines
  if (oldLines.length === 0) return null
  const keys = lines.map((line) => normalizeLine(kind, line))
  const oldKeys = oldLines.map((line) => normalizeLine(kind, line))
  const n = oldKeys.length
  const starts = lineStarts(text)
  let best = null
  for (let i = 0; i + n <= lines.length; i += 1) {
    if (keys[i] !== oldKeys[0] || keys[i + n - 1] !== oldKeys[n - 1]) continue
    const ratio = similarity(keys.slice(i, i + n).join('\n'), oldKeys.join('\n'))
    if (ratio >= 0.9 && (best === null || ratio > best.ratio)) best = { ratio, index: i }
  }
  if (best === null) return null
  const startOffset = starts[best.index]
  const endOffset = best.index + n < starts.length ? starts[best.index + n] : text.length
  return [startOffset, endOffset]
}

/** 失败时给最接近的几处（行号 + 相似度 + 期望 vs 实际）。 */
export function nearestCandidates(text, old, limit = 3) {
  const { lines } = splitLines(text)
  const oldLines = splitLines(old).lines.length > 0 ? splitLines(old).lines : [old]
  const n = oldLines.length
  const firstKey = normalizeLine('loose', oldLines[0])
  const scored = []
  for (let i = 0; i + n <= lines.length; i += 1) {
    const ratio = similarity(lines.slice(i, i + n).join('\n'), oldLines.join('\n'))
    const anchored = normalizeLine('loose', lines[i]) === firstKey ? 0.05 : 0
    scored.push({ index: i, ratio: ratio + anchored })
  }
  scored.sort((a, b) => b.ratio - a.ratio)
  return scored
    .filter((entry) => entry.ratio >= 0.35)
    .slice(0, limit)
    .map((entry) => ({
      line: entry.index + 1,
      endLine: Math.min(entry.index + n, lines.length),
      ratio: Math.round(entry.ratio * 1000) / 1000,
      expected: oldLines.slice(0, 12).join('\n'),
      actual: lines.slice(entry.index, Math.min(entry.index + n, lines.length)).slice(0, 12).join('\n'),
    }))
}

/**
 * 在 text 里定位 old。
 * @param text - 逻辑文本。
 * @param old - 旧片段。
 * @param options - `nth`（只取第 k 次）/ `strict`（禁用宽松匹配）/ `expect`（要求恰好 N 处）。
 * @returns { ok, spans, mode, note, hits, candidates }
 */
export function matchLiteral(text, old, options = {}) {
  const { nth = 0, strict = false, expect } = options
  const hits = findAllExact(text, old)
  if (old === '') return { ok: false, spans: [], mode: 'miss', hits, note: 'old 不能为空', candidates: [] }
  if (nth > 0) {
    if (hits.length < nth) {
      return { ok: false, spans: [], mode: 'miss', hits, note: `old 只出现 ${hits.length} 次，取不到第 ${nth} 次`, candidates: nearestCandidates(text, old) }
    }
    return { ok: true, spans: [hits[nth - 1]], mode: nth === 1 ? 'exact' : `exact:nth(${nth})`, hits, note: nth === 1 ? '' : `取第 ${nth} 次出现`, candidates: [] }
  }
  if (expect !== undefined && hits.length === expect) {
    return { ok: true, spans: hits, mode: expect === 1 ? 'exact' : `exact:count(${expect})`, hits, note: expect === 1 ? '' : `命中 ${expect} 处，全部替换`, candidates: [] }
  }
  if (hits.length === 1) return { ok: true, spans: hits, mode: 'exact', hits, note: '', candidates: [] }
  if (hits.length > 1) {
    const starts = lineStarts(text)
    const where = hits.slice(0, 10).map(([s]) => offsetToLine(starts, s)).join('、')
    const reason = expect !== undefined
      ? `old 出现 ${hits.length} 次（行 ${where}），与要求的 ${expect} 次不符 —— 已拒绝写盘`
      : `old 出现 ${hits.length} 次（行 ${where}）—— 用 nth 指定第几次，用 count 声明命中数，或写更长的 old`
    return { ok: false, spans: [], mode: 'ambiguous', hits, note: reason, candidates: [] }
  }
  if (expect !== undefined) {
    return { ok: false, spans: [], mode: 'miss', hits, note: `old 精确出现 0 处，要求 ${expect} 处`, candidates: nearestCandidates(text, old) }
  }
  if (strict) {
    return { ok: false, spans: [], mode: 'miss', hits, note: 'old 在目标文件中不存在（strict 已禁用宽松匹配）', candidates: nearestCandidates(text, old) }
  }
  for (const [kind, label] of [['trail', '忽略行尾空白'], ['loose', '忽略行首/行尾空白'], ['ws', '忽略全部空白差异']]) {
    const span = relaxedMatch(text, old, kind)
    if (span) {
      return {
        ok: true,
        spans: [span],
        mode: kind,
        hits,
        note: `精确匹配失败，已用宽松模式命中（${label}）—— 请核对 diff 的行号`,
        candidates: [],
      }
    }
  }
  return { ok: false, spans: [], mode: 'miss', hits, note: 'old 在目标文件中不存在（精确与宽松匹配均失败）', candidates: nearestCandidates(text, old) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 五、unified diff
// ─────────────────────────────────────────────────────────────────────────────

/** 行级 LCS 编辑脚本。 */
function lineOps(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((_, bi) => ({ t: '+', bi }))
  if (m === 0) return a.map((_, ai) => ({ t: '-', ai }))
  if (n * m > MAX_DIFF_CELLS) {
    const ops = a.map((_, ai) => ({ t: '-', ai }))
    for (let bi = 0; bi < m; bi += 1) ops.push({ t: '+', bi })
    return ops
  }
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: '=', ai: i, bi: j })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ t: '-', ai: i })
      i += 1
    } else {
      ops.push({ t: '+', bi: j })
      j += 1
    }
  }
  while (i < n) { ops.push({ t: '-', ai: i }); i += 1 }
  while (j < m) { ops.push({ t: '+', bi: j }); j += 1 }
  return ops
}

function diffOpsFor(a, b) {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1
  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const ops = []
  for (let i = 0; i < prefix; i += 1) ops.push({ t: '=', ai: i, bi: i })
  for (const op of lineOps(midA, midB)) {
    if (op.t === '=') ops.push({ t: '=', ai: prefix + op.ai, bi: prefix + op.bi })
    else if (op.t === '-') ops.push({ t: '-', ai: prefix + op.ai })
    else ops.push({ t: '+', bi: prefix + op.bi })
  }
  for (let i = 0; i < suffix; i += 1) {
    ops.push({ t: '=', ai: a.length - suffix + i, bi: b.length - suffix + i })
  }
  return ops
}

/**
 * unified diff 文本；`label` 只用于 `a/` `b/` 头。
 * 与 GNU diff 一样标出"末尾没有换行"的那一侧。
 */
export function unifiedDiff(label, before, after, context = DEFAULT_CONTEXT) {
  if (before === after) return ''
  const a = splitLines(before)
  const b = splitLines(after)
  const ops = diffOpsFor(a.lines, b.lines)
  const noEolA = a.lines.length > 0 && !a.endsWithNl
  const noEolB = b.lines.length > 0 && !b.endsWithNl
  const changeIndexes = []
  for (let i = 0; i < ops.length; i += 1) if (ops[i].t !== '=') changeIndexes.push(i)
  if (changeIndexes.length === 0 && noEolA === noEolB) return ''

  // 逐行内容相同、只差"文件末尾那个换行符"：LCS 看不出差异，手工补一个 hunk
  if (changeIndexes.length === 0) {
    const last = a.lines.length - 1
    const from = Math.max(0, last - context)
    const count = last - from + 1
    const out = [`--- a/${label}`, `+++ b/${label}`, `@@ -${from + 1},${count} +${from + 1},${count} @@`]
    for (let i = from; i < last; i += 1) out.push(' ' + a.lines[i])
    out.push('-' + a.lines[last])
    if (noEolA) out.push('\\ No newline at end of file')
    out.push('+' + b.lines[last])
    if (noEolB) out.push('\\ No newline at end of file')
    return out.join('\n') + '\n'
  }

  const blocks = []
  for (const index of changeIndexes) {
    const last = blocks[blocks.length - 1]
    if (last && index - last[last.length - 1] <= context * 2 + 1) last.push(index)
    else blocks.push([index])
  }

  const out = [`--- a/${label}`, `+++ b/${label}`]
  for (const block of blocks) {
    const first = block[0]
    const last = block[block.length - 1]
    const from = Math.max(0, first - context)
    const to = Math.min(ops.length - 1, last + context)
    let aConsumed = 0
    let bConsumed = 0
    for (let i = 0; i < from; i += 1) {
      if (ops[i].t !== '+') aConsumed += 1
      if (ops[i].t !== '-') bConsumed += 1
    }
    let aLen = 0
    let bLen = 0
    for (let i = from; i <= to; i += 1) {
      if (ops[i].t !== '+') aLen += 1
      if (ops[i].t !== '-') bLen += 1
    }
    const aStart = aLen === 0 ? aConsumed : aConsumed + 1
    const bStart = bLen === 0 ? bConsumed : bConsumed + 1
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`)
    for (let i = from; i <= to; i += 1) {
      const op = ops[i]
      if (op.t === '=') {
        out.push(' ' + a.lines[op.ai])
        if (noEolA && op.ai === a.lines.length - 1) out.push('\\ No newline at end of file')
      } else if (op.t === '-') {
        out.push('-' + a.lines[op.ai])
        if (noEolA && op.ai === a.lines.length - 1) out.push('\\ No newline at end of file')
      } else {
        out.push('+' + b.lines[op.bi])
        if (noEolB && op.bi === b.lines.length - 1) out.push('\\ No newline at end of file')
      }
    }
  }
  return out.join('\n') + '\n'
}

/** +/- 行数统计：直接数 diff 里的增删行。 */
export function diffStat(before, after) {
  let added = 0
  let removed = 0
  for (const line of (before === after ? '' : unifiedDiff('stat', before, after)).split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/**
 * 单行超长时的截断：保留前 `maxChars` 个字符，尾部标注省略了多少字符。
 * 前缀保留让 `+` / `-` 与行首标识仍然可读，也让调用方还能认出这是哪一行。
 */
function clampDiffLine(line, maxChars) {
  if (line.length <= maxChars) return line
  return `${line.slice(0, maxChars)}…[+${line.length - maxChars} chars]`
}

/** 在行数与字节两个预算内，从头取尽量多的行（`full` 的截断用）。 */
function fitLines(lines, maxLines, maxBytes) {
  const kept = []
  let bytes = 0
  for (const line of lines) {
    if (kept.length >= maxLines) break
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > maxBytes) break
    kept.push(line)
    bytes += size
  }
  return kept
}

/**
 * 按上限裁剪**模型可见**的 diff 正文。
 *
 * 三重约束，缺一不可：
 *   * `maxLines` —— 行数（整文件重写会产生与输入同量级的行）；
 *   * `maxBytes` —— 字节（行数合规但行长很大时，行数预算形同虚设）；
 *   * `maxLineChars` —— 单行字符数（把"一行 200 KB"压成一行 200 字符 + 省略标注）。
 *
 * `none` 不返回正文；`auto` 仅在三重预算内都放得下时返回正文，否则只给一行提示；`full` 始终
 * 给出正文，超出预算时截断并附一行说明。
 *
 * @param text - 已生成的 unified diff 文本（调用方传 0 上下文行的那份，只保留改动行）。
 * @param mode - `auto` | `full` | `none`（见 {@link DIFF_MODES}）。
 * @param maxLines - 正文行数上限，默认 {@link DEFAULT_MAX_DIFF_LINES}。
 * @param maxBytes - 正文字节上限，默认 {@link DEFAULT_MAX_DIFF_BYTES}。
 * @param maxLineChars - 单行字符上限，默认 {@link DEFAULT_MAX_DIFF_LINE_CHARS}。
 * @returns 模型可见的正文；裁剪时附一行说明（省略或截断），可能为空字符串。
 */
export function diffBudget(
  text,
  mode,
  maxLines = DEFAULT_MAX_DIFF_LINES,
  maxBytes = DEFAULT_MAX_DIFF_BYTES,
  maxLineChars = DEFAULT_MAX_DIFF_LINE_CHARS,
) {
  if (mode === 'none' || text === '') return ''
  const raw = text.trimEnd().split('\n')
  const lines = raw.map((line) => clampDiffLine(line, maxLineChars))
  const totalBytes = Buffer.byteLength(lines.join('\n'), 'utf8')
  if (lines.length <= maxLines && totalBytes <= maxBytes) return lines.join('\n')
  const budget = `${maxLines} lines / ${maxBytes} B`
  if (mode === 'auto') {
    return `[diff omitted: ${lines.length} lines / ${totalBytes} B > budget ${budget}; pass diff:"full" or read the file]`
  }
  const hint = `[diff truncated: ${lines.length} lines / ${totalBytes} B total, budget ${budget}]`
  // 说明行本身也占预算：先把它扣掉，正文 + 说明才不会越过 maxBytes。
  const room = Math.max(0, maxBytes - Buffer.byteLength(hint, 'utf8') - 1)
  return [...fitLines(lines, maxLines, room), hint].join('\n')
}

/**
 * 去掉 unified diff 顶部的 `--- a/…` 与 `+++ b/…` 头两行。
 *
 * 模型可见正文里路径已在结果首行出现过一次，头部两行属于重复；标准形式仍完整保留在 `stdout`
 * 与 UI 卡片中。
 *
 * @param text - unified diff 文本。
 * @returns 去掉文件头之后的文本（没有头部时原样返回）。
 */
function withoutDiffHeaders(text) {
  const lines = text.split('\n')
  let from = 0
  while (from < lines.length && (lines[from].startsWith('---') || lines[from].startsWith('+++'))) {
    from += 1
  }
  return lines.slice(from).join('\n')
}

/**
 * 把 unified diff 文本解析为 UI diff 卡片的词汇：`{ path, oldText, newText }` 列表，
 * 与原生 `edit` / `write` 的 `presentationMeta` 同形（纯新增的 hunk 用 `oldText: null`）。
 *
 * 该投影面向人类，不经过模型上下文：完整 diff（含上下文行）由此提供，模型侧使用经
 * `diffBudget` 裁剪的正文。
 *
 * @param text - unified diff 文本。
 * @param path - 卡片上标注的路径。
 * @returns 每个 hunk 一个条目；没有可解析的 hunk 时返回空数组。
 */
export function hunksFromDiff(text, path) {
  const hunks = []
  let current = null
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      current = { old: [], next: [] }
      hunks.push(current)
      continue
    }
    if (current === null || line.startsWith('\\')) continue
    if (line.startsWith('-')) current.old.push(line.slice(1))
    else if (line.startsWith('+')) current.next.push(line.slice(1))
    else if (line.startsWith(' ')) {
      current.old.push(line.slice(1))
      current.next.push(line.slice(1))
    }
  }
  return hunks.map((hunk) => ({
    path,
    oldText: hunk.old.length > 0 ? hunk.old.join('\n') : null,
    newText: hunk.next.join('\n'),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 六、备份、台账、原子写、同目标串行
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 系统调用失败的**模型可读**表述。
 *
 * 直接采用 Node 的 `error.message` 有两个问题：它同时携带内部临时文件名（`.<名字>.<pid><ts>.tmp`）
 * 与绝对路径，二者都不应进入模型上下文；且它不提供可操作信息。此处只保留 errno 与一句原因。
 */
const FS_ERROR_REASONS = {
  EACCES: '没有写权限',
  EBUSY: '文件被其它进程占用',
  EISDIR: '目标是一个目录',
  EMFILE: '文件句柄耗尽',
  ENAMETOOLONG: '路径过长',
  ENOENT: '目录不存在',
  ENOSPC: '磁盘空间不足',
  ENOTDIR: '路径中的某一段不是目录',
  EPERM: '没有写权限',
  EROFS: '文件系统只读',
}

/** 兜底：把任何仍带内部临时文件名的文本抹掉（未知 errno 时才用得到）。 */
function scrubTempNames(text) {
  return String(text ?? '').replace(/\S*\.tmp\b/g, '<临时文件>')
}

/** 一次落盘相关的系统调用失败 → 一句完整、可操作、不含内部细节的失败原因。 */
function ioFailure(what, label, error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  if (code === '') return `${label}：${what}失败（${scrubTempNames(error && error.message ? error.message : error)}）`
  const reason = FS_ERROR_REASONS[code]
  return `${label}：${what}失败（${code}${reason === undefined ? '' : '：' + reason}）`
}

/**
 * 新建文件时补齐缺失的父目录（`write_text` 的"新建无需任何开关"包括目录）。
 *
 * 父目录存在但不是目录（路径中间夹着一个文件）时抛 `ENOTDIR`：不做这项检查时 Windows 报 `ENOENT`
 * （"目录不存在"），而该位置实际存在一份同名文件，错误码对调用方具有误导性。
 *
 * @returns 真正创建过目录时返回该目录的工作区相对路径，否则 `null`。
 */
function ensureParentDir(absPath, root) {
  const dir = dirname(absPath)
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) {
      throw Object.assign(new Error('parent exists but is not a directory'), { code: 'ENOTDIR' })
    }
    return null
  }
  mkdirSync(dir, { recursive: true })
  return relativeLabel(root, dir)
}

function two(n, width = 2) {
  return String(n).padStart(width, '0')
}

function stamp(date) {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-`
    + `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}-`
    + `${two(date.getMilliseconds(), 3)}`
}

/** 备份文件名：<绝对路径扁平化>@<时间戳>。 */
export function backupFileNameFor(absPath, date = new Date()) {
  const flat = resolve(absPath).replace(/:/g, '').replace(/[\\/]/g, '_')
  return `${flat}@${stamp(date)}`
}

/** 落盘前的原件备份。 */
export function makeBackup(artifactsDir, absPath, bytes, date = new Date()) {
  const dir = join(artifactsDir, 'backups')
  mkdirSync(dir, { recursive: true })
  const name = backupFileNameFor(absPath, date)
  writeFileSync(join(dir, name), bytes)
  return name
}

/** 追加一条 JSONL 台账：每行一个对象，字段见 record。 */
export function appendLedger(artifactsDir, entry) {
  const file = join(artifactsDir, 'edits.log')
  mkdirSync(artifactsDir, { recursive: true })
  const time = new Date()
  const record = {
    time: `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} `
      + `${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}`,
    ...entry,
  }
  let id = 1
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8')
    id = raw.split('\n').filter((line) => line.trim() !== '').length + 1
  }
  record.id = id
  writeFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'a' })
  return record
}

/**
 * 原子写：同目录临时文件 → fsync → rename 覆盖。
 * 中途被杀只会留下一个 `.tmp`，目标文件永远是完整的旧内容或完整的新内容。
 */
export function writeFileAtomic(absPath, buffer) {
  const dir = dirname(absPath)
  let mode
  try {
    mode = statSync(absPath).mode
  } catch {
    mode = undefined
  }
  const tmp = join(dir, `.${basename(absPath)}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`)
  let fd
  try {
    fd = openSync(tmp, 'wx', mode)
    writeSync(fd, buffer)
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  try {
    renameSync(tmp, absPath)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 尽力清理 */ }
    throw error
  }
}

const locks = new Map()

/** 同一目标路径的编辑在进程内串行（并行工具调用不会互相覆盖）。 */
export function withTargetLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  const tail = next.then(() => {}, () => {})
  locks.set(key, tail)
  tail.finally(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return next
}

/** 新建文件的行尾：同目录**多数派**（同扩展名优先），没有依据时 LF。 */
export function inferNewline(absPath) {
  const configured = (process.env.DSH_TEXT_EDITOR_EOL ?? '').toLowerCase()
  if (configured === 'lf') return '\n'
  if (configured === 'crlf' || configured === 'cr') return '\r\n'
  const dir = dirname(absPath)
  const ext = basename(absPath).includes('.') ? basename(absPath).slice(basename(absPath).lastIndexOf('.')) : ''
  let sameExtCrlf = 0
  let sameExtLf = 0
  let otherCrlf = 0
  let otherLf = 0
  let names
  try {
    names = readdirSync(dir).slice(0, 400)
  } catch {
    return '\n'
  }
  for (const name of names) {
    const full = join(dir, name)
    if (full === absPath) continue
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > 1024 * 1024) continue
    let sample
    try {
      sample = readFileSync(full).subarray(0, 8192)
    } catch {
      continue
    }
    if (sample.includes(0)) continue
    const crlf = countCrlf(sample)
    const lf = countLf(sample) - crlf
    if (crlf === 0 && lf === 0) continue
    const isCrlf = crlf > 0 && crlf >= lf
    if (name.endsWith(ext)) {
      if (isCrlf) sameExtCrlf += 1
      else sameExtLf += 1
    } else if (isCrlf) otherCrlf += 1
    else otherLf += 1
  }
  if (sameExtCrlf + sameExtLf > 0) return sameExtCrlf >= sameExtLf ? '\r\n' : '\n'
  if (otherCrlf + otherLf > 0) return otherCrlf >= otherLf ? '\r\n' : '\n'
  return '\n'
}

function countCrlf(buffer) {
  let count = 0
  for (let i = 1; i < buffer.length; i += 1) if (buffer[i] === 0x0a && buffer[i - 1] === 0x0d) count += 1
  return count
}

function countLf(buffer) {
  let count = 0
  for (const byte of buffer) if (byte === 0x0a) count += 1
  return count
}

// ─────────────────────────────────────────────────────────────────────────────
// 七、编辑模型
// ─────────────────────────────────────────────────────────────────────────────

function fail(path, message) {
  return { path, ok: false, wrote: false, dryRun: false, stdout: '', stderr: message, brief: '', diff: '' }
}

function hintText(match) {
  if (match.mode === 'ambiguous') {
    const spans = match.hits.slice(0, 12).map(([s]) => s)
    return `  候选：old 命中 ${match.hits.length} 处。用 nth 指定第几次，或 count 声明命中数。`
  }
  if (!match.candidates || match.candidates.length === 0) {
    return '  没有近似候选：核对文件是否搞错，或用 grep/lines 直接从目标取锚点（不必手抄）。'
  }
  const lines = ['  最接近的候选（行号 | 相似度）：']
  for (const candidate of match.candidates) {
    lines.push(`  - 行 ${candidate.line}-${candidate.endLine}  相似度 ${candidate.ratio.toFixed(2)}`)
    lines.push(`      目标实际：${JSON.stringify(candidate.actual.slice(0, 200))}`)
    lines.push(`      你给的 old：${JSON.stringify(candidate.expected.slice(0, 200))}`)
  }
  return lines.join('\n')
}

/**
 * 执行一次编辑/写入。后端无关：调用方只需给出归一后的 plan。
 *
 * plan（edit）：`{ kind:'edit', filePath, mode, newText, oldText, anchor:{value}|null, count, nth, strict, dryRun, note }`
 * plan（write）：`{ kind:'write', filePath, content, dryRun, note }`
 *
 * @param context - `{ root, artifactsDir, backup, log, tool, context, newFileBom, diff, maxDiffLines, maxDiffBytes, maxDiffLineChars }`
 * @returns 规范结果 `{ path, ok, wrote, dryRun, stdout, stderr, brief, diff }`
 *   `stdout` = 完整人读文本（含路径头、完整 diff、备份名），`stderr` = 失败原因；
 *   `brief` / `diff` = **模型可见**的那一份（统计行与受预算约束的正文）。
 */
export async function applyPlan(plan, context) {
  const {
    root,
    artifactsDir = join(root, '.dsh'),
    backup = true,
    log = true,
    tool = 'edit_text',
    context: diffContext = DEFAULT_CONTEXT,
    newFileBom = false,
    diff: diffMode = 'auto',
    maxDiffLines = DEFAULT_MAX_DIFF_LINES,
    maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
    maxDiffLineChars = DEFAULT_MAX_DIFF_LINE_CHARS,
  } = context
  const absPath = isAbsolute(plan.filePath) ? resolve(plan.filePath) : resolve(root, plan.filePath)
  const label = relativeLabel(root, absPath)

  const guarded = guardTarget(absPath, root)
  if (guarded) return fail(plan.filePath, guarded)

  return await withTargetLock(absPath, async () => {
    const exists = existsSync(absPath)
    const kind = plan.kind === 'write' ? 'write' : 'edit'
    if (kind === 'edit' && !exists) {
      return fail(plan.filePath, `目标不存在：${plan.filePath}（新建请用 write_text）`)
    }

    let original = ''
    let info
    let bytesBefore = Buffer.alloc(0)
    if (exists) {
      // 目标可能是目录（EISDIR）或不可读（EACCES）：这类失败只回一句 errno 说法，
      // 不把 Node 的原始 message（含绝对路径）塞进模型上下文。
      try {
        bytesBefore = readFileSync(absPath)
      } catch (error) {
        return fail(plan.filePath, ioFailure('读取目标', label, error))
      }
      try {
        const decoded = decodeText(bytesBefore, label)
        original = decoded.text
        info = decoded.info
      } catch (error) {
        if (error instanceof UsageError) return fail(plan.filePath, error.message)
        throw error
      }
    } else {
      info = { bom: newFileBom, eol: inferNewline(absPath), crlf: 0, lf: 0, mixed: false, binary: false }
    }

    const warnings = []
    if (info.mixed) {
      warnings.push(`[warn] 目标文件行尾混用；写回统一为 ${info.eol === '\r\n' ? 'CRLF' : 'LF'}`)
    }

    let output
    const applied = []

    if (kind === 'write') {
      output = toLf(plan.content ?? '')
      if (output === original && exists) {
        return fail(plan.filePath, '没有产生任何变化（新内容与现有内容一致）')
      }
      if (!output.endsWith('\n') && output !== '') {
        warnings.push('[warn] 新内容不以换行结尾，文件末尾将没有换行符')
      }
      applied.push(['write', 1, Math.max(1, splitLines(output).lines.length), 'write', plan.note ?? ''])
    } else {
      const usage = []
      const { lines } = splitLines(original)
      if (plan.mode === 'append' || plan.mode === 'prepend') {
        output = plan.mode === 'append' ? original : ''
        if (plan.mode === 'append') {
          let add = plan.newText
          if (output !== '' && !output.endsWith('\n')) {
            add = '\n' + add
            warnings.push('[warn] 目标末尾本来没有换行符，已在追加前补一个')
          }
          if (add !== '' && !add.endsWith('\n')) warnings.push('[warn] 追加内容不以换行结尾，文件末尾将没有换行符')
          output += add
        } else {
          let add = plan.newText
          if (original !== '' && add !== '' && !add.endsWith('\n')) add += '\n'
          output += add + original
        }
        applied.push([plan.mode, 1, 1, plan.mode, plan.note ?? ''])
      } else {
        const plans = []
        if (plan.mode === 'replace') {
          let target = plan.oldText
          let match
          if (plan.anchor) {
            let anchorSpan
            try {
              anchorSpan = resolveAnchor(plan.anchor.value, original, 0)
            } catch (error) {
              usage.push(error instanceof UsageError ? error.message : String(error))
              anchorSpan = null
            }
            if (anchorSpan === null) return fail(plan.filePath, usage.join('\n'))
            target = anchorSpan.raw
            const exact = matchLiteral(original, target, { nth: plan.nth ?? 0, strict: true })
            match = exact.ok ? exact : matchLiteral(original, target, { nth: plan.nth ?? 0, strict: false })
            if (match.ok) match.mode = `anchor:${match.mode}`
          } else {
            match = matchLiteral(original, target ?? '', {
              nth: plan.nth ?? 0,
              strict: plan.strict === true,
              expect: plan.count,
            })
          }
          if (!match.ok) {
            return fail(plan.filePath, `${label}：${match.note}\n${hintText(match)}`)
          }
          if (plan.count !== undefined && (plan.nth ?? 0) === 0 && match.hits.length !== plan.count) {
            return fail(plan.filePath, `${label}：old 出现 ${match.hits.length} 次，要求 ${plan.count} 次 —— 拒绝写盘`)
          }
          for (const [start, end] of match.spans) {
            const startLine = offsetToLine(lineStarts(original), start)
            const endLine = end > start ? offsetToLine(lineStarts(original), end - 1) : startLine
            plans.push({ start, end, mode: match.mode, startLine, endLine })
          }
          if (match.mode === 'trail' || match.mode === 'loose' || match.mode === 'ws' || String(match.mode).includes('trail') || String(match.mode).includes('loose')) {
            warnings.push(`[warn] ${match.note}`)
          }
        } else {
          let anchorSpan
          try {
            anchorSpan = resolveAnchor(plan.anchor.value, original, 0)
          } catch (error) {
            return fail(plan.filePath, error instanceof UsageError ? error.message : String(error))
          }
          const starts = lineStarts(original)
          const position = plan.mode === 'after'
            ? (anchorSpan.end < starts.length ? starts[anchorSpan.end] : original.length)
            : starts[anchorSpan.start - 1]
          plans.push({
            start: position,
            end: position,
            mode: plan.mode,
            startLine: anchorSpan.start,
            endLine: anchorSpan.end,
          })
        }

        const sorted = [...plans].sort((a, b) => a.start - b.start || a.end - b.end)
        for (let i = 1; i < sorted.length; i += 1) {
          const previous = sorted[i - 1]
          const current = sorted[i]
          if (current.start < previous.end) {
            return fail(plan.filePath, `两次编辑区间重叠（行 ${previous.startLine} 与 ${current.startLine}）——请拆成两次调用`)
          }
        }

        output = original
        for (const item of [...plans].sort((a, b) => b.start - a.start)) {
          output = output.slice(0, item.start) + plan.newText + output.slice(item.end)
          applied.push(['replace', item.startLine, item.endLine, item.mode, plan.note ?? ''])
        }
        void lines
      }
    }

    if (output === original && exists) {
      return fail(plan.filePath, '没有产生任何变化（old 与 new 相同，或内容已一致）')
    }
    if (!exists && output === '') {
      return fail(plan.filePath, '新建内容为空 —— 没有产生任何变化')
    }

    const diff = unifiedDiff(label, original, output, diffContext)
    const stat = diffStat(original, output)
    const created = !exists
    const head = plan.dryRun
      ? `=== ${label}${created ? '（新建）' : ''} | DRY RUN（未落盘）===`
      : `=== ${label}${created ? '（新建）' : ''} | 已写入 ===`
    const kinds = [...new Set(applied.map(([k, s, e]) => (k === 'replace' ? `replace@${s}${e !== s ? `-${e}` : ''}` : k)))]
      .join('、')

    // 模型可见部分：警告 + 一行统计（+A/-B）+ 经上限裁剪的正文。
    // 正文使用 0 上下文行：调用方刚完成这次编辑，周边内容或已读取过，或可自行读取。
    // 完整 diff（含上下文行）只出现在 stdout 与 UI 卡片中，不进入这条路径。
    const brief = [...warnings, `${kinds} +${stat.added}/-${stat.removed}`].join('\n')
    const visibleDiff = diffBudget(
      withoutDiffHeaders(unifiedDiff(label, original, output, 0)),
      diffMode,
      maxDiffLines,
      maxDiffBytes,
      maxDiffLineChars,
    )

    if (plan.dryRun) {
      return {
        path: plan.filePath,
        ok: true,
        wrote: false,
        dryRun: true,
        stdout: [...warnings, head, diff.trimEnd(), `DRY RUN ${label}：${kinds}（+${stat.added}/-${stat.removed}）`].filter((s) => s !== '').join('\n') + '\n',
        stderr: '',
        brief,
        diff: visibleDiff,
      }
    }

    // 新建时补齐父目录（dry_run 不碰文件系统，所以放在这里）。
    let madeDir = null
    if (created) {
      try {
        madeDir = ensureParentDir(absPath, root)
      } catch (error) {
        return fail(plan.filePath, ioFailure('创建目录', label, error))
      }
    }

    let backupName = null
    if (exists && backup) {
      try {
        backupName = makeBackup(artifactsDir, absPath, bytesBefore)
      } catch (error) {
        return fail(plan.filePath, ioFailure('备份原文件', label, error))
      }
    }
    try {
      writeFileAtomic(absPath, encodeText(output, info))
    } catch (error) {
      return fail(plan.filePath, ioFailure('写入目标', label, error))
    }

    // 台账是旁路产物：它失败不该把一次已经成功的写入报成失败（否则调用方会重试并重复写入）。
    let ledgerNote = ''
    if (log) {
      try {
        const first = applied[0] ?? ['?', 0, 0, '', '']
        appendLedger(artifactsDir, {
          tool,
          file: label,
          abspath: absPath,
          action: created ? 'create' : 'write',
          kinds: applied.map(([k]) => k),
          line_start: first[1],
          line_end: first[2],
          added: stat.added,
          removed: stat.removed,
          bom: info.bom,
          eol: info.eol === '\r\n' ? 'CRLF' : 'LF',
          backup: backupName,
          summary: `${kinds}${plan.note ? `；${plan.note}` : ''}`,
        })
      } catch (error) {
        ledgerNote = `[note] 台账写入失败（${error && error.code ? error.code : 'IO'}），文件本身已写入`
      }
    }

    return {
      path: plan.filePath,
      ok: true,
      wrote: true,
      dryRun: false,
      stdout: [
        ...warnings,
        head,
        ...(madeDir === null ? [] : [`[note] 新建了目录 ${madeDir}/`]),
        diff.trimEnd(),
        `OK ${label}：${kinds}（+${stat.added}/-${stat.removed}）${backupName ? `；备份 ${backupName}` : ''}`,
        ledgerNote,
      ].filter((s) => s !== '').join('\n') + '\n',
      stderr: '',
      brief,
      diff: visibleDiff,
    }
  })
}
