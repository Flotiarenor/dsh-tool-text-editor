// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * selftest.mjs —— `lib/` 的端到端自测（不需要 dsh 会话）。
 *
 * 三层断言：
 *   * 共享行为 —— 通过 `applyPlan` 直接跑核心（BOM/行尾保真、锚点、匹配、count、歧义拒写）；
 *   * Node 独有保证 —— 路径护栏、二进制/非法 UTF-8 拒写、多数派行尾推断、多 hunk、并发不撕裂、
 *     新建时补齐父目录、系统调用失败只报 errno；
 *   * 插件层 —— 用假 ctx 走一遍 `lib/editor.mjs` 的 `apply()`：工具注册、引导段、
 *     参数校验、**返回值与 `OUTPUT_SCHEMA` 一致**、`render()` 文本，以及 config
 *     （`root` / `backup` / `ledger` / `newFileBom`）的透传。这一层是宿主真正调用的入口，必须被测到，
 *     否则 schema 与返回值脱节也只能等线上发现；
 *   * 返回值约束 —— 模型可见文本的构成本身是被断言对象：无论输入多大，成功路径固定为
 *     `WROTE <路径>` 加一行统计，且不含改动内容。这是工具契约的一部分，因此需要回归测试。
 *
 * 实现全部是进程内 Node（不启动子进程、无外部运行时），所以自测本身也只依赖 Node。
 *
 * 用法：
 *   node tools/selftest.mjs
 * 退出码：0 = 全过，1 = 有失败。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
 */
function assertShape(label, value) {
  const allowed = new Set(Object.keys(OUTPUT_SCHEMA.properties))
  const missing = OUTPUT_SCHEMA.required.filter((key) => !(key in value))
  const extra = Object.keys(value).filter((key) => !allowed.has(key))
  const wrong = Object.entries(OUTPUT_SCHEMA.properties)
    .filter(([key, spec]) => typeof value[key] !== spec.type)
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
    check('edit(ambiguous): explains count/nth', /count|nth/.test(detail), detail)
    const forced = await edit({ file_path: 'amb.md', old_text: 'twin', new_text: 'x', count: 2 })
    const lines = readFileSync(join(ws, 'amb.md'), 'utf8').split(/\r?\n/)
    check('edit(count=2): replaces every occurrence', forced.ok && lines[0] === 'x' && lines[1] === 'x', JSON.stringify(lines))
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
    mkdirSync(join(ws, '.dsh'), { recursive: true })
    const result = await run({ file_path: '.dsh/scratch.md', grep: 'x', new_text: 'y\n' })
    check('guard: refuses .dsh/ targets', !result.ok && /拒绝写入/.test(result.stderr), result.stderr)
  }
  {
    const result = await run({ file_path: '../outside.md', grep: 'x', new_text: 'y\n' })
    check('guard: refuses paths outside the workspace', !result.ok && /工作区之外/.test(result.stderr), result.stderr)
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
    const result = await run({ file_path: 'sample.md', grep: '^one$', new_text: 'one\n' })
    check('a no-change edit is refused', !result.ok && /没有产生任何变化/.test(result.stderr), result.stderr)
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
    check('write(create) returns only the documented fields', Object.keys(result).sort().join(',') === 'brief,ok,path,stderr', Object.keys(result).join(','))
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
      'plugin: success render is WROTE plus one stat line, and never echoes the change',
      rendered[0].text === 'WROTE plugin.md\nreplace@2 +1/-1',
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
    check('plugin: failure render says FAIL', editTool.output.render({}, result)[0].text.startsWith('FAIL plugin.md'))
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
 * 契约只有两条：成功是 `WROTE <路径>` 加**一行统计**（不回显改动内容），失败是 `FAIL <路径>` 加完整
 * 原因。这里把"任何规模的改动都不回显"钉成断言——旧实现曾把整文件 diff 当成结果正文，长行的
 * 改动甚至以 1.0x 的放大率原样进入上下文。
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
    !createdText.includes('line 30 of the big file') && createdText === 'WROTE big.txt\nwrite +60/-0',
    createdText,
  )
  check('result: the path appears exactly once in the rendered text', createdText.split('big.txt').length - 1 === 1, createdText)

  // 2) 小改动同样是两行
  writeSample(join(ws, 'small.txt'), ['alpha', 'beta', 'gamma'])
  const small = await editTool.execute({ file_path: 'small.txt', grep: '^beta', new_text: 'BETA\n' }, exec)
  const smallText = textOf(editTool, small)
  check('result: a small edit reports the stat line only', smallText === 'WROTE small.txt\nreplace@2 +1/-1', smallText)
  check(
    'result: no diff body, no backup name, no change content',
    !smallText.includes('BETA') && !smallText.includes('beta') && !smallText.includes('备份'),
    smallText,
  )

  // 3) 长行：压缩为单行的文件曾经整篇进入上下文，现在与文件大小无关
  const longLine = 'const blob = "' + 'x'.repeat(20000) + '"'
  const longWrite = await writeTool.execute({ file_path: 'min.js', content: longLine + '\n' }, exec)
  const longText = textOf(writeTool, longWrite)
  check(
    'result: a single 20 KB line is not echoed',
    longText === 'WROTE min.js\nwrite +1/-0' && Buffer.byteLength(longText, 'utf8') < 64,
    `${Buffer.byteLength(longText, 'utf8')} B\n${longText}`,
  )

  // 4) 宽文件（行数少、行长）同样不回显
  const wide = Array.from({ length: 20 }, (_, i) => `L${i} ${'y'.repeat(5000)}`).join('\n') + '\n'
  const wideText = textOf(writeTool, await writeTool.execute({ file_path: 'wide.txt', content: wide }, exec))
  check('result: 20 lines x 5 KB is not echoed', wideText === 'WROTE wide.txt\nwrite +20/-0', wideText)

  // 5) 一次调用回吐的字节与输入规模无关：这是本契约的核心
  const hugeText = textOf(writeTool, await writeTool.execute({ file_path: 'huge.txt', content: 'z'.repeat(400000) + '\n' }, exec))
  check(
    'result: a 400 KB write still returns a two-line result',
    hugeText === 'WROTE huge.txt\nwrite +1/-0',
    `${Buffer.byteLength(hugeText, 'utf8')} B\n${hugeText}`,
  )

  // 6) 失败路径相反：原因必须完整
  const missing = await editTool.execute({ file_path: 'nope.md', grep: 'x', new_text: 'y\n' }, exec)
  const failText = textOf(editTool, missing)
  check(
    'result: a failure keeps the full reason',
    failText.startsWith('FAIL nope.md\n') && failText.includes('目标不存在'),
    failText,
  )

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
    ['count + nth together', { file_path: 'x', grep: 'a', new_text: 'a', count: 2, nth: 1 }],
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
console.log('── usage errors ──')
usageSuite()

console.log('')
console.log((failures === 0 ? 'OK' : 'FAILED') + ' — ' + (checks - failures) + '/' + checks + ' checks passed')
process.exitCode = failures === 0 ? 0 : 1
