// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * selftest.mjs —— `lib/` 的端到端自测，不需要 dsh 会话。
 *
 * 断言覆盖四层：核心共享行为、Node 独有保证、插件层与呈现层、会话策略与门禁。插件层是宿主真正
 * 调用的入口，所以返回值必须恰好满足 `OUTPUT_SCHEMA`，模型可见文本只有一行统计。
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

/** 返回值必须**恰好**满足 `OUTPUT_SCHEMA`（`additionalProperties: false`）。 */
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

/** 核心共享断言：BOM / 行尾 / 锚点 / `count`。 */
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
    check('edit(grep): ok', result.ok, result.stderr)
    check('edit(grep): BOM preserved', bomOf(bytes))
    check('edit(grep): CRLF preserved', countCrlf(bytes) === 3, `crlf=${countCrlf(bytes)} lf=${countLf(bytes)}`)
    check('edit(grep): content replaced', bytes.toString('utf8').includes('gamma patched'))
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
    // `count` 在三条路径上语义一致：声明期望命中数，不符即拒绝。此前 `grep` / `lines` 忽略它，
    // 而报错原文恰在建议用它。声明的多处命中逐处替换，所以每处都换成同样行数时总行数不变。
    await write({ file_path: 'count-grep.md', content: 'k=1\nk=2\nk=3\n' })
    const linesBefore = readFileSync(join(ws, 'count-grep.md'), 'utf8').split('\n').length
    const ok = await edit({ file_path: 'count-grep.md', grep: '(?m)^k=', count: 3, new_text: 'K=x\n' })
    const after = readFileSync(join(ws, 'count-grep.md'), 'utf8')
    check('edit(grep + count=3): ok and every hit replaced', ok.ok && after.replace(/\r\n/g, '\n') === 'K=x\nK=x\nK=x\n', JSON.stringify(after))
    check('edit(grep + count=3): the line count is unchanged', after.split('\n').length === linesBefore, JSON.stringify(after))

    await write({ file_path: 'count-lines.md', content: 'k=1\nk=2\nk=3\n' })
    const seedLines = readFileSync(join(ws, 'count-lines.md'), 'utf8').split('\n').length
    const wrong = await edit({ file_path: 'count-lines.md', lines: '1:2', count: 9, new_text: 'x\n' })
    check('edit(lines + count=9): a mismatched declaration refuses', !wrong.ok && /count=9/.test(wrong.stderr), wrong.stderr)
    const untouched = readFileSync(join(ws, 'count-lines.md'), 'utf8')
    check('edit(lines + count mismatch): the file is untouched',
      untouched.split('\n').length === seedLines && !untouched.includes('x'), 'the file changed')

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

