// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * selftest.mjs —— `lib/` 的端到端自测（不需要 dsh 会话）。
 *
 * 六层断言：
 *   * 共享行为 —— 通过 `applyPlan` 直接跑核心（BOM/行尾保真、锚点、匹配、count、歧义拒写）；
 *   * Node 独有保证 —— 路径护栏、二进制/非法 UTF-8 拒写、多数派行尾推断、多 hunk、并发不撕裂、
 *     新建时补齐父目录、系统调用失败只报 errno；
 *   * 插件层 —— 用假 ctx 走一遍 `lib/editor.mjs` 的 `apply()`：工具注册、引导段、
 *     参数校验、**返回值与 `OUTPUT_SCHEMA` 一致**、`render()` 文本，以及 config
 *     （`root` / `backup` / `ledger` / `newFileBom`）的透传。这一层是宿主真正调用的入口，必须被测到，
 *     否则 schema 与返回值脱节也只能等线上发现；
 *   * 返回值约束 —— 模型可见文本的构成本身是被断言对象：无论输入多大，成功路径固定为 `WROTE`
 *     加一行统计，不含改动内容，**也不重复路径**。这是工具契约的一部分，因此需要回归测试；
 *   * 呈现层 —— `presentCall` / `presentationMeta` / `presentResult` 的形状、投影与降级：
 *     宿主在实时渲染与日志回放两条路径上都调用它们，抛异常就会被降级成通用卡片；
 *   * 会话文件策略 —— `read-only` 下两个工具在任何 I/O 之前拒写，且不误伤其它模式。
 *
 * 实现全部是进程内 Node（不启动子进程、无外部运行时），所以自测本身也只依赖 Node。
 *
 * 用法：
 *   node tools/selftest.mjs
 * 退出码：0 = 全过，1 = 有失败。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { apply as applyMask } from '../lib/mask.mjs'

import { applyPlan } from '../lib/core.mjs'
import { OUTPUT_SCHEMA, apply, planEdit, planWrite } from '../lib/editor.mjs'

let checks = 0
let failures = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log('PASS  ' + label)
    return
  }
  failures += 1
  console.log('FAIL  ' + label + (detail === undefined ? '' : '\n      ' + String(detail).replace(/\n/g, '\n      ')))
}

function bomOf(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

function countCrlf(bytes) {
  let count = 0
  for (let i = 1; i < bytes.length; i += 1) if (bytes[i] === 0x0a && bytes[i - 1] === 0x0d) count += 1
  return count
}

function countLf(bytes) {
  let count = 0
  for (const byte of bytes) if (byte === 0x0a) count += 1
  return count
}

function writeSample(path, lines) {
  writeFileSync(path, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'),
  ]))
}

