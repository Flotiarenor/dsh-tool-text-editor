// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * core.mjs —— 文本编辑核心。纯 Node，只用 `node:` 内置模块，不启动任何子进程。
 *
 * 它承担 dsh 原生 `write` / `edit` 做不到的事：
 *   * **保留 UTF-8 BOM**（原生 `edit` / `write` 都会丢）；
 *   * **行尾跟随文件**（原生不还原原文件风格：给 LF 写 LF，CRLF 文件就此变成 LF）；
 *   * **宽松匹配**：精确 → 宽松 → 最接近候选，命中不确定时拒绝写盘而不是猜（原生只做精确匹配）；
 *   * **锚点可以从目标取**（`grep` 正则 / `lines` 行号），不必手抄旧文本。
 *
 * 两条落盘保证：**原子写**（同目录临时文件 + fsync + rename，中途被杀不会留下半个文件），
 * **同目标串行**（进程内按目标路径排队；跨进程不串行，见 README）。
 *
 * 模型可见文本只有 `brief`：一行统计（`replace@17 +1/-1`）加必要的警告，**既不回显改动内容，也不回显
 * 路径**——工具结果按追加方式进入会话历史，回显会随调用次数累积，而调用方刚发过 `new_text` 与
 * `file_path`。改动本身不落任何旁路记录：本包不写备份也不写台账。
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
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf])
/** 生成 unified diff 时的默认上下文行数（只喂 `diffStat` 的 `+N/-M`）。 */
export const DEFAULT_CONTEXT = 3
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
 * 只看字节，判断 BOM / 行尾风格 / 能否按文本处理。
 *
 * 非法 UTF-8 不在这里判：它只在真正解码时才知道（`decodeText` 用 `fatal: true` 解），所以本函数不返回
 * 一个永远为假的标志位。
 * @param bytes - 文件原始字节。
 * @returns { bom, eol, crlf, lf, mixed, binary }
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
  return { bom, eol, crlf, lf, mixed: crlf > 0 && lf > 0, binary }
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
// 二、路径与显示
// ─────────────────────────────────────────────────────────────────────────────
//
// 这里**没有**路径护栏：工作区之外、`.git/`、`.dsh/` 内部都能写。理由是能力取舍——本插件不经
// `ctx.fs`，宿主沙箱、fs 观察策略与 `sandbox_permissions` 升权拦不到它；而自带的"字符串前缀"护栏既拦不住
// 符号链接（工作区里的 junction 照样能写到外面），又会在 full-access 会话里禁掉模型本来有权限写的位置。
// 护栏留给宿主策略与调用方，本包不假装自己是安全边界。唯一保留的是**会话策略**的镜像：
// `read-only` 会话下两个工具在任何 I/O 之前拒写（见 lib/editor.mjs）。

/** 工作区内的相对路径（用 / 分隔），用于 diff 头与台账；工作区之外回落到绝对路径。 */
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
 * `count` 给定时按"声明的命中行数"校验：`lines` 锚点是一次点名一段行号，声明数与实际行数不符就拒绝
 * ——与 `grep` / `old_text` 上的 `count` 语义一致（三处都是"声明期望命中数，不符即拒绝"）。
 * @throws {UsageError} 格式错、越界，或与声明的 count 不符。
 */
export function parseLinespec(spec, text, count = undefined) {
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
  const span = a > b ? { start: b, end: a } : { start: a, end: b }
  if (count !== undefined && span.end - span.start + 1 !== count) {
    throw new UsageError(`lines ${spec} 覆盖 ${span.end - span.start + 1} 行，与声明的 count=${count} 不符 —— 拒绝写盘`)
  }
  return span
}

/** 取第 startLine..endLine 行的**原文**（含各行的换行符，因此替换/删除不会留下空行）。 */
function rawRange(text, starts, startLine, endLine) {
  const from = starts[startLine - 1]
  const to = endLine < starts.length ? starts[endLine] : text.length
  return text.slice(from, to)
}

/**
 * 正则锚点：命中的那一行（多行正则取整块）。`count` 是声明的命中数：不符即拒绝，配对的多处命中逐处替换。
 * @throws {UsageError} 未命中、命中数不符，或命中多处而未声明 count。
 */