/** Node 独有：二进制与非法编码、多数派行尾、锚点边界、并发。 */
async function nodeOnlySuite(ws) {
  const run = (args) => applyPlan(planEdit(args), { root: ws })
  const write = (args) => applyPlan(planWrite(args), { root: ws })

  {
    // 本包没有路径护栏（见 lib/core.mjs）：`.dsh/` 内部照写。
    mkdirSync(join(ws, '.dsh'), { recursive: true })
    writeFileSync(join(ws, '.dsh', 'scratch.md'), 'x\n')
    const result = await run({ file_path: '.dsh/scratch.md', old_text: 'x', new_text: 'y' })
    check('no guard: .dsh/ targets are editable', result.ok && readFileSync(join(ws, '.dsh', 'scratch.md'), 'utf8') === 'y\n', result.stderr)
  }
  {
    // 工作区之外、`..` 相对路径与中文文件名。
    const outsideDir = join(dirname(ws), `外部-${basename(ws)}`)
    mkdirSync(outsideDir, { recursive: true })
    const outside = join(outsideDir, '外部-文件.md')
    writeFileSync(outside, '一行\n')
    const result = await run({ file_path: `../${basename(outsideDir)}/外部-文件.md`, old_text: '一行', new_text: '两行' })
    check('no guard: paths outside the workspace are editable', result.ok && readFileSync(outside, 'utf8') === '两行\n', result.stderr)
    check(
      'no side artifacts: the edit adds nothing to .dsh/',
      readdirSync(join(ws, '.dsh')).join(',') === 'scratch.md',
      JSON.stringify(readdirSync(join(ws, '.dsh'))),
    )
    rmSync(outsideDir, { recursive: true, force: true })
  }
  {
    writeFileSync(join(ws, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42, 0x0a]))
    const result = await run({ file_path: 'binary.bin', grep: 'A', new_text: 'Z\n' })
    check('refuses binary content (NUL)', !result.ok && /NUL bytes/.test(result.stderr), result.stderr)
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
    // 并发写同一文件：8 次调用全部落定，文件始终完整。进程内单线程 + 同步临界区，撕裂无法在
    // 进程内证伪。
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
    check('editing a missing file is refused', !result.ok && /does not exist/.test(result.stderr), result.stderr)
  }
  {
    writeFileSync(join(ws, 'miss.md'), 'alpha\nbeta\ngamma\n')
    const result = await run({ file_path: 'miss.md', old_text: 'beta\ngamaa', new_text: 'x\n' })
    check('a miss names the first differing line pair',
      !result.ok && /first difference: your old line 2 "gamaa" vs file line 3 "gamma"/.test(result.stderr), result.stderr)
  }
  {
    // 精确命中失败、只差空白（这里是行中间多两个空格）时仍然命中，并在 brief 里说清"忽略了空白"。
    writeFileSync(join(ws, 'spacing.md'), 'keep   trailing\nnext line\n')
    const result = await run({ file_path: 'spacing.md', old_text: 'keep trailing\nnext line', new_text: 'untouched\n' })
    check('a whitespace-only difference still matches', result.ok, result.stderr)
    check('ignoring whitespace is announced in the brief', /matched ignoring whitespace/.test(result.brief), result.brief)
  }
  {
    // 用户实测的那次：锚点里多了一个空行（文件里没有），旧实现整体未命中、还列出三段互相重叠的候选。
    // 现在空行属于"被忽略的空白"，且替换落在文件自己的行跨度上——块外面的行一行都不许动。
    writeFileSync(join(ws, 'blank-line.md'), 'wrap\n  // 6b3)\n  body();\n  }\n  // 6c)\nnext\n')
    const result = await run({
      file_path: 'blank-line.md',
      old_text: '  // 6b3)\n  body();\n  }\n\n  // 6c)\n',
      new_text: '  // 6b3)\n  body();\n  }\n',
    })
    const text = readFileSync(join(ws, 'blank-line.md'), 'utf8')
    check('a blank line in the anchor is ignored', result.ok, result.stderr)
    check('only the quoted lines are replaced', text === 'wrap\n  // 6b3)\n  body();\n  }\nnext\n', JSON.stringify(text))
  }
  {
    // 锚点里全是空白：去掉空白后是个空串，能匹配任何位置，必须当成用法问题拒掉。
    const result = await run({ file_path: 'spacing.md', old_text: ' \n\t\n', new_text: 'x\n' })
    check('a whitespace-only anchor is refused', !result.ok && /nothing but whitespace/.test(result.stderr), result.stderr)
  }
  {
    // 字符不同一律拒写（旧实现在整块相似度 ≥ 0.9 时接受并整块替换，静默吃掉那几个字符）。
    const seed = 'alpha\nbravo\ncharlieXYZ\ndelta\n'
    writeFileSync(join(ws, 'char-diff.md'), seed)
    const result = await run({ file_path: 'char-diff.md', old_text: 'alpha\nbravo\ncharlie\ndelta\n', new_text: 'replaced\n' })
    check('a character difference is refused',
      !result.ok && /your old line 3 "charlie" vs file line 3 "charlieXYZ"/.test(result.stderr), result.stderr)
    check('a refused character difference leaves the file untouched',
      readFileSync(join(ws, 'char-diff.md'), 'utf8') === seed)
  }
  {
    // 换行也被忽略之后，锚点可能只盖住半行（`const x = 1;` 是 `const x = 1;const y = 2;` 的子串）。
    // 按行跨度替换会连那半行剩下的内容一起吃掉，所以首尾不贴整行就拒写。
    const seed = 'const  x = 1;const y = 2;\n'
    writeFileSync(join(ws, 'partial-line.md'), seed)
    const result = await run({ file_path: 'partial-line.md', old_text: 'const x = 1;', new_text: 'gone\n' })
    check('an anchor covering only part of a line is refused',
      !result.ok && /covers only part of that line/.test(result.stderr), result.stderr)
    check('a refused partial-line anchor leaves the file untouched',
      readFileSync(join(ws, 'partial-line.md'), 'utf8') === seed)
  }
  {
    // 命中区间落在整行上：锚点没写换行结尾时，换行符必须留在文件里，否则替换会把下一行并进来。
    writeFileSync(join(ws, 'ws-edges.md'), 'alpha\n   BBBB\ncccc\ndddd\n')
    const result = await run({ file_path: 'ws-edges.md', old_text: '  BBBB   ', new_text: 'X' })
    const text = readFileSync(join(ws, 'ws-edges.md'), 'utf8')
    check('a whitespace-insensitive hit stays inside its own line', result.ok && text === 'alpha\nX\ncccc\ndddd\n', JSON.stringify(text))
  }
  {
    // 忽略空白后命中两处时不得挑第一处：与精确命中同样拒绝写盘。
    const seed = 'alpha\n   BBBB\ncccc\n   BBBB\ndddd\n'
    writeFileSync(join(ws, 'ws-ambiguous.md'), seed)
    const result = await run({ file_path: 'ws-ambiguous.md', old_text: '  BBBB   ', new_text: 'X' })
    check('a whitespace-insensitive hit matching twice is refused',
      !result.ok && /it hits 2 places/.test(result.stderr), result.stderr)
    check('a refused whitespace-insensitive hit leaves the file untouched',
      readFileSync(join(ws, 'ws-ambiguous.md'), 'utf8') === seed)
  }
  {
    // 锚点带换行、替换文本不带时行会被并起来（README 的既有约定），brief 要说出来。
    writeFileSync(join(ws, 'eol-merge.md'), 'alpha\n   BBBB\ncccc\n')
    const result = await run({ file_path: 'eol-merge.md', old_text: 'BBBB\n', new_text: 'X' })
    check('a line-absorbing replacement is announced', result.ok && /joined with the next/.test(result.brief), result.brief || result.stderr)
  }
  {
    const result = await run({ file_path: 'sample.md', grep: '^one$', new_text: 'one\n' })
    check('a no-change edit is refused', !result.ok && /no change/.test(result.stderr), result.stderr)
  }
  {
    // 空 `content` 配不存在的目标 = 创建零字节文件（与原生 write 一致）。
    // 曾被判成"没有产生任何变化"拒绝，而"先建空文件再写"是常见起手式。
    const empty = join(ws, 'zero-byte.txt')
    const result = await write({ file_path: 'zero-byte.txt', content: '' })
    check('write(create) with empty content creates a zero-byte file', result.ok && existsSync(empty) && readFileSync(empty).length === 0, result.stderr || JSON.stringify(result))
    check('write(create) with empty content reports the change', result.brief === 'write +0/-0', JSON.stringify(result.brief))
    check('write(create) with empty content fills in missing parents',
      (await write({ file_path: 'deep/nested/empty.txt', content: '' })).ok && existsSync(join(ws, 'deep', 'nested', 'empty.txt')))
    const again = await write({ file_path: 'zero-byte.txt', content: '' })
    check('write(overwrite) with empty content on an empty file is still a no-op', !again.ok && /no change/.test(again.stderr), again.stderr)
  }

  {
    // 新建时补齐父目录，且不为此多说一句。父目录必须真的缺失，否则这条断言无法独立失败。
    const result = await write({ file_path: 'fresh-dir/nested/fresh.md', content: 'a\nb\n' })
    check(
      'write(create) fills in missing parent directories',
      result.ok && existsSync(join(ws, 'fresh-dir', 'nested', 'fresh.md')),
      result.stderr || JSON.stringify(result),
    )
    check('write(create) keeps the brief to one stat line', result.brief === 'write +2/-0', JSON.stringify(result.brief))
    check(
      'write(create) returns exactly the documented fields',
      Object.keys(result).sort().join(',') === 'brief,ok,path,stderr',
      Object.keys(result).join(','),
    )
  }
  {
    // 系统调用失败只给 errno 说法，内部临时文件名绝不进原因。
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

/** 插件层：宿主真正调用的入口（注册、校验、结果形状、`render()`、config 透传）。 */
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
    check('plugin: the write leaves no side artifacts', !existsSync(join(ws, '.dsh')), 'a .dsh/ directory appeared')
  }
  {
    // 用法错误必须是工具结果，不能抛异常，否则会把会话弄崩
    const result = await editTool.execute({ file_path: 'plugin.md', new_text: 'x' }, exec)
    assertShape('plugin: usage-error result matches OUTPUT_SCHEMA', result)
    check('plugin: a usage error is a result, not a throw', result.ok === false && /anchor/.test(result.stderr), result.stderr)
    const failText = editTool.output.render({}, result)[0].text
    check('plugin: failure render says FAIL without echoing the path', failText.startsWith('FAIL\n') && !failText.includes('plugin.md'), failText)
    check('plugin: failure render keeps the reason', failText.includes('anchor'))
  }
  rmSync(ws, { recursive: true, force: true })

  // config 透传：newFileBom、无会话时的 root 回退
  const configWs = makeWorkspace('dsh-selftest-config-')
  const configured = []
  apply(
    { systemPrompt: { section: () => {} }, tools: { register: (value) => configured.push(value) } },
    { root: configWs, newFileBom: true },
  )
  const writeConfigured = configured.find((tool) => tool.name === 'write_text')
  const created = await writeConfigured.execute({ file_path: 'fresh.md', content: 'a\nb\n' }, {})
  const createdBytes = existsSync(join(configWs, 'fresh.md')) ? readFileSync(join(configWs, 'fresh.md')) : Buffer.alloc(0)
  check('plugin: config.root is the fallback workspace when exec has no session', created.ok === true && existsSync(join(configWs, 'fresh.md')), JSON.stringify(created))
  check('plugin: config.newFileBom=true writes a BOM on create', bomOf(createdBytes), JSON.stringify(createdBytes.toString('utf8')))
  rmSync(configWs, { recursive: true, force: true })
}