function makeWorkspace(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 工具返回值必须**恰好**满足 `OUTPUT_SCHEMA`：宿主按它校验，schema 与实现脱节就是线上故障。
 * （`additionalProperties: false`：多一个字段、少一个字段、类型不对都算失败。）
 *
 * 类型判定覆盖本 schema 用到的三种写法：`type`（含 `array`）、`oneOf`（可空字符串）。
 */
function valueMatchesSpec(value, spec) {
  if (Array.isArray(spec.oneOf)) return spec.oneOf.some((branch) => valueMatchesSpec(value, branch))
  if (spec.type === 'array') return Array.isArray(value)
  if (spec.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return typeof value === spec.type
}

function assertShape(label, value) {
  const allowed = new Set(Object.keys(OUTPUT_SCHEMA.properties))
  const missing = OUTPUT_SCHEMA.required.filter((key) => !(key in value))
  const extra = Object.keys(value).filter((key) => !allowed.has(key))
  const wrong = Object.entries(OUTPUT_SCHEMA.properties)
    .filter(([key, spec]) => key in value && !valueMatchesSpec(value[key], spec))
    .map(([key]) => key)
  check(label, missing.length === 0 && extra.length === 0 && wrong.length === 0, `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} wrongType=${JSON.stringify(wrong)}`)
}

/** 核心共享断言：BOM / 行尾 / 锚点 / count / 歧义拒写。 */
async function sharedSuite(runner) {
  const { ws, edit, write } = runner
  const sample = join(ws, 'sample.md')
  writeSample(sample, ['alpha', 'beta', 'gamma'])
  {
    const bytes = readFileSync(sample)
    check('setup: BOM + CRLF sample', bomOf(bytes) && countCrlf(bytes) === 3, `bom=${bomOf(bytes)} crlf=${countCrlf(bytes)}`)
  }

  {
    const result = await edit({ file_path: 'sample.md', grep: '^gamma', new_text: 'gamma patched\n' })
    const bytes = readFileSync(sample)
    const text = readFileSync(sample, 'utf8')
    check('edit(grep): ok', result.ok, result.stderr)
    check('edit(grep): BOM preserved', bomOf(bytes))
    check('edit(grep): CRLF preserved', countCrlf(bytes) === 3, `crlf=${countCrlf(bytes)} lf=${countLf(bytes)}`)
    check('edit(grep): content replaced', text.includes('gamma patched'))
    check('edit(grep): brief is one stat line', result.brief === 'replace@3 +1/-1', JSON.stringify(result.brief))
  }

  {
    const result = await edit({ file_path: 'sample.md', old_text: 'beta\ngamma patched', new_text: 'beta\ngamma again' })
    const bytes = readFileSync(sample)
    check('edit(old_text): ok', result.ok, result.stderr)
    check('edit(old_text): BOM + CRLF preserved', bomOf(bytes) && countCrlf(bytes) === 3)
    check('edit(old_text): content replaced', readFileSync(sample, 'utf8').includes('gamma again'))
  }

  {
    const result = await edit({ file_path: 'sample.md', lines: '1', new_text: 'line one replaced\n' })
    const first = readFileSync(sample, 'utf8').split(/\r?\n/)[0].replace(/^\ufeff/, '')
    check('edit(lines): ok', result.ok, result.stderr)
    check('edit(lines): first line replaced', first === 'line one replaced', JSON.stringify(first))
  }

  {
    const result = await edit({ file_path: 'sample.md', mode: 'after', grep: '^line one replaced', new_text: 'inserted line\n' })
    const lines = readFileSync(sample, 'utf8').split(/\r?\n/)
    check('edit(after): ok', result.ok, result.stderr)
    check('edit(after): inserted after anchor', lines[1] === 'inserted line', JSON.stringify(lines.slice(0, 3)))
  }

  {
    await write({ file_path: 'amb.md', content: 'twin\ntwin\nother\n' })
    const result = await edit({ file_path: 'amb.md', old_text: 'twin', new_text: 'x' })
    const detail = result.brief + '\n' + result.stderr
    check('edit(ambiguous): refuses to write', !result.ok, JSON.stringify(result))
    check('edit(ambiguous): explains the count escape hatch', /count/.test(detail), detail)
    const forced = await edit({ file_path: 'amb.md', old_text: 'twin', new_text: 'x', count: 2 })
    const lines = readFileSync(join(ws, 'amb.md'), 'utf8').split(/\r?\n/)
    check('edit(count=2): replaces every occurrence', forced.ok && lines[0] === 'x' && lines[1] === 'x', JSON.stringify(lines))
  }
  {
    // `count` 在三条路径上是一个意思：声明期望命中数，不符即拒绝（此前 `grep` / `lines` 完全忽略它，
    // 而 `grep` 的报错原文恰恰在建议"用 count 声明命中数"）。
    await write({ file_path: 'count-grep.md', content: 'k=1\nk=2\nk=3\n' })
    const linesBefore = readFileSync(join(ws, 'count-grep.md'), 'utf8').split('\n').length
    const ok = await edit({ file_path: 'count-grep.md', grep: '^k=', count: 3, new_text: 'K=a\nK=b\nK=c\n' })
    const after = readFileSync(join(ws, 'count-grep.md'), 'utf8')
    check('edit(grep + count=3): ok and every hit replaced', ok.ok && /K=a/.test(after) && /K=b/.test(after) && /K=c/.test(after) && !/k=\d/.test(after), JSON.stringify(after))
    check('edit(grep + count=3): the line count is unchanged', after.split('\n').length === linesBefore, JSON.stringify(after))

    await write({ file_path: 'count-lines.md', content: 'k=1\nk=2\nk=3\n' })
    const seedLines = readFileSync(join(ws, 'count-lines.md'), 'utf8').split('\n').length
    const wrong = await edit({ file_path: 'count-lines.md', lines: '1:2', count: 9, new_text: 'x\n' })
    check('edit(lines + count=9): a mismatched declaration refuses', !wrong.ok && /count=9/.test(wrong.stderr), wrong.stderr)
    check('edit(lines + count mismatch): the file is untouched',
      readFileSync(join(ws, 'count-lines.md'), 'utf8').split('\n').length === seedLines && !readFileSync(join(ws, 'count-lines.md'), 'utf8').includes('x'), 'the file changed')

    await write({ file_path: 'count-lines-b.md', content: 'k=1\nk=2\nk=3\n' })
    const right = await edit({ file_path: 'count-lines-b.md', lines: '1:2', count: 2, new_text: 'a\nb\n' })
    check('edit(lines + count=2): a matching declaration replaces the block',
      right.ok && readFileSync(join(ws, 'count-lines-b.md'), 'utf8').replace(/\r\n/g, '\n') === 'a\nb\nk=3\n',
      JSON.stringify(right.brief))

    await write({ file_path: 'count-grep-na.md', content: 'k=1\nk=2\nk=3\n' })
    const noCount = await edit({ file_path: 'count-grep-na.md', grep: '^k=', new_text: 'x\n' })
    check('edit(grep, no count): several hits still refuse', !noCount.ok, noCount.brief || noCount.stderr)
  }

  {
    const result = await write({ file_path: 'sample.md', content: 'one\ntwo\n' })
    const bytes = readFileSync(sample)
    check('write(overwrite): ok', result.ok, result.stderr)
    check('write(overwrite): BOM preserved', bomOf(bytes))
    check('write(overwrite): CRLF preserved', countCrlf(bytes) === 2, `crlf=${countCrlf(bytes)}`)
  }

  {
    const result = await write({ file_path: 'fresh.md', content: 'fresh one\nfresh two\n' })
    const path = join(ws, 'fresh.md')
    const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
    check('write(create): ok', result.ok, result.stderr)
    check('write(create): file created', bytes.length > 0)
    check('write(create): no BOM by default', bomOf(bytes) === false)
  }

  {
    mkdirSync(join(ws, 'crlf-dir'), { recursive: true })
    writeSample(join(ws, 'crlf-dir', 'peer.md'), ['peer line'])
    const result = await write({ file_path: 'crlf-dir/new.md', content: 'fresh one\nfresh two\n' })
    const path = join(ws, 'crlf-dir', 'new.md')
    const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
    check('write(create in a CRLF dir): ok', result.ok, result.stderr)
    check('write(create in a CRLF dir): CRLF followed', countCrlf(bytes) === 2, `crlf=${countCrlf(bytes)} lf=${countLf(bytes)}`)
  }
}

/** Node 独有：护栏、二进制/非法编码、多数派行尾、锚点边界、并发。 */
async function nodeOnlySuite(ws) {
  const run = async (args) => await applyPlan(planEdit(args), { root: ws })
  const write = async (args) => await applyPlan(planWrite(args), { root: ws })

  {
    // 本包没有路径护栏（见 lib/core.mjs 第二段）：`.dsh/` 内部照写——真实场景里那是"编辑自己的
    // 备份/台账/被 `.dsh/` 覆盖的仓库文件"这一类需求，禁掉它比放开它的代价更大。
    mkdirSync(join(ws, '.dsh'), { recursive: true })
    writeFileSync(join(ws, '.dsh', 'scratch.md'), 'x\n')
    const result = await run({ file_path: '.dsh/scratch.md', old_text: 'x', new_text: 'y' })
    check('no guard: .dsh/ targets are editable', result.ok && readFileSync(join(ws, '.dsh', 'scratch.md'), 'utf8') === 'y\n', result.stderr)
  }
  {
    // 工作区之外、相对路径 `.\\..\\` 与中文文件名：lib/ 里那条真实使用路径的回归。
    const outsideDir = join(dirname(ws), `外部-${basename(ws)}`)
    mkdirSync(outsideDir, { recursive: true })
    const outside = join(outsideDir, '外部-文件.md')
    writeFileSync(outside, '一行\n')
    const result = await run({ file_path: `../${basename(outsideDir)}/外部-文件.md`, old_text: '一行', new_text: '两行' })
    check('no guard: paths outside the workspace are editable', result.ok && readFileSync(outside, 'utf8') === '两行\n', result.stderr)
    check('a path outside the workspace lands in the ledger as an absolute path',
      readFileSync(join(ws, '.dsh', 'edits.log'), 'utf8').includes(outside.replace(/\\/g, '\\\\')))
  }
  {
    writeFileSync(join(ws, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42, 0x0a]))
    const result = await run({ file_path: 'binary.bin', grep: 'A', new_text: 'Z\n' })
    check('refuses binary content (NUL)', !result.ok && /二进制/.test(result.stderr), result.stderr)
  }
  {
    writeFileSync(join(ws, 'broken.md'), Buffer.from([0x41, 0xc3, 0x28, 0x0a]))
    const result = await run({ file_path: 'broken.md', grep: 'A', new_text: 'Z\n' })
    check('refuses invalid UTF-8', !result.ok && /UTF-8/.test(result.stderr), result.stderr)
  }
  {
    // 新文件行尾跟随"多数派"（同扩展名优先）
    const dir = join(ws, 'majority')
    mkdirSync(dir, { recursive: true })
    writeSample(join(dir, 'a.md'), ['a'])
    writeSample(join(dir, 'b.md'), ['b'])
    writeFileSync(join(dir, 'c.md'), 'c\n')
    const result = await write({ file_path: 'majority/new.md', content: 'x\ny\n' })
    const bytes = readFileSync(join(dir, 'new.md'))
    check('new-file EOL follows the sibling majority', result.ok && countCrlf(bytes) === 2, `crlf=${countCrlf(bytes)} lf=${countLf(bytes)}`)
  }
  {
    writeFileSync(join(ws, 'multi.md'), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n')
    const result = await run({ file_path: 'multi.md', grep: '^b', new_text: 'B\n' })
    check('a single-line change reports one replace@ line', result.ok && result.brief === 'replace@2 +1/-1', JSON.stringify(result.brief))
  }
  {
    writeFileSync(join(ws, 'two-far.md'), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\n')
    const first = await run({ file_path: 'two-far.md', grep: '^b', new_text: 'B\n' })
    const second = await run({ file_path: 'two-far.md', grep: '^q', new_text: 'Q\n' })
    check('distant changes are applied independently', first.ok && second.ok, first.stderr + second.stderr)
  }
  {
    writeFileSync(join(ws, 'noeol.md'), 'tail without newline')
    const result = await run({ file_path: 'noeol.md', old_text: 'tail without newline', new_text: 'now with newline\n' })
    const text = readFileSync(join(ws, 'noeol.md'), 'utf8')
    check('end-of-file newline change is accepted', result.ok, result.stderr)
    check('end-of-file newline change written', text === 'now with newline\n', JSON.stringify(text))
  }
  {
    // 并发写同一文件：进程内串行 + 原子写，绝不出现半截内容
    writeFileSync(join(ws, 'concurrent.md'), 'seed\n')
    const jobs = []
    for (let i = 0; i < 8; i += 1) jobs.push(write({ file_path: 'concurrent.md', content: `value ${i}\n` }))
    const results = await Promise.all(jobs)
    const text = readFileSync(join(ws, 'concurrent.md'), 'utf8')
    check('concurrent writes all settle', results.every((result) => result.ok), JSON.stringify(results.map((r) => r.ok)))
    check('concurrent writes never tear the file', /^value [0-7]\n$/.test(text), JSON.stringify(text))
  }
  {
    const result = await run({ file_path: 'nope.md', grep: 'x', new_text: 'y\n' })
    check('editing a missing file is refused', !result.ok && /不存在/.test(result.stderr), result.stderr)
  }
  {
    writeFileSync(join(ws, 'miss.md'), 'alpha\nbeta\ngamma\n')
    const result = await run({ file_path: 'miss.md', old_text: 'beta\ngamaa', new_text: 'x\n' })
    check('a miss reports nearest candidates', !result.ok && /最接近/.test(result.stderr), result.stderr)
  }
  {
    writeFileSync(join(ws, 'relaxed.md'), 'keep   trailing\nnext line\n')
    const result = await run({ file_path: 'relaxed.md', old_text: 'keep trailing\nnext line', new_text: 'untouched\n' })
    check('a relaxed match is announced in the brief', result.ok && /宽松/.test(result.brief), result.brief || result.stderr)
  }
  {
    // 宽松命中的 span 是整行块：锚点没写换行结尾时，行尾空白与换行符必须留在文件里，
    // 否则替换会吃掉换行、把下一行并进来——改一行变成删一行，而模型看不出哪里写错了。
    writeFileSync(join(ws, 'fuzzy-eol.md'), 'alpha\n   BBBB\ncccc\ndddd\n')
    const result = await run({ file_path: 'fuzzy-eol.md', old_text: '  BBBB   ', new_text: 'X' })
    const text = readFileSync(join(ws, 'fuzzy-eol.md'), 'utf8')
    check('a relaxed hit stays inside its own line', result.ok && text === 'alpha\nX\ncccc\ndddd\n', JSON.stringify(text))
    check('a relaxed hit keeps the file line count', text.split('\n').length === 5, JSON.stringify(text))
    check('the eol repair is stated in the brief', /行尾空白与换行符留在原地/.test(result.brief), result.brief)
  }
  {
    // 宽松命中在两处都成立时，绝不按文件顺序悄悄挑第一处：与精确命中同样拒绝写盘。
    const seed = 'alpha\n   BBBB\ncccc\n   BBBB\ndddd\n'
    writeFileSync(join(ws, 'fuzzy-ambiguous.md'), seed)
    const result = await run({ file_path: 'fuzzy-ambiguous.md', old_text: '  BBBB   ', new_text: 'X' })
    check('a relaxed hit matching twice is refused', !result.ok && /宽松模式/.test(result.stderr), result.stderr)
    check('a refused relaxed hit leaves the file untouched', readFileSync(join(ws, 'fuzzy-ambiguous.md'), 'utf8') === seed)
  }
  {
    // 锚点带换行、替换文本不带：行会被并起来（README 的既有约定），但要说出来。
    writeFileSync(join(ws, 'eol-merge.md'), 'alpha\n   BBBB\ncccc\n')
    const result = await run({ file_path: 'eol-merge.md', old_text: 'BBBB\n', new_text: 'X' })
    check('a line-absorbing replacement is announced', result.ok && /并成一行/.test(result.brief), result.brief || result.stderr)
  }
  {
    const result = await run({ file_path: 'sample.md', grep: '^one$', new_text: 'one\n' })
    check('a no-change edit is refused', !result.ok && /没有产生任何变化/.test(result.stderr), result.stderr)
  }
  {
    // 新建空文件：`content: ''` 配一个不存在的目标 = 创建一个零字节文件（与原生 write 一致）。
    // 曾经这条被当成"没有产生任何变化"拒绝，而"先建个空文件再往里写"是很常见的起手式。
    const empty = join(ws, 'zero-byte.txt')
    const result = await write({ file_path: 'zero-byte.txt', content: '' })
    check('write(create) with empty content creates a zero-byte file', result.ok && existsSync(empty) && readFileSync(empty).length === 0, result.stderr || JSON.stringify(result))
    check('write(create) with empty content reports the change', result.brief === 'write +0/-0', JSON.stringify(result.brief))
    check('write(create) with empty content fills in missing parents',
      (await write({ file_path: 'deep/nested/empty.txt', content: '' })).ok && existsSync(join(ws, 'deep', 'nested', 'empty.txt')))
    const again = await write({ file_path: 'zero-byte.txt', content: '' })
    check('write(overwrite) with empty content on an empty file is still a no-op', !again.ok && /没有产生任何变化/.test(again.stderr), again.stderr)
  }

  {
    // 新建时补齐缺失的父目录（原生 write 也这么做），且不为此多说一句
    const result = await write({ file_path: 'deep/nested/fresh.md', content: 'a\nb\n' })
    check(
      'write(create) fills in missing parent directories',
      result.ok && existsSync(join(ws, 'deep', 'nested', 'fresh.md')),
      result.stderr || JSON.stringify(result),
    )
    check('write(create) keeps the brief to one stat line', result.brief === 'write +2/-0', JSON.stringify(result.brief))
    check(
      'write(create) returns the documented fields, model channel plus presentation payload',
      Object.keys(result).sort().join(',') === 'brief,hunks,hunksTruncated,ok,operation,path,stderr',
      Object.keys(result).join(','),
    )
    check(
      'write(create) marks the operation and offers a whole-file hunk',
      result.operation === 'create' && result.hunks.length === 1 && result.hunks[0].oldText === null && result.hunks[0].newText === 'a\nb\n',
      JSON.stringify(result.hunks),
    )
  }
  {
    // 系统调用失败：只给 errno 说法；内部临时文件名（.<名字>.<pid><ts>.tmp）绝不出现在原因里
    mkdirSync(join(ws, 'adir'), { recursive: true })
    const result = await run({ file_path: 'adir', grep: 'x', new_text: 'y\n' })
    check(
      'a directory target fails with a clean errno reason',
      !result.ok && /EISDIR/.test(result.stderr) && !result.stderr.includes('.tmp'),
      result.stderr,
    )
  }
  {
    writeFileSync(join(ws, 'blocker'), 'not a directory\n')
    const result = await write({ file_path: 'blocker/child.md', content: 'x\n' })
    check(
      'a file in the middle of the path fails with a clean errno reason',
      !result.ok && /ENOTDIR/.test(result.stderr) && !result.stderr.includes('.tmp'),
      result.stderr,
    )
  }
}

/** 插件层：用假 ctx 走 `apply()` —— 宿主真正调用的入口（注册、校验、结果形状、render、config）。 */
async function pluginSuite() {
  const ws = makeWorkspace('dsh-selftest-plugin-')
  const registered = []
  const sections = []
  apply(
    { systemPrompt: { section: (value) => sections.push(value) }, tools: { register: (value) => registered.push(value) } },
    { root: ws },
  )

  const byName = new Map(registered.map((tool) => [tool.name, tool]))
  const editTool = byName.get('edit_text')
  const writeTool = byName.get('write_text')
  check(
    'plugin: registers exactly edit_text and write_text',
    registered.length === 2 && editTool !== undefined && writeTool !== undefined,
    JSON.stringify(registered.map((tool) => tool.name)),
  )
  check('plugin: both tools carry the shared output schema', editTool?.output?.schema === OUTPUT_SCHEMA && writeTool?.output?.schema === OUTPUT_SCHEMA)
  check('plugin: both tools declare a timeout', editTool?.timeoutMs > 0 && writeTool?.timeoutMs > 0)
  check(
    'plugin: guidance section is registered with the documented identity',
    sections.length === 1 && sections[0].name === 'tool:edit_text' && sections[0].order === 116,
    JSON.stringify(sections.map((section) => [section.name, section.order])),
  )
  check(
    'plugin: guidance names both tools and has no template braces',
    sections[0].text.includes('edit_text') && sections[0].text.includes('write_text') && !sections[0].text.includes('{{'),
  )

  const exec = { agent: { session: { header: { cwd: ws } } } }
  writeSample(join(ws, 'plugin.md'), ['alpha', 'beta', 'gamma'])
  const originalSample = readFileSync(join(ws, 'plugin.md'))
  {
    const result = await editTool.execute({ file_path: 'plugin.md', grep: '^beta', new_text: 'BETA\n' }, exec)
    assertShape('plugin: edit_text result matches OUTPUT_SCHEMA', result)
    const bytes = readFileSync(join(ws, 'plugin.md'))
    check(
      'plugin: edit_text writes into the session workspace (BOM + CRLF kept)',
      result.ok === true && bomOf(bytes) && countCrlf(bytes) === 3,
      JSON.stringify(result),
    )
    const rendered = editTool.output.render({}, result)
    check(
      'plugin: success render is WROTE plus one stat line, and never echoes the path or the change',
      rendered[0].text === 'WROTE\nreplace@2 +1/-1',
      rendered[0].text,
    )

    // 默认配置（backup/ledger 都开）必须真的留下产出物，且备份与改动前逐字节相同
    const backups = existsSync(join(ws, '.dsh', 'backups')) ? readdirSync(join(ws, '.dsh', 'backups')) : []
    check(
      'plugin: default config writes a backup of the previous bytes',
      backups.length === 1 && readFileSync(join(ws, '.dsh', 'backups', backups[0])).equals(originalSample),
      JSON.stringify(backups),
    )
    const ledgerPath = join(ws, '.dsh', 'edits.log')
    const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
    const record = ledger[ledger.length - 1] ?? {}
    check(
      'plugin: default config appends a ledger record with the documented fields',
      ledger.length === 1 && record.tool === 'edit_text' && record.file === 'plugin.md' && record.bom === true && record.eol === 'CRLF' && record.backup === backups[0],
      JSON.stringify(record),
    )
  }
  {
    // 用法错误必须是**工具结果**（不是抛异常），否则注册表会把会话弄崩
    const result = await editTool.execute({ file_path: 'plugin.md', new_text: 'x' }, exec)
    assertShape('plugin: usage-error result matches OUTPUT_SCHEMA', result)
    check('plugin: a usage error is a result, not a throw', result.ok === false && /anchor/.test(result.stderr), result.stderr)
    check('plugin: failure render says FAIL without echoing the path', editTool.output.render({}, result)[0].text.startsWith('FAIL\n'))
    check('plugin: failure render keeps the reason', editTool.output.render({}, result)[0].text.includes('anchor'))
  }
  rmSync(ws, { recursive: true, force: true })

  // config 透传：newFileBom / backup+ledger / 没有 agent 会话时的 root 回退
  const configWs = makeWorkspace('dsh-selftest-config-')
  const configured = []
  apply(
    { systemPrompt: { section: () => {} }, tools: { register: (value) => configured.push(value) } },
    { root: configWs, newFileBom: true, backup: false, ledger: false },
  )
  const writeConfigured = configured.find((tool) => tool.name === 'write_text')
  const created = await writeConfigured.execute({ file_path: 'fresh.md', content: 'a\nb\n' }, {})
  const createdBytes = existsSync(join(configWs, 'fresh.md')) ? readFileSync(join(configWs, 'fresh.md')) : Buffer.alloc(0)
  check('plugin: config.root is the fallback workspace when exec has no session', created.ok === true, JSON.stringify(created))
  check('plugin: config.newFileBom=true writes a BOM on create', bomOf(createdBytes), JSON.stringify(createdBytes.toString('utf8')))
  check('plugin: config.backup=false + ledger=false leave no artifacts', !existsSync(join(configWs, '.dsh')))
  rmSync(configWs, { recursive: true, force: true })
}

/**
 * 返回值约束：模型可见文本的构成。
 *
 * 契约只有两条：成功是 `WROTE` 加**一行统计**（不回显改动内容），失败是 `FAIL` 加完整原因。
 * 这里把"任何规模的改动都不回显"钉成断言——旧实现曾把整文件 diff 当成结果正文，长行的改动甚至
 * 以 1.0x 的放大率原样进入上下文。
 *
 * 另加一条：**不回显路径**。结果与调用一一绑定（`tool/result` 带 `source.callId`），调用参数里的
 * `file_path` 就在同一轮历史里，逐字回显它新信息量为零（实测占成功结果字节的 48%）。路径该出现的
 * 地方有两处，都在本文件里断言：失败**原因**要指名文件时自己带上（见下），以及呈现通道的卡片
 * （见 `presentationSuite`）。
 */
async function resultTextSuite() {
  const ws = makeWorkspace('dsh-selftest-result-')
  const registered = []
  apply(
    { systemPrompt: { section: () => {} }, tools: { register: (value) => registered.push(value) } },
    { root: ws },
  )
  const byName = new Map(registered.map((tool) => [tool.name, tool]))
  const editTool = byName.get('edit_text')
  const writeTool = byName.get('write_text')
  const exec = { agent: { session: { header: { cwd: ws } } } }
  const textOf = (tool, result) => tool.output.render({}, result)[0].text

  const big = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the big file`).join('\n') + '\n'

  // 1) 整文件新建：模型可见文本只有两行，且不含文件内容
  const created = await writeTool.execute({ file_path: 'big.txt', content: big }, exec)
  const createdText = textOf(writeTool, created)
  check(
    'result: a large write does not echo the content back',
    !createdText.includes('line 30 of the big file') && createdText === 'WROTE\nwrite +60/-0',
    createdText,
  )
  check('result: the rendered text never repeats the path', !createdText.includes('big.txt'), createdText)

  // 2) 小改动同样是两行
  writeSample(join(ws, 'small.txt'), ['alpha', 'beta', 'gamma'])
  const small = await editTool.execute({ file_path: 'small.txt', grep: '^beta', new_text: 'BETA\n' }, exec)
  const smallText = textOf(editTool, small)
  check('result: a small edit reports the stat line only', smallText === 'WROTE\nreplace@2 +1/-1', smallText)
  check(
    'result: no diff body, no backup name, no change content, no path',
    !smallText.includes('BETA') && !smallText.includes('beta') && !smallText.includes('备份') && !smallText.includes('small.txt'),
    smallText,
  )

  // 3) 长行：压缩为单行的文件曾经整篇进入上下文，现在与文件大小无关
  const longLine = 'const blob = "' + 'x'.repeat(20000) + '"'
  const longWrite = await writeTool.execute({ file_path: 'min.js', content: longLine + '\n' }, exec)
  const longText = textOf(writeTool, longWrite)
  check(
    'result: a single 20 KB line is not echoed',
    longText === 'WROTE\nwrite +1/-0' && Buffer.byteLength(longText, 'utf8') < 32,
    `${Buffer.byteLength(longText, 'utf8')} B\n${longText}`,
  )

  // 4) 宽文件（行数少、行长）同样不回显
  const wide = Array.from({ length: 20 }, (_, i) => `L${i} ${'y'.repeat(5000)}`).join('\n') + '\n'
  const wideText = textOf(writeTool, await writeTool.execute({ file_path: 'wide.txt', content: wide }, exec))
  check('result: 20 lines x 5 KB is not echoed', wideText === 'WROTE\nwrite +20/-0', wideText)

  // 5) 一次调用回吐的字节与输入规模无关：这是本契约的核心
  const hugeText = textOf(writeTool, await writeTool.execute({ file_path: 'huge.txt', content: 'z'.repeat(400000) + '\n' }, exec))
  check(
    'result: a 400 KB write still returns a two-line result',
    hugeText === 'WROTE\nwrite +1/-0',
    `${Buffer.byteLength(hugeText, 'utf8')} B\n${hugeText}`,
  )

  // 6) 失败路径相反：原因必须完整；要指名文件时由**原因**自己带（不是表头回显）
  const missing = await editTool.execute({ file_path: 'nope.md', grep: 'x', new_text: 'y\n' }, exec)
  const failText = textOf(editTool, missing)
  check(
    'result: a failure keeps the full reason',
    failText.startsWith('FAIL\n') && failText.includes('目标不存在：nope.md'),
    failText,
  )

  // 7) 呈现通道拿到了模型通道刻意丢弃的东西：文件身份与真正的改动
  const meta = editTool.output.presentationMeta({ file_path: 'small.txt' }, small)
  const metaBytes = Buffer.byteLength(JSON.stringify(meta), 'utf8')
  check(
    'result: the card carries the path and the applied hunk instead of the model text',
    meta.title === 'Edit small.txt' && meta.diffs.length === 1 && meta.diffs[0].newText.includes('BETA'),
    JSON.stringify(meta),
  )
  check('result: the card payload stays small for a one-line edit', metaBytes < 256, `${metaBytes} B`)

  rmSync(ws, { recursive: true, force: true })
}

/**
 * 呈现层契约：三个 presenter 都是宿主在**实时渲染与日志回放**两条路径上调用的纯函数。
 *
 * 抛异常只会被 api-proxy 捕获并降级成通用卡片（等于这段功能白写），所以这里既断言形状，也断言
 * "畸形输入不抛异常、返回 undefined 或空 diffs"这类降级行为。
 */
async function presentationSuite() {
  const ws = makeWorkspace('dsh-selftest-present-')
  const registered = []
  apply(
    { systemPrompt: { section: () => {} }, tools: { register: (value) => registered.push(value) } },
    { root: ws },
  )
  const byName = new Map(registered.map((tool) => [tool.name, tool]))
  const editTool = byName.get('edit_text')
  const writeTool = byName.get('write_text')
  const exec = { agent: { session: { header: { cwd: ws } } } }

  // 待定卡片：完全来自参数（未校验），所以每一步都要窄化
  const editCall = editTool.presentCall({ file_path: 'a.md', old_text: 'beta\n', new_text: 'BETA\n' })
  check(
    'present: edit_text call card is a diff with the path and the literal anchor',
    editCall.card === 'diff' && editCall.title === 'Edit a.md' && editCall.diffs[0].path === 'a.md'
      && editCall.diffs[0].oldText === 'beta\n' && editCall.locations[0].path === 'a.md',
    JSON.stringify(editCall),
  )
  const writeCall = writeTool.presentCall({ file_path: 'b.md', content: 'x\n' })
  check(
    'present: write_text call card shows a create-shaped diff',
    writeCall.card === 'diff' && writeCall.title === 'Write b.md' && writeCall.diffs[0].oldText === null && writeCall.diffs[0].newText === 'x\n',
    JSON.stringify(writeCall),
  )
  check(
    'present: call cards tolerate unvalidated args',
    editTool.presentCall({}) === undefined && editTool.presentCall('nope') === undefined
      && writeTool.presentCall({ file_path: 'b.md' }) === undefined && writeTool.presentCall(null) === undefined,
  )
  const anchorCall = editTool.presentCall({ file_path: 'a.md', grep: '^beta', new_text: 'BETA\n' })
  check('present: an anchor call has no old text, so it shows as an insertion', anchorCall.diffs[0].oldText === null, JSON.stringify(anchorCall.diffs))

  // 结果侧：投影 → 回放
  writeSample(join(ws, 'p.md'), ['alpha', 'beta', 'gamma'])
  const edited = await editTool.execute({ file_path: 'p.md', grep: '^beta', new_text: 'BETA\n' }, exec)
  const meta = editTool.output.presentationMeta({ file_path: 'p.md' }, edited)
  check(
    'present: the projection carries the applied hunk with context',
    meta.diffs.length === 1 && meta.diffs[0].oldText === 'alpha\nbeta\ngamma' && meta.diffs[0].newText === 'alpha\nBETA\ngamma',
    JSON.stringify(meta),
  )
  const replayed = editTool.presentResult({ file_path: 'p.md' }, { content: [], isError: false, meta })
  check(
    'present: presentResult replays the card from the persisted meta',
    replayed.card === 'diff' && replayed.title === 'Edit p.md' && replayed.diffs.length === 1,
    JSON.stringify(replayed),
  )
  check(
    'present: malformed or empty meta degrades to the raw text (no throw)',
    editTool.presentResult({}, { content: [], isError: false }) === undefined
      && editTool.presentResult({}, { content: [], isError: false, meta: { diffs: [] } }) === undefined
      && editTool.presentResult({}, { content: [], isError: false, meta: { diffs: [{ path: 7 }] } }) === undefined
      && editTool.presentResult({}, { content: [], isError: true, meta }) === undefined
      && editTool.presentResult({}, null) === undefined,
  )
  const failedMeta = editTool.output.presentationMeta({ file_path: 'p.md' }, { path: 'p.md', ok: false, brief: '', stderr: 'x' })
  check('present: a failed result projects no diffs', Array.isArray(failedMeta.diffs) && failedMeta.diffs.length === 0, JSON.stringify(failedMeta))

  // 整篇重写：卡片载荷封顶，超限时标题标注"部分 diff"，回放时退回原始文本
  const huge = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n') + '\n'
  const hugeWrite = await writeTool.execute({ file_path: 'huge.md', content: huge }, exec)
  const hugeMeta = writeTool.output.presentationMeta({ file_path: 'huge.md' }, hugeWrite)
  check(
    'present: an oversized change truncates the card instead of the session log',
    hugeWrite.hunksTruncated === true && hugeWrite.hunks.length === 0 && hugeMeta.diffs.length === 0 && /部分 diff/.test(hugeMeta.title),
    `${hugeWrite.hunks.length} ${hugeMeta.title}`,
  )
  check(
    'present: a truncated card degrades to the raw text at replay',
    writeTool.presentResult({ file_path: 'huge.md' }, { content: [], isError: false, meta: hugeMeta }) === undefined,
  )
  // 边界：多命中（同一调用里的多个 hunk）但仍在预算内的改动照样成卡
  writeFileSync(join(ws, 'many.md'), Array.from({ length: 12 }, () => 'x').join('\n') + '\n')
  const manyEdit = await editTool.execute({ file_path: 'many.md', old_text: 'x\n', new_text: 'y\n', count: 12 }, exec)
  const manyMeta = editTool.output.presentationMeta({ file_path: 'many.md' }, manyEdit)
  check(
    'present: a 12-hit edit stays within budget',
    manyEdit.ok === true && manyMeta.diffs.length === 1 && manyEdit.hunksTruncated === false,
    JSON.stringify([manyMeta.diffs.length, manyEdit.hunksTruncated, manyEdit.stderr]),
  )

  rmSync(ws, { recursive: true, force: true })
}

/**
 * 会话文件策略：`read-only` 时本插件必须一并拒写。
 *
 * 本插件的写盘**绕开 `ctx.fs`**（fs seam 的变更原语只有 `writeText`/`editText`，会丢 BOM、拍平
 * CRLF），所以沙箱、审批、`fs/observed` 都不在这条路径上；`sandboxPolicy` 是唯一能问出模式的地方，
 * 于是把它镜像回来。三档都要断言：只读拒、非只读照旧、服务缺席或解析失败时不误伤。
 */
async function policySuite() {
  const ws = makeWorkspace('dsh-selftest-policy-')
  const registered = []
  let mode = 'workspace-write'
  const ctx = {
    systemPrompt: { section: () => {} },
    tools: { register: (value) => registered.push(value) },
    get: (name) => (name === 'sandboxPolicy' ? { resolve: () => ({ mode, workspaceRoot: ws }) } : undefined),
  }
  apply(ctx, { root: ws })
  const byName = new Map(registered.map((tool) => [tool.name, tool]))
  const editTool = byName.get('edit_text')
  const writeTool = byName.get('write_text')
  const exec = { agent: { session: { header: { cwd: ws } } } }

  const sample = join(ws, 'policy.md')
  writeSample(sample, ['alpha', 'beta', 'gamma'])
  const edited = await editTool.execute({ file_path: 'policy.md', grep: '^beta', new_text: 'BETA\n' }, exec)
  check('policy: workspace-write still writes', edited.ok === true, edited.stderr)

  mode = 'read-only'
  const snapshot = readFileSync(sample)
  const backupsBefore = existsSync(join(ws, '.dsh', 'backups')) ? readdirSync(join(ws, '.dsh', 'backups')).length : 0
  const refused = await editTool.execute({ file_path: 'policy.md', grep: '^BETA', new_text: 'no\n' }, exec)
  check(
    'policy: read-only refuses and names the policy',
    refused.ok === false && /当前文件策略 read-only/.test(refused.stderr),
    refused.stderr,
  )
  check('policy: the refusal is not a path complaint', !/工作区之外/.test(refused.stderr), refused.stderr)
  check('policy: the target keeps its bytes', readFileSync(sample).equals(snapshot))
  const backupsAfter = existsSync(join(ws, '.dsh', 'backups')) ? readdirSync(join(ws, '.dsh', 'backups')).length : 0
  check('policy: a refusal writes no backup of its own', backupsAfter === backupsBefore, `${backupsBefore} -> ${backupsAfter}`)
  const refusedCreate = await writeTool.execute({ file_path: 'fresh.md', content: 'x\n' }, exec)
  check('policy: read-only refuses creates too', refusedCreate.ok === false && !existsSync(join(ws, 'fresh.md')), refusedCreate.stderr)
  assertShape('policy: a refusal still matches OUTPUT_SCHEMA', refused)
  check(
    'policy: the refusal renders as FAIL plus the reason',
    editTool.output.render({}, refused)[0].text === 'FAIL\n当前文件策略 read-only，拒绝写入（策略来自会话设置，不是路径问题）。',
    editTool.output.render({}, refused)[0].text,
  )

  mode = 'danger-full-access'
  const allowed = await editTool.execute({ file_path: 'policy.md', grep: '^BETA', new_text: 'BETA2\n' }, exec)
  check('policy: danger-full-access keeps the existing guard behaviour', allowed.ok === true, allowed.stderr)

  // 模拟 ctx（没有 `get`）与解析失败都必须退回既有行为，不能把写盘全禁掉
  const plain = []
  apply({ systemPrompt: { section: () => {} }, tools: { register: (v) => plain.push(v) } }, { root: ws })
  const plainWrite = await plain.find((tool) => tool.name === 'write_text').execute({ file_path: 'plain.md', content: 'x\n' }, exec)
  check('policy: a ctx without sandboxPolicy still writes', plainWrite.ok === true, plainWrite.stderr)
  const throwing = []
  apply(
    {
      systemPrompt: { section: () => {} },
      tools: { register: (v) => throwing.push(v) },
      get: () => ({ resolve: () => { throw new Error('policy service down') } }),
    },
    { root: ws },
  )
  const throwingWrite = await throwing.find((tool) => tool.name === 'write_text').execute({ file_path: 'throwing.md', content: 'x\n' }, exec)
  check('policy: a failing resolver does not brick writes', throwingWrite.ok === true, throwingWrite.stderr)

  rmSync(ws, { recursive: true, force: true })
}

/**
 * 门禁层（`lib/mask.mjs`）：把原生 `write` / `edit` 从 agent 的可见面去掉。
 *
 * 这一层用假 ctx 驱动：真正的作用域语义（同一套可见性解析器同时决定 schema、查找与派发）由
 * `tools/probe-mask.mjs` 拿真实的 `dsh-tools` + `dsh-scope` 验证，这里钉住的是本模块自己的行为——
 * 只点名看得见的名字、两种模式各自调用什么、空段与顺序、重复事件不重复注册、以及**绝不抛异常**
 * （监听器跑在 `agent/created` 的同步派发里，抛出会连带影响 agent 创建）。
 */
function maskSuite() {
  const listeners = []
  const ctx = { on: (event, listener) => listeners.push([event, listener]), logger: { warn: () => {} } }

  /** 一个假 agent：`tools` 记录调用，`systemPrompt` 记录注册的段。 */
  function fakeAgent(visible, opts = {}) {
    const calls = { restrict: [], guard: [], sections: [] }
    const tools = {
      get: (name) => (visible.includes(name) ? { name } : undefined),
      restrict: (filter) => calls.restrict.push(filter),
      guard: (fn) => calls.guard.push(fn),
    }
    if (opts.throwingRegistry === true) tools.restrict = () => { throw new Error('registry down') }
    const systemPrompt = { section: (section) => calls.sections.push(section) }
    if (opts.throwingPrompt === true) systemPrompt.section = () => { throw new Error('prompt down') }
    return { agent: { ctx: { tools, systemPrompt } }, calls }
  }

  const created = (agent) => listeners.forEach(([, listener]) => listener({ agent }))

  {
    listeners.length = 0
    applyMask(ctx, {})
    check(
      'mask: subscribes to agent/created once',
      listeners.length === 1 && listeners[0][0] === 'agent/created',
      JSON.stringify(listeners.map(([event]) => event)),
    )

    // deny 模式：看得见的名字才点名，且只下发一次 restrict
    const one = fakeAgent(['read', 'write', 'edit'])
    created(one.agent)
    check(
      'mask: deny mode restricts exactly the visible native names',
      one.calls.restrict.length === 1 && JSON.stringify(one.calls.restrict[0]) === '{"deny":["write","edit"]}',
      JSON.stringify(one.calls.restrict),
    )
    check('mask: deny mode registers no guard', one.calls.guard.length === 0, JSON.stringify(one.calls.guard))
    check(
      'mask: the native guidance sections are shadowed with empty text',
      one.calls.sections.length === 2
        && one.calls.sections.map((section) => section.name).join(',') === 'tool:write,tool:edit'
        && one.calls.sections.every((section) => section.text === '') === true
        && one.calls.sections.map((section) => section.order).join(',') === '101,102',
      JSON.stringify(one.calls.sections),
    )

    // 预设没挂 tool-fs：一个名字都看不见时不许调用 restrict（未知名字会抛）
    const none = fakeAgent(['read'])
    created(none.agent)
    check(
      'mask: a preset without the natives is left alone',
      none.calls.restrict.length === 0 && none.calls.sections.length === 2,
      JSON.stringify(none.calls),
    )

    // 同一个 agent 重复收到事件（或重复派发）时不重复注册：同层重名会抛
    created(one.agent)
    check('mask: a repeated event does not register twice', one.calls.restrict.length === 1 && one.calls.sections.length === 2, JSON.stringify(one.calls))

    // 注册表/提示词服务抛错时只记日志，不把 agent 创建带崩
    const broken = fakeAgent(['write'], { throwingRegistry: true, throwingPrompt: true })
    let threw = false
    try {
      created(broken.agent)
    } catch {
      threw = true
    }
    check('mask: a failing registry or prompt service never throws out of the listener', threw === false)
  }

  {
    // guard 模式：工具保持可见，调用被否决，原因指向我们的工具
    listeners.length = 0
    applyMask(ctx, { mode: 'guard' })
    const seen = fakeAgent(['read', 'write', 'edit'])
    created(seen.agent)
    check('mask: guard mode registers no restriction', seen.calls.restrict.length === 0, JSON.stringify(seen.calls.restrict))
    check('mask: guard mode registers one guard', seen.calls.guard.length === 1, JSON.stringify(seen.calls.guard.length))
    const guard = seen.calls.guard[0]
    check(
      'mask: the guard denies only the native names, with an actionable reason',
      typeof guard({ name: 'edit' }) === 'string'
        && /edit_text/.test(guard({ name: 'edit' }))
        && /write_text/.test(guard({ name: 'write' }))
        && guard({ name: 'edit_text' }) === undefined
        && guard({ name: 'read' }) === undefined,
      JSON.stringify([guard({ name: 'edit' }), guard({ name: 'edit_text' })]),
    )
  }

  {
    // 配置：自定义名字、关掉段遮蔽
    listeners.length = 0
    applyMask(ctx, { deny: ['str_replace'], sections: [] })
    const custom = fakeAgent(['read', 'str_replace'])
    created(custom.agent)
    check(
      'mask: deny and sections are configurable',
      JSON.stringify(custom.calls.restrict[0]) === '{"deny":["str_replace"]}' && custom.calls.sections.length === 0,
      JSON.stringify(custom.calls),
    )
  }
}

/**
 * 引导段的三档：`full`（默认，含"优先于原生"）、`short`（原生已被门禁屏蔽时用）、`false`（不注册）。
 */
function guidanceSuite() {
  const sectionsOf = (config) => {
    const sections = []
    apply({ systemPrompt: { section: (section) => sections.push(section) }, tools: { register: () => {} } }, config)
    return sections
  }
  const ws = makeWorkspace('dsh-selftest-guidance-')

  const full = sectionsOf({ root: ws })
  const short = sectionsOf({ root: ws, guidance: 'short' })
  const none = sectionsOf({ root: ws, guidance: false })
  check(
    'guidance: the default is the full text that names the built-ins',
    full.length === 1 && full[0].name === 'tool:edit_text' && full[0].order === 116 && /built-in/.test(full[0].text),
    JSON.stringify(full[0]),
  )
  check(
    'guidance: short drops the "prefer over the built-in" half and stays smaller',
    short.length === 1 && !/built-in/.test(short[0].text) && Buffer.byteLength(short[0].text, 'utf8') < Buffer.byteLength(full[0].text, 'utf8'),
    `${Buffer.byteLength(full[0].text, 'utf8')} B -> ${Buffer.byteLength(short[0].text, 'utf8')} B`,
  )
  check('guidance: false registers no section at all', none.length === 0, JSON.stringify(none))
  let rejected = false
  try {
    sectionsOf({ root: ws, guidance: 'medium' })
  } catch {
    rejected = true
  }
  check('guidance: an unknown value fails the mount loudly', rejected)

  rmSync(ws, { recursive: true, force: true })
}

/** 用法错误只依赖参数校验，跑一遍即可。 */
function usageSuite() {
  const editCases = [
    ['no anchor', { file_path: 'x', new_text: 'a' }],
    ['two anchors', { file_path: 'x', old_text: 'a', grep: 'b', new_text: 'a' }],
    ['after with old_text', { file_path: 'x', mode: 'after', old_text: 'a', new_text: 'a' }],
    ['bad mode', { file_path: 'x', grep: 'a', new_text: 'a', mode: 'sneak' }],
    ['bad count', { file_path: 'x', grep: 'a', new_text: 'a', count: 0 }],
    ['empty file_path', { file_path: '  ', grep: 'a', new_text: 'a' }],
    ['missing file_path', { grep: 'a', new_text: 'a' }],
    ['missing new_text', { file_path: 'x', grep: 'a' }],
  ]
  for (const [label, args] of editCases) {
    let rejected = false
    try {
      planEdit(args)
    } catch {
      rejected = true
    }
    check(`usage error rejected: ${label}`, rejected)
  }
  for (const [label, args] of [['write without content', { file_path: 'x' }], ['write with non-string content', { file_path: 'x', content: 5 }]]) {
    let rejected = false
    try {
      planWrite(args)
    } catch {
      rejected = true
    }
    check(`usage error rejected: ${label}`, rejected)
  }
}

// ── 跑起来 ──────────────────────────────────────────────────────────────────

{
  const ws = makeWorkspace('dsh-selftest-core-')
  const runner = {
    ws,
    async edit(args) {
      return await applyPlan(planEdit(args), { root: ws })
    },
    async write(args) {
      return await applyPlan(planWrite(args), { root: ws })
    },
  }
  console.log('── core: shared behaviour ──')
  await sharedSuite(runner)
  console.log('')
  console.log('── core: Node-only guarantees ──')
  await nodeOnlySuite(ws)
  rmSync(ws, { recursive: true, force: true })
}

console.log('')
console.log('── plugin: apply / execute / render / config ──')
await pluginSuite()

console.log('')
console.log('── plugin: model-facing result text ──')
await resultTextSuite()

console.log('')
console.log('── plugin: presentation cards (presentCall / presentationMeta / presentResult) ──')
await presentationSuite()

console.log('')
console.log('── plugin: session file policy (read-only refusal) ──')
await policySuite()

console.log('')
console.log('── mask: hiding the built-in write/edit ──')
maskSuite()

console.log('')
console.log('── guidance: full / short / off ──')
guidanceSuite()

console.log('')
console.log('── usage errors ──')
usageSuite()

console.log('')
console.log((failures === 0 ? 'OK' : 'FAILED') + ' — ' + (checks - failures) + '/' + checks + ' checks passed')
process.exitCode = failures === 0 ? 0 : 1