export function grepSpan(pattern, text, ctx = 0, count = undefined) {
  // 本函数已经按 `gm` 编译，所以调用方再写一个内联 `(?m)` 只会让 `new RegExp` 抛"Invalid group"——
  // 而那正是从别处抄来的正则最常见的写法。剥掉它即可（`m` 已生效；`i` / `s` 一并识别）。
  const source = String(pattern)
  const inline = /^\(\?([ims]+)\)/.exec(source)
  const cleaned = inline === null ? source : source.slice(inline[0].length)
  const flags = `gm${inline !== null && inline[1].includes('i') ? 'i' : ''}${inline !== null && inline[1].includes('s') ? 's' : ''}`
  let re
  try {
    re = new RegExp(cleaned, flags)
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
  // `count` 就是"声明期望命中数"（与 `old_text` 一致）：不匹配即拒绝，配对的多处命中则逐处替换。
  // 没有这一句，`grep` 上的 `count` 会被**静默忽略**——命中一处却声明五处照样写盘，与契约相反。
  if (count !== undefined ? hits.length !== count : hits.length > 1) {
    const where = hits.slice(0, 8).map((h) => offsetToLine(starts, h.start)).join('、')
    throw new UsageError(count === undefined
      ? `grep ${JSON.stringify(pattern)} 命中 ${hits.length} 处（行 ${where}）——写得更精确，或改用 lines/old_text，或用 count 声明命中数`
      : `grep ${JSON.stringify(pattern)} 命中 ${hits.length} 处（行 ${where}），与声明的 count=${count} 不符 —— 拒绝写盘`)
  }
  const spans = hits.map((h) => ({
    start: Math.max(1, offsetToLine(starts, h.start) - ctx),
    end: Math.min(lines.length, offsetToLine(starts, Math.max(h.start, h.end - 1)) + ctx),
  }))
  if (spans.length === 1) {
    return { ...spans[0], blocks: [spans[0]], raw: rawRange(text, starts, spans[0].start, spans[0].end) }
  }
  spans.sort((x, y) => x.start - y.start)
  const merged = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  // `raw` 是给"整块一次替换"用的合并文本；`blocks` 是**每一次命中自己的行块**，供声明了 count 的多处命中
  // 逐处替换——把非相邻的行块拼成一段文本，那段文本在全文里并不存在，拿它去匹配必然失败。
  const raw = merged.map((span) => rawRange(text, starts, span.start, span.end)).join('')
  return { start: merged[0].start, end: merged[merged.length - 1].end, blocks: merged, raw }
}

/** `lines`（纯数字/区间）与 `grep`（正则）统一入口；`count` 是"声明的命中数"，两条路径都校验。 */
export function resolveAnchor(spec, text, ctx = 0, count = undefined) {
  const cleaned = String(spec).trim()
  const numeric = /^-?\d+(?:\s*[:,-]\s*-?\d+)?$/.test(cleaned)
  const span = numeric ? parseLinespec(cleaned, text, count) : grepSpan(cleaned, text, ctx, count)
  const starts = lineStarts(text)
  return {
    start: span.start,
    end: span.end,
    blocks: span.blocks ?? [{ start: span.start, end: span.end }],
    raw: span.raw ?? rawRange(text, starts, span.start, span.end),
  }
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

/**
 * 宽松命中的 span 是**整行块**（含行尾空白与换行符），而 `old` 可能没有换行结尾——抄自 `read` 的锚点
 * 看不到行尾空白，`old_text: 'gamma'` 在文件里其实是 `'gamma   '`。原样用它换掉整块会连带吃掉那些看不见
 * 的字节：行尾空白留下（`GAMMA   `），换行符也没了，下一行被并进替换结果——改一行变成删一行，而 `+1/-2`
 * 是模型唯一的线索。
 *
 * 判据只取两条，都是匹配层已知的事实：锚点**没有**以换行结尾（调用方换的是行内容，不是行边界），却命中
 * 了一个尾部含空白的 span。此时收掉 span 的尾部空白，`old` / `new` 的语义就对称了：换行内容，行边界不动，
 * 行数不变。例外是收完就空（`old` 本身全是空白）——那种锚点没有内容可言，不该被"修"成删掉整行。
 *
 * 收的只是**尾部空白**：按行边界寻址的调用方（`lines` / `grep` 锚点，以及抄全整行块的 `old`）不受影响，
 * README 里"`new_text` 也要以换行结尾"的约定对那两条路径照旧。
 *
 * @param text - 逻辑文本（\n 行尾）。
 * @param old - 旧文本；以换行结尾表示调用方在按行边界寻址。
 * @param span - 宽松匹配给出的 `[start, end]` 字符区间。
 * @returns 该收就收过的区间。
 */
function clipFuzzySpan(text, old, span) {
  if (old.endsWith('\n')) return span
  let end = span[1]
  // 先收掉行尾空白；span 恰好落在换行符之后时，那个换行符也是这次宽松匹配顺手带上的。
  while (end > span[0] && (text[end - 1] === ' ' || text[end - 1] === '\t')) end -= 1
  if (end === span[0]) return span
  if (text[end - 1] === '\n') end -= 1
  return end > span[0] ? [span[0], end] : span
}

/**
 * 宽松匹配：滑窗比较归一化后的行块，相似度 ≥ 0.9 视为命中。
 *
 * 返回**全部**达标候选（相似度降序，同分按行号升序），不只挑最好的那一个：宽松命中的置信度本就低于精确
 * 命中，多处都能命中时"悄悄挑第一处"等于把决定权交给文件顺序——精确命中多于一处时本模块会拒绝写盘，
 * 宽松匹配没有理由更宽松。命中数由调用方用 `count` 确认。
 *
 * @param text - 逻辑文本。
 * @param old - 旧片段。
 * @param kind - 归一化方式（`trail` / `loose` / `ws`）。
 * @returns `[{ ratio, start, end }]`，无命中时为 `[]`。
 */
function relaxedMatches(text, old, kind) {
  const { lines } = splitLines(text)
  const oldLines = splitLines(old).lines
  if (oldLines.length === 0) return []
  const keys = lines.map((line) => normalizeLine(kind, line))
  const oldKeys = oldLines.map((line) => normalizeLine(kind, line))
  const n = oldKeys.length
  const starts = lineStarts(text)
  const found = []
  for (let i = 0; i + n <= lines.length; i += 1) {
    if (keys[i] !== oldKeys[0] || keys[i + n - 1] !== oldKeys[n - 1]) continue
    const ratio = similarity(keys.slice(i, i + n).join('\n'), oldKeys.join('\n'))
    if (ratio < 0.9) continue
    found.push({
      ratio,
      index: i,
      start: starts[i],
      end: i + n < starts.length ? starts[i + n] : text.length,
    })
  }
  found.sort((a, b) => b.ratio - a.ratio || a.start - b.start)
  return found
}

/** 失败时给最接近的几处（行号 + 相似度 + 期望 vs 实际）。 */
export function nearestCandidates(text, old, limit = 3) {
  const { lines } = splitLines(text)
  // `old` 为空时 `splitLines` 给不出候选行，退化成拿 `old` 自己当一行（否则下面的窗口宽度会是 0）。
  const oldLines = splitLines(old).lines
  const wanted = oldLines.length > 0 ? oldLines : [old]
  const n = wanted.length
  const firstKey = normalizeLine('loose', wanted[0])
  const scored = []
  for (let i = 0; i + n <= lines.length; i += 1) {
    const ratio = similarity(lines.slice(i, i + n).join('\n'), wanted.join('\n'))
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
      expected: wanted.slice(0, 12).join('\n'),
      actual: lines.slice(entry.index, Math.min(entry.index + n, lines.length)).slice(0, 12).join('\n'),
    }))
}