/**
 * 返回值约束：成功是 `WROTE` 加**一行统计**，失败是 `FAIL` 加完整原因；都不回显改动内容与路径。
 * 旧实现把整文件 diff 当结果正文（长行以 1.0x 放大率进入上下文），路径占成功结果字节的 48%。
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

  // 1) 整文件新建：只有两行，且不含文件内容
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

  // 3) 长行：曾经整篇进入上下文，现在与文件大小无关
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

  // 5) 回吐字节与输入规模无关：本契约的核心
  const hugeText = textOf(writeTool, await writeTool.execute({ file_path: 'huge.txt', content: 'z'.repeat(400000) + '\n' }, exec))
  check(
    'result: a 400 KB write still returns a two-line result',
    hugeText === 'WROTE\nwrite +1/-0',
    `${Buffer.byteLength(hugeText, 'utf8')} B\n${hugeText}`,
  )

  // 6) 失败路径相反：原因必须完整，要指名文件时自己带
  const missing = await editTool.execute({ file_path: 'nope.md', grep: 'x', new_text: 'y\n' }, exec)
  const failText = textOf(editTool, missing)
  check(
    'result: a failure keeps the full reason',
    failText.startsWith('FAIL\n') && failText.includes('target does not exist: nope.md'),
    failText,
  )

  rmSync(ws, { recursive: true, force: true })
}

/**
 * 会话文件策略：`read-only` 时必须一并拒写。
 *
 * 写盘**绕开 `ctx.fs`**（fs seam 只有 `writeText` / `editText`，会丢 BOM、拍平 CRLF），沙箱与审批
 * 都不在路径上，`sandboxPolicy` 是唯一问得出模式的地方。三档：只读拒、非只读照旧、服务缺席或解析
 * 失败时不误伤。
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
  const refused = await editTool.execute({ file_path: 'policy.md', grep: '^BETA', new_text: 'no\n' }, exec)
  check(
    'policy: read-only refuses and names the policy',
    refused.ok === false && /session file policy is read-only/.test(refused.stderr),
    refused.stderr,
  )
  check('policy: the refusal is not a path complaint', !/工作区之外/.test(refused.stderr), refused.stderr)
  check('policy: the target keeps its bytes', readFileSync(sample).equals(snapshot))
  check('policy: a refusal leaves no side artifacts', !existsSync(join(ws, '.dsh')))
  const refusedCreate = await writeTool.execute({ file_path: 'fresh.md', content: 'x\n' }, exec)
  check('policy: read-only refuses creates too', refusedCreate.ok === false && !existsSync(join(ws, 'fresh.md')), refusedCreate.stderr)
  assertShape('policy: a refusal still matches OUTPUT_SCHEMA', refused)
  check(
    'policy: the refusal renders as FAIL plus the reason',
    editTool.output.render({}, refused)[0].text === 'FAIL\nthe session file policy is read-only, so writing is refused (the policy comes from the session settings, not from the path).',
    editTool.output.render({}, refused)[0].text,
  )

  mode = 'danger-full-access'
  const allowed = await editTool.execute({ file_path: 'policy.md', grep: '^BETA', new_text: 'BETA2\n' }, exec)
  check('policy: danger-full-access keeps the existing guard behaviour', allowed.ok === true, allowed.stderr)

  // 模拟 ctx 与解析失败都必须退回既有行为，不能禁掉写盘
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
 * 假 ctx + 假注册表：真实作用域语义由 `tools/probe-mask.mjs` 与 `tools/repro-mask.mjs` 拿真包
 * 验证，这里只钉本模块自己的行为——三条通路何时调用什么、归属判据（假世界是 `members` 集合）、
 * 撤销是否成对，以及**绝不抛异常**（它跑在同步派发与守卫阶段里）。
 */