/**
 * 在 text 里定位 old：精确 → 宽松（`trail` / `loose` / `ws`）→ 失败时给最接近候选。
 *
 * 只有一个消歧旋钮：`expect`（声明的命中数）。没有"只取第 k 次出现"这类入口——那是**选择**而非**确认**，
 * 与"命中多处即拒绝、由调用方把锚点写准"的契约相反（此前的 `nth` 正因绕过它，才让错锚点变成静默的错编辑）。
 *
 * @param text - 逻辑文本。
 * @param old - 旧片段。
 * @param options - `expect`（要求恰好 N 处；不符即拒绝）。
 * @returns { ok, spans, mode, note, hits, candidates }
 */
export function matchLiteral(text, old, options = {}) {
  const { expect } = options
  // 空锚点必须**先**判：`findAllExact` 的 `from = index + max(1, 0)` 会在原地打转并撑爆内存，
  // 下面几条宽松路径也要先 `splitLines(old)`。空锚点没有内容可寻址。
  if (old === '') return { ok: false, spans: [], mode: 'miss', hits: [], note: 'old 不能为空', candidates: [] }
  const hits = findAllExact(text, old)
  if (expect !== undefined && hits.length === expect) {
    return { ok: true, spans: hits, mode: expect === 1 ? 'exact' : `exact:count(${expect})`, hits, note: expect === 1 ? '' : `命中 ${expect} 处，全部替换`, candidates: [] }
  }
  if (hits.length === 1) return { ok: true, spans: hits, mode: 'exact', hits, note: '', candidates: [] }
  if (hits.length > 1) {
    const starts = lineStarts(text)
    const where = hits.slice(0, 10).map(([s]) => offsetToLine(starts, s)).join('、')
    const reason = expect !== undefined
      ? `old 出现 ${hits.length} 次（行 ${where}），与要求的 ${expect} 次不符 —— 已拒绝写盘`
      : `old 出现 ${hits.length} 次（行 ${where}）—— 用 count 声明命中数，或写更长的 old 把范围收窄`
    return { ok: false, spans: [], mode: 'ambiguous', hits, note: reason, candidates: [] }
  }
  if (expect !== undefined) {
    return { ok: false, spans: [], mode: 'miss', hits, note: `old 精确出现 0 处，要求 ${expect} 处`, candidates: nearestCandidates(text, old) }
  }
  for (const [kind, label] of [['trail', '忽略行尾空白'], ['loose', '忽略行首/行尾空白'], ['ws', '忽略全部空白差异']]) {
    const found = relaxedMatches(text, old, kind)
    if (found.length === 0) continue
    if (found.length > 1) {
      // 宽松命中多于一处：与精确命中同样拒绝写盘，绝不按文件顺序悄悄挑一处。
      const starts = lineStarts(text)
      const where = found.slice(0, 8).map((entry) => offsetToLine(starts, entry.start)).join('、')
      return {
        ok: false,
        spans: [],
        mode: 'ambiguous',
        hits: found.map((entry) => [entry.start, entry.end]),
        note: `old 无法精确匹配；宽松模式（${label}）命中 ${found.length} 处（行 ${where}）——`
          + '请抄更长的 old 把范围收窄，或改用 lines / grep 锚点（宽松命中不做选择：没法保证挑中的是同一处）',
        candidates: nearestCandidates(text, old),
      }
    }
    // 锚点没写换行结尾、宽松命中却落在整行块上时，把行尾空白留给文件（见 clipFuzzySpan）。
    const best = found[0]
    const span = clipFuzzySpan(text, old, [best.start, best.end])
    const trimmed = span[1] !== best.end
    return {
      ok: true,
      spans: [span],
      mode: kind,
      hits,
      note: `精确匹配失败，已用宽松模式命中（${label}）—— 请核对改动是否落在预期位置`
        + (trimmed ? '；锚点没写换行结尾，行尾空白与换行符留在原地（否则会与下一行并成一行）' : ''),
      candidates: [],
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
 * 把"改动 op 的下标"按上下文并成 hunk（相邻改动之间不超过 2×context+1 就并进同一块），供
 * `unifiedDiff` 切片用。
 *
 * @param changeIndexes - `ops` 中非 `=` 的下标（升序）。
 * @param context - 每个 hunk 前后保留的上下文行数。
 * @returns 每个 hunk 的 op 下标区间（闭区间）。
 */
function changeRanges(changeIndexes, context) {
  const blocks = []
  for (const index of changeIndexes) {
    const last = blocks[blocks.length - 1]
    if (last && index - last[last.length - 1] <= context * 2 + 1) last.push(index)
    else blocks.push([index])
  }
  return blocks
}

/**
 * unified diff 文本；`label` 只用于 `a/` `b/` 头。与 GNU diff 一样标出"末尾没有换行"的那一侧。
 *
 * 输出不进入模型上下文，也不落盘：它是 `diffStat` 计算 `+N/-M` 的依据（行级 LCS 保证计数与真实改动一致）。
 * 保留它而不换成粗略的行数比较，是为了让统计行在多 hunk、重复行等情形下仍然准确。
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

  const blocks = changeRanges(changeIndexes, context)

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

// ─────────────────────────────────────────────────────────────────────────────
// 六、原子写、同目标串行
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 系统调用失败的**模型可读**表述。
 *
 * Node 原始 `error.message` 同时携带内部临时文件名（`.<名字>.<pid><ts>.tmp`）与绝对路径，二者都不该进入
 * 模型上下文，而且它不提供可操作信息。这里只保留 errno 与一句原因。
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
  const dot = basename(absPath).lastIndexOf('.')
  const ext = dot > 0 ? basename(absPath).slice(dot) : ''
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
    // 目标没有扩展名时（`ext === ''`）同扩展名那一档退化为"同样没有扩展名的兄弟文件"。
    if (ext !== '' && name.endsWith(ext)) {
      if (isCrlf) sameExtCrlf += 1
      else sameExtLf += 1
    } else if (ext === '' && !name.includes('.')) {
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
  return { path, ok: false, brief: '', stderr: message }
}

function hintText(match) {
  if (match.mode === 'ambiguous') {
    return `  候选：old 命中 ${match.hits.length} 处。用 count 声明命中数（全部替换），或写更长的 old 让命中唯一。`
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
 * 执行一次编辑 / 写入。后端无关：调用方只需给出归一后的 plan。
 *
 * plan（edit）：`{ kind:'edit', filePath, mode, newText, oldText, anchor:{value}|null, count }`；
 * plan（write）：`{ kind:'write', filePath, content }`。
 *
 * @param context - `{ root, newFileBom }`
 * @returns 规范结果 `{ path, ok, brief, stderr }`：`brief` 是模型可见的全部内容（一行统计加警告），
 *   `stderr` 是失败原因（失败时非空，同样模型可见）。
 */
export async function applyPlan(plan, context) {
  const { root, newFileBom = false } = context
  const absPath = isAbsolute(plan.filePath) ? resolve(plan.filePath) : resolve(root, plan.filePath)
  const label = relativeLabel(root, absPath)

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
      applied.push(['write', 1, Math.max(1, splitLines(output).lines.length), 'write', ''])
    } else {
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
        applied.push([plan.mode, 1, 1, plan.mode, ''])
      } else {
        const plans = []
        if (plan.mode === 'replace') {
          let match
          let anchorSpan
          // 行首下标表：多处命中要按行块换算成字符区间，单处命中要换算成行号。
          const charStarts = lineStarts(original)
          if (plan.anchor) {
            try {
              // `count` 必须传进来：`grep` 命中多处时报错原文就写着"用 count 声明命中数"。
              anchorSpan = resolveAnchor(plan.anchor.value, original, 0, plan.count)
            } catch (error) {
              return fail(plan.filePath, error instanceof UsageError ? error.message : String(error))
            }
            // 声明的多处命中逐处替换：`count` 已在上面校验过命中数，每一次命中都有自己的行块，拿它替换
            // 即可（把多个非相邻行块拼成一段文本去匹配只会得到"old 不存在"）。
            const blocks = anchorSpan.blocks ?? []
            match = blocks.length > 1
              ? {
                ok: true,
                spans: blocks.map((block) => [
                  charStarts[block.start - 1],
                  block.end < charStarts.length ? charStarts[block.end] : original.length,
                ]),
                mode: `exact:count(${plan.count})`,
                hits: [],
                note: '',
                candidates: [],
              }
              : matchLiteral(original, anchorSpan.raw, {})
            if (match.ok) match.mode = match.mode.startsWith('exact:count(') ? match.mode : `anchor:${match.mode}`
          } else {
            match = matchLiteral(original, plan.oldText ?? '', { expect: plan.count })
          }
          if (!match.ok) {
            return fail(plan.filePath, `${label}：${match.note}\n${hintText(match)}`)
          }
          // 锚点路径的 mode 带 `anchor:` 前缀；去掉它之后，"是不是精确命中"才可判。
          const hitMode = String(match.mode).replace(/^anchor:/, '')
          // 不拿 `match.hits.length` 比 `plan.count`：`count` 的校验各有其主——`grep` / `lines` 由
          // `resolveAnchor` 在命中处校验，`old_text` 由 `matchLiteral` 的 `expect` 校验。锚点路径的
          // hits 是"锚点文本在全文出现几次"，逐处替换时天然为 1，拿它比 `count` 只会把正当的多处替换
          // 误判成失败。
          for (const [start, end] of match.spans) {
            const startLine = offsetToLine(charStarts, start)
            const endLine = end > start ? offsetToLine(charStarts, end - 1) : startLine
            plans.push({ start, end, mode: hitMode, startLine, endLine })
          }
          // 只通报宽松命中：`exact` 与 `exact:count(N)` 带的是"命中 N 处，全部替换"这类说明，不是警告。
          if (hitMode !== 'exact' && !hitMode.startsWith('exact:count(')) {
            warnings.push(`[warn] ${match.note}`)
          }
          // 锚点带着行尾换行符、替换文本却没有：被换掉的那一行会和下一行并成一行。只对 `old_text` 说
          // 这一句——`lines`/`grep` 是调用方点名要的整行行块，README 已把"`new_text` 也要以换行结尾"
          // 写成前置约定，每次调用都重复提示只是噪声；而抄来的 `old_text` 带着换行、`new_text` 忘了带
          // 换行时，`+1/-2` 说明不了"少了一行"。
          if (plan.anchor === null && match.spans.length === 1 && match.spans[0][1] > match.spans[0][0]
            && original.startsWith('\n', match.spans[0][1] - 1)
            && plan.newText !== '' && !plan.newText.endsWith('\n')) {
            warnings.push('[warn] 锚点以换行结尾，替换文本没有——被换的那一行已与下一行并成一行；'
              + '要保留行边界，让 new_text 也以换行结尾')
          }
        } else {
          let anchorSpan
          try {
            // `count` 同样要传：声明了命中行数就与 `replace` 档一样校验，不能悄悄忽略。
            anchorSpan = resolveAnchor(plan.anchor.value, original, 0, plan.count)
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

        // 按 `start` 升序把原文的"间隙"与替换文本拼起来。逐段推进游标，不做任何坐标换算——先前的
        // "从后往前替换 + 位移修正"等价于这里的一次遍历，却要在每处替换后重算下标，容易写错。
        const ordered = [...plans].sort((a, b) => a.start - b.start)
        const parts = []
        let cursor = 0
        for (const item of ordered) {
          parts.push(original.slice(cursor, item.start), plan.newText)
          cursor = item.end
          applied.push(['replace', item.startLine, item.endLine, item.mode, ''])
        }
        parts.push(original.slice(cursor))
        output = parts.join('')
      }
    }

    if (output === original && exists) {
      return fail(plan.filePath, '没有产生任何变化（old 与 new 相同，或内容已一致）')
    }

    const stat = diffStat(original, output)
    const created = !exists
    const kinds = [...new Set(applied.map(([k, s, e]) => (k === 'replace' ? `replace@${s}${e !== s ? `-${e}` : ''}` : k)))]
      .join('、')

    if (created) {
      try {
        ensureParentDir(absPath, root)
      } catch (error) {
        return fail(plan.filePath, ioFailure('创建目录', label, error))
      }
    }

    try {
      writeFileAtomic(absPath, encodeText(output, info))
    } catch (error) {
      return fail(plan.filePath, ioFailure('写入目标', label, error))
    }

    // 模型可见文本：警告行 + 一行统计（如 `replace@17 +1/-1`）。不回显改动内容（理由见文件头）。
    const brief = [...warnings, `${kinds} +${stat.added}/-${stat.removed}`].join('\n')
    return { path: plan.filePath, ok: true, brief, stderr: '' }
  })
}