function maskSuite() {
  /** 搭一套假世界：监听器、行级守卫、成员集合、活 agent 列表。 */
  function world(options = {}) {
    const listeners = []
    const warnings = []
    const rowGuards = []
    const effects = []
    const members = new Set()
    const live = []
    const ask = (exec) => rowGuards.reduce((reason, fn) => reason ?? fn(exec), undefined)
    const ctx = {
      on: (event, listener) => listeners.push([event, listener]),
      logger: { warn: (message) => warnings.push(String(message)) },
      // `ctx.effect()` 立刻跑回调、把撤销函数挂在本行 fiber 上，行卸载时它会跑；这里捕获下来
      // 以便断言。
      effect: (callback) => {
        const disposer = callback()
        effects.push(disposer)
        return () => {}
      },
      tools: {
        guard: (fn) => {
          if (options.guardFails === true) throw new Error('registry down')
          rowGuards.push(fn)
        },
        // 行级可见性查询：真实实现读带作用域链的注册表视图。
        get: (name, agent) => (agent.visible.includes(name) ? { name } : undefined),
        guardReason: (exec) => {
          // 宿主平面安装：守卫落在全局层，无 agent 的探测也会被回答。
          if (options.unscoped === true && exec.agent === undefined) return ask(exec)
          // 别人的守卫抢答：真实实现先看全局层，再按作用域链取第一个非空答复。
          if (options.foreignPreempts === true) return 'foreign guard: no tool may run'
          return members.has(exec.agent) ? ask(exec) : undefined
        },
      },
      get: (name) => (name === 'agents' ? { list: () => [...live] } : undefined),
    }
    return {
      ctx,
      warnings,
      rowGuards,
      effects,
      members,
      live,
      events: () => listeners.map(([event]) => event),
      emit: (event, payload) => listeners.forEach(([name, listener]) => { if (name === event) listener(payload) }),
    }
  }

  /** 假 agent：记录调用并交回撤销句柄（撤销计数用于验"离开组合要还原"）。 */
  function fakeAgent(visible, opts = {}) {
    const agent = { id: `agent:${visible.join('+')}`, visible: [...visible] }
    const calls = { restrict: [], register: [], sections: [], order: [], disposed: 0 }
    const dispose = () => { calls.disposed += 1 }
    const tools = {
      get: (name) => (agent.visible.includes(name) ? { name, parameters: { type: 'object', properties: {} }, execute: async () => ({ ran: name }) } : undefined),
      restrict: (filter) => {
        if (opts.throwingRegistry === true) throw new Error('registry down')
        calls.restrict.push(filter)
        calls.order.push('restrict')
        if (opts.notify !== undefined) opts.notify()
        return dispose
      },
      register: (definition) => {
        calls.register.push(definition)
        calls.order.push('register')
        if (opts.notify !== undefined) opts.notify()
        return dispose
      },
    }
    const systemPrompt = {
      section: (section) => {
        if (opts.throwingPrompt === true) throw new Error('prompt down')
        calls.sections.push(section)
        if (opts.notify !== undefined) opts.notify()
        return dispose
      },
    }
    agent.ctx = { tools, systemPrompt }
    return { agent, calls }
  }

  /** 把一个假 agent 纳入假世界：成员、活列表、建档事件。 */
  const admit = (w, entry) => {
    w.members.add(entry.agent)
    w.live.push(entry.agent)
    w.emit('agent/created', { agent: entry.agent })
  }

  {
    const w = world()
    applyMask(w.ctx, {})

    const events = w.events()
    check('mask: subscribes to agent/created', events.includes('agent/created'), JSON.stringify(events))
    check(
      'mask: also subscribes to tools/change, which is what a preset switch emits',
      events.includes('tools/change'),
      JSON.stringify(events),
    )
    check('mask: the guard is registered in apply, before any agent exists', w.rowGuards.length === 1, String(w.rowGuards.length))

    // ── 守卫：最迟防线，与创建顺序无关 ──
    const guard = w.rowGuards[0]
    const seen = fakeAgent(['read', 'write', 'edit'])
    w.members.add(seen.agent)
    w.live.push(seen.agent)
    const reason = guard({ name: 'edit', agent: seen.agent })
    check(
      'mask: the guard denies a visible native with a reason that names our tools',
      typeof reason === 'string' && /edit_text/.test(reason) && /write_text/.test(reason),
      String(reason),
    )
    check(
      'mask: the guard ignores everything that is not on the deny list',
      guard({ name: 'edit_text', agent: seen.agent }) === undefined && guard({ name: 'read', agent: seen.agent }) === undefined,
    )
    check('mask: the guard ignores an exec without an agent', guard({ name: 'edit' }) === undefined)
    const blind = fakeAgent(['read'])
    check(
      'mask: the guard stays out of the way when the native is invisible to that agent',
      guard({ name: 'edit', agent: blind.agent }) === undefined,
    )
    check(
      'mask: the first blocked call narrows that agent right away (next request is clean)',
      seen.calls.restrict.length === 1
        && JSON.stringify(seen.calls.restrict[0]) === '{"deny":["write","edit"]}'
        && seen.calls.sections.length === 2,
      JSON.stringify(seen.calls),
    )
    check('mask: a blocked call never throws out of the guard', (() => {
      const broken = fakeAgent(['write'], { throwingRegistry: true, throwingPrompt: true })
      w.members.add(broken.agent)
      try {
        void guard({ name: 'write', agent: broken.agent })
        return true
      } catch {
        return false
      }
    })())

    // ── 建档路径：立即收窄 ──
    const one = fakeAgent(['read', 'write', 'edit'])
    admit(w, one)
    check(
      'mask: deny mode restricts exactly the visible native names',
      one.calls.restrict.length === 1 && JSON.stringify(one.calls.restrict[0]) === '{"deny":["write","edit"]}',
      JSON.stringify(one.calls.restrict),
    )
    check('mask: deny mode registers no per-agent guard', one.calls.register.length === 0, JSON.stringify(one.calls.register))
    check(
      'mask: the native guidance sections are shadowed with empty text',
      one.calls.sections.length === 2
        && one.calls.sections.map((section) => section.name).join(',') === 'tool:write,tool:edit'
        && one.calls.sections.every((section) => section.text === '') === true
        && one.calls.sections.map((section) => section.order).join(',') === '101,102',
      JSON.stringify(one.calls.sections),
    )
    w.emit('agent/created', { agent: one.agent })
    check(
      'mask: a repeated event does not register twice',
      one.calls.restrict.length === 1 && one.calls.sections.length === 2,
      JSON.stringify(one.calls),
    )

    // 一个原生名都看不见时不许调用 restrict（未知名字会抛）
    const none = fakeAgent(['read'])
    w.members.add(none.agent)
    w.emit('agent/created', { agent: none.agent })
    check(
      'mask: a preset without the natives is left alone',
      none.calls.restrict.length === 0 && none.calls.sections.length === 2,
      JSON.stringify(none.calls),
    )

    // 注册表或提示词抛错只记日志，不把 agent 创建带崩
    const broken = fakeAgent(['write'], { throwingRegistry: true, throwingPrompt: true })
    w.members.add(broken.agent)
    let threw = false
    try {
      w.emit('agent/created', { agent: broken.agent })
    } catch {
      threw = true
    }
    check('mask: a failing registry or prompt service never throws out of the listener', threw === false)
    check('mask: those failures are logged', w.warnings.length >= 2, JSON.stringify(w.warnings))

    // ── 换 preset 路径：认出成员、还原非成员 ──
    const swapped = fakeAgent(['read', 'write', 'edit'])
    w.live.push(swapped.agent)
    w.members.add(swapped.agent)
    w.emit('tools/change', {})
    check(
      'mask: a sweep after a preset switch narrows the agent that joined',
      swapped.calls.restrict.length === 1 && swapped.calls.sections.length === 2,
      JSON.stringify(swapped.calls),
    )
    const outsider = fakeAgent(['read', 'write', 'edit'])
    w.live.push(outsider.agent)
    w.emit('tools/change', {})
    check(
      'mask: a sibling composition is left untouched by the sweep',
      outsider.calls.restrict.length === 0 && outsider.calls.sections.length === 0,
      JSON.stringify(outsider.calls),
    )
    w.emit('tools/change', {})
    check(
      'mask: a repeated sweep does not register twice',
      swapped.calls.restrict.length === 1 && swapped.calls.sections.length === 2,
      JSON.stringify(swapped.calls),
    )

    // 离开组合必须成对撤销，否则那个 agent 一个新旧名字都没有。
    w.members.delete(swapped.agent)
    w.emit('tools/change', {})
    check(
      'mask: leaving the composition lifts every registration it made',
      swapped.calls.disposed === 3,
      `disposed=${swapped.calls.disposed} (restrict 1 + sections 2)`,
    )
    w.members.add(swapped.agent)
    w.emit('tools/change', {})
    check(
      'mask: rejoining the composition masks again from a clean slate',
      swapped.calls.restrict.length === 2 && swapped.calls.disposed === 3,
      JSON.stringify(swapped.calls.restrict.length),
    )

  }

  {
    // 守卫挂不上时归属判据退化成"不知道"：巡查绝不能悄悄放开已收窄的 agent——那比不收窄更糟。
    const w = world({ guardFails: true })
    applyMask(w.ctx, {})
    const agent = fakeAgent(['read', 'write', 'edit'])
    admit(w, agent)
    w.emit('tools/change', {})
    check(
      'mask: an unusable membership probe never lifts an existing mask',
      agent.calls.restrict.length === 1 && agent.calls.disposed === 0,
      JSON.stringify(agent.calls),
    )
    check('mask: the failed guard registration is logged', w.warnings.length >= 1, JSON.stringify(w.warnings))
  }

  {
    // 配置：自定义名字、关掉段遮蔽
    const w = world()
    applyMask(w.ctx, { deny: ['str_replace'], sections: [] })
    const custom = fakeAgent(['read', 'str_replace'])
    admit(w, custom)
    check(
      'mask: a custom deny list and disabled sections are honoured',
      JSON.stringify(custom.calls.restrict[0]) === '{"deny":["str_replace"]}' && custom.calls.sections.length === 0,
      JSON.stringify(custom.calls),
    )
  }

  {
    // 守卫是"最迟防线"：它拦到的调用必须给出可操作的拒绝原因（点名本插件的两个工具）。
    const w = world()
    applyMask(w.ctx, {})
    const watched = fakeAgent(['read', 'write', 'edit'])
    admit(w, watched)
    const reason = w.rowGuards[0]({ name: 'edit', agent: watched.agent })
    check(
      'mask: the guard refuses with a reason naming our tools',
      typeof reason === 'string' && /edit_text/.test(reason) && /write_text/.test(reason),
      String(reason),
    )
  }

  {
    // 宿主平面：本行层不在任何 agent 的作用域链上（`unscoped` 就是"守卫落在全局层"的假世界形状），
    // 无 agent 的探测会被回答 ⇒ 只做守卫、绝不收窄。
    const w = world({ unscoped: true })
    applyMask(w.ctx, {})
    const plain = fakeAgent(['read', 'write', 'edit'])
    admit(w, plain)
    w.emit('tools/change', {})
    check('mask: host-plane (unscoped) narrows nothing', plain.calls.restrict.length === 0, JSON.stringify(plain.calls.restrict))
    check(
      'mask: host-plane still registers the guard that denies the call',
      w.rowGuards.length === 1 && typeof w.rowGuards[0]({ name: 'edit', agent: plain.agent }) === 'string',
    )
    check(
      'mask: the degradation is reported',
      w.warnings.some((message) => /宿主平面/.test(message)),
      JSON.stringify(w.warnings),
    )
  }

  {
    // 注册动作本身**同步**发 `tools/change`：没有"正在装"的牌子，嵌套巡查就会把同一套注册装两遍。
    const w = world()
    applyMask(w.ctx, {})
    const agent = fakeAgent(['read', 'write', 'edit'], { notify: () => w.emit('tools/change', {}) })
    admit(w, agent)
    check(
      'mask: a synchronous tools/change from our own registration does not double-install',
      agent.calls.restrict.length === 1 && agent.calls.sections.length === 2 && w.warnings.length === 0,
      JSON.stringify([agent.calls.restrict.length, agent.calls.sections.length, w.warnings]),
    )
    const other = fakeAgent(['read', 'write', 'edit'])
    w.members.add(other.agent)
    w.live.push(other.agent)
    w.emit('tools/change', {})
    check(
      'mask: the re-entrancy gate still lets a later sweep mask another member',
      other.calls.restrict.length === 1 && other.calls.sections.length === 2,
      JSON.stringify(other.calls),
    )
  }

  {
    // 判据被别人抢答不等于"不是我的人"：只许"不知道"，绝不许撤销已有收窄。
    const w = world({ foreignPreempts: true })
    applyMask(w.ctx, {})
    const agent = fakeAgent(['read', 'write', 'edit'])
    admit(w, agent)
    w.emit('tools/change', {})
    check(
      'mask: an ambiguous membership reply never lifts an existing mask',
      agent.calls.restrict.length === 1 && agent.calls.disposed === 0,
      JSON.stringify(agent.calls),
    )
  }

  {
    // 一次失败的收窄不许记成"已完成"：空账会让它永久不被重试。
    const w = world()
    applyMask(w.ctx, { sections: [] })
    const opts = { throwingRegistry: true }
    const flaky = fakeAgent(['read', 'write', 'edit'], opts)
    admit(w, flaky)
    check(
      'mask: a failed narrowing installs nothing',
      flaky.calls.restrict.length === 0 && flaky.calls.sections.length === 0,
      JSON.stringify(flaky.calls),
    )
    opts.throwingRegistry = false
    w.emit('tools/change', {})
    check(
      'mask: the next sweep retries it and succeeds',
      flaky.calls.restrict.length === 1 && flaky.calls.sections.length === 0,
      JSON.stringify(flaky.calls),
    )
  }

  {
    // 注册挂在 **agent 的 fiber** 上，本行卸载不带走它们：必须留卸载钩子。
    const w = world()
    applyMask(w.ctx, {})
    const agent = fakeAgent(['read', 'write', 'edit'])
    admit(w, agent)
    check('mask: a row-scoped unload hook is registered', w.effects.length === 1 && typeof w.effects[0] === 'function', String(w.effects.length))
    w.effects[0]?.()
    check(
      'mask: unloading the row lifts every mask it installed',
      agent.calls.disposed === 3,
      `disposed=${agent.calls.disposed} (restrict 1 + sections 2)`,
    )
  }
}
/** 引导段三档：`full`（默认）、`short`（原生已被屏蔽时用）、`false`（不注册）。 */
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
  const throws = (plan, args) => {
    try {
      plan(args)
      return false
    } catch {
      return true
    }
  }
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
  for (const [label, args] of editCases) check(`usage error rejected: ${label}`, throws(planEdit, args))
  for (const [label, args] of [['write without content', { file_path: 'x' }], ['write with non-string content', { file_path: 'x', content: 5 }]]) {
    check(`usage error rejected: ${label}`, throws(planWrite, args))
  }
}

// ── 跑起来 ──

{
  const ws = makeWorkspace('dsh-selftest-core-')
  const runner = {
    ws,
    edit: (args) => applyPlan(planEdit(args), { root: ws }),
    write: (args) => applyPlan(planWrite(args), { root: ws }),
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
