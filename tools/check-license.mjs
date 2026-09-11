// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * check-license.mjs —— 仓库卫生门禁：许可证、零依赖、纯 Node、公开面整洁。
 *
 * 输出分五节，每节一组断言。
 *
 * 用法：node tools/check-license.mjs；退出码 0 = 全过，1 = 有失败。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 违禁词扫描豁免本文件（词表自身含那些词）；行尾检查照旧。 */
const SELF = 'tools/check-license.mjs'

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

/** 读原始字节；失败返回 null。 */
function readBytes(rel) {
  try {
    return readFileSync(join(REPO, rel))
  } catch {
    return null
  }
}

/** 读文本；失败返回空串，由断言给出 FAIL 而不是抛栈。 */
function read(rel) {
  return readBytes(rel)?.toString('utf8') ?? ''
}

/** 读 JSON；缺失或语法错误返回空对象。 */
function readJson(rel) {
  try {
    return JSON.parse(read(rel))
  } catch {
    return {}
  }
}

function listFiles(dir, extension) {
  try {
    return readdirSync(join(REPO, dir))
      .filter((entry) => entry.endsWith(extension))
      .map((entry) => `${dir}/${entry}`)
  } catch {
    return []
  }
}

// ── 一、许可证 ──

const CANONICAL_LINES = 202
const LICENSE_MARKERS = [
  'Apache License',
  'Version 2.0, January 2004',
  'http://www.apache.org/licenses/',
  'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
  'END OF TERMS AND CONDITIONS',
  'APPENDIX: How to apply the Apache License to your work.',
  'Copyright [yyyy] [name of copyright owner]',
  'limitations under the License.',
]
const LICENSE_SECTIONS = [
  '1. Definitions.',
  '2. Grant of Copyright License.',
  '3. Grant of Patent License.',
  '4. Redistribution.',
  '5. Submission of Contributions.',
  '6. Trademarks.',
  '7. Disclaimer of Warranty.',
  '8. Limitation of Liability.',
  '9. Accepting Warranty or Additional Liability.',
]

console.log('── license ──')
{
  const present = existsSync(join(REPO, 'LICENSE'))
  check('LICENSE exists', present)
  const license = present ? read('LICENSE') : ''
  const lines = license.split('\n')
  // 末尾换行多出一个空串，按有效行比较
  const lineCount = license.endsWith('\n') ? lines.length - 1 : lines.length
  check(`LICENSE is the canonical Apache-2.0 text (${CANONICAL_LINES} lines)`, lineCount === CANONICAL_LINES, `实际 ${lineCount} 行`)
  const missingMarkers = LICENSE_MARKERS.filter((marker) => !license.includes(marker))
  check('LICENSE keeps every canonical marker', missingMarkers.length === 0, `缺少：${JSON.stringify(missingMarkers)}`)
  const missingSections = LICENSE_SECTIONS.filter((section) => !license.includes(section))
  check('LICENSE keeps sections 1-9 (not truncated)', missingSections.length === 0, `缺少：${JSON.stringify(missingSections)}`)
}

// ── 二、package.json ──

console.log('')
console.log('── package.json ──')
const pkg = readJson('package.json')
const SHIPPED = Array.isArray(pkg.files) ? pkg.files : []
/** author 可为字符串或对象。 */
const AUTHOR = typeof pkg.author === 'object' && pkg.author !== null ? pkg.author.name : pkg.author

check('package.json license is Apache-2.0', pkg.license === 'Apache-2.0', String(pkg.license))
check('package.json ships LICENSE', SHIPPED.includes('LICENSE'), JSON.stringify(pkg.files))
for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies']) {
  const value = pkg[field]
  check(`no ${field} (this package installs nothing)`, Object.keys(value ?? {}).length === 0, JSON.stringify(value))
}
{
  // peerDependencies 只指向宿主自带的 @deepseek-ai/*：声明要哪个宿主，不是安装第三方包。
  const peers = Object.entries(pkg.peerDependencies ?? {})
  const foreign = peers.filter(([name]) => !name.startsWith('@deepseek-ai/')).map(([name]) => name)
  check('peerDependencies only name host-provided @deepseek-ai/* packages', foreign.length === 0, `非宿主包：${JSON.stringify(foreign)}`)
  check(
    'peerDependencies are written as non-empty version ranges',
    peers.every(([, range]) => typeof range === 'string' && range.trim() !== ''),
    JSON.stringify(pkg.peerDependencies),
  )
}
check('engines.node is declared', typeof pkg.engines?.node === 'string', JSON.stringify(pkg.engines))
{
  // 装出去的包要够用：lib、preset、scripts 由 patch/preset 行与安装路径加载，cordis.patch.yml 是
  // dsh.bundle.patch 的目标，LICENSE 与 README 是发布合规与文档。
  const REQUIRED = ['lib', 'preset', 'scripts', 'cordis.patch.yml', 'README.md', 'LICENSE']
  const missing = REQUIRED.filter((entry) => !SHIPPED.includes(entry))
  check('the package ships everything the install paths need', missing.length === 0, `files 里缺少：${JSON.stringify(missing)}`)
}
{
  // 自测与门禁只在仓库里跑，装出去的用户用不到。
  const shipped = SHIPPED.filter((entry) => entry === 'tools')
  check('the dev tooling stays out of the published package', shipped.length === 0, `files 里不该有：${JSON.stringify(shipped)}`)
}
{
  const missing = SHIPPED.filter((entry) => !existsSync(join(REPO, entry)))
  check('every path in files exists', missing.length === 0, `不存在：${JSON.stringify(missing)}`)
}

// ── 三、SPDX 头 + 零裸依赖 ──

console.log('')
console.log('── source hygiene ──')
const SOURCES = [
  ...listFiles('lib', '.mjs'),
  ...listFiles('tools', '.mjs'),
  ...listFiles('scripts', '.mjs'),
  ...listFiles('preset', '.yml'),
  'cordis.patch.yml',
].filter((rel) => rel !== SELF)

/** 公开面：源码、配置、文档与仓库元文件。 */
const PUBLIC = [
  ...SOURCES,
  'README.md',
  'README.zh.md',
  'package.json',
  'LICENSE',
  '.gitattributes',
  '.gitignore',
]

const head = (rel, lines) => read(rel).split('\n').slice(0, lines)

{
  const noSpdx = SOURCES.filter((rel) => !head(rel, 3).some((line) => line.includes('SPDX-License-Identifier: Apache-2.0')))
  check('every source file carries an Apache-2.0 SPDX header', noSpdx.length === 0, `缺少：${JSON.stringify(noSpdx)}`)
}
{
  // Apache-2.0 不要求把版权行写进 LICENSE（附录的 [yyyy] 是模板，填了反而破坏全文一致），
  // 署名落在 package.json 的 author 与各文件的 SPDX 头，且两者一致。
  check('package.json names the copyright holder (author)', typeof AUTHOR === 'string' && AUTHOR !== '', JSON.stringify(pkg.author))
  const noCopyright = SOURCES.filter((rel) => !head(rel, 4).some((line) => line.includes('SPDX-FileCopyrightText:') && line.includes(AUTHOR)))
  check('every source file names that holder in its SPDX header', noCopyright.length === 0, `缺少或与 author 不一致：${JSON.stringify(noCopyright)}`)
}
{
  // 仓库地址与作者必须同一人：homepage / bugs / repository 曾被写成别人的账号。
  const urls = [pkg.homepage, pkg.bugs?.url, pkg.repository?.url].filter((value) => typeof value === 'string')
  check('homepage / bugs / repository are https URLs', urls.length === 3 && urls.every((url) => url.startsWith('https://')), JSON.stringify(urls))
  const owners = [...new Set(urls.map((url) => /github\.com[/:]([^/]+)\//.exec(url)?.[1]).filter(Boolean))]
  check('homepage / bugs / repository name the same owner', owners.length === 1, JSON.stringify(owners))
  check('the author is that owner', owners[0] === AUTHOR, `author=${AUTHOR} owner=${owners[0]}`)
}

{
  // 裸 package import：不是 node: 内置，也不是相对/绝对路径；跨行 import 与 import('pkg') 同样要抓。
  const SPECIFIERS = [
    /(?:^|\n)\s*import\s+(?:[\w$]+(?:\s*,\s*(?:\*\s*as\s+[\w$]+|\{[^}]*\}))?|\*\s*as\s+[\w$]+|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*export\s+(?:\*|\{[^}]*\})(?:\s+as\s+[\w$]+)?\s*from\s*['"]([^'"]+)['"]/g,
  ]
  const ALLOWED = /^(?:node:|[./]|file:)/
  const offenders = []
  for (const rel of SOURCES.filter((entry) => entry.endsWith('.mjs'))) {
    const text = read(rel)
    for (const pattern of SPECIFIERS) {
      for (const match of text.matchAll(pattern)) {
        if (!ALLOWED.test(match[1])) offenders.push(`${rel}: ${match[1]}`)
      }
    }
  }
  check('no bare package imports anywhere (zero-dependency guarantee)', offenders.length === 0, offenders.join('\n'))
}

// ── 四、纯 Node：代码与配置里不留 Python / 子进程后端 ──

console.log('')
console.log('── Node-only ──')
{
  // 违禁词（大小写不敏感）。preset 组只禁 config.backend：那里的 provider: spawn 与 spawn/fork 是
  // 上游自己的子代理概念，与本插件无关。
  const PYTHON = /python/i
  const PATCH_SCRIPT = /patch\.py/i
  const PY_ENV = /DSH_PYEDITOR/i
  const SUBPROCESS = /child_process/i
  const SPAWN = /\bspawn\b/i
  const BACKEND = /backend/i
  const CONFIG_BACKEND = /config\.backend/i
  const COMMAND_BACKEND = /command-backend/i

  const PY_LEFTOVERS = [['python', PYTHON], ['patch.py', PATCH_SCRIPT], ['DSH_PYEDITOR', PY_ENV]]
  const MATRIX = [
    { files: SOURCES.filter((rel) => rel.startsWith('lib/')), forbidden: [...PY_LEFTOVERS, ['child_process', SUBPROCESS], ['spawn', SPAWN], ['backend', BACKEND]] },
    { files: SOURCES.filter((rel) => rel.startsWith('tools/') || rel.startsWith('scripts/')), forbidden: [...PY_LEFTOVERS, ['child_process', SUBPROCESS]] },
    { files: SOURCES.filter((rel) => rel.startsWith('preset/') || rel === 'cordis.patch.yml'), forbidden: [...PY_LEFTOVERS, ['config.backend', CONFIG_BACKEND]] },
    { files: ['package.json'], forbidden: PY_LEFTOVERS },
    // 公开的 README 不该解释"以前是什么实现"
    { files: ['README.md', 'README.zh.md'], forbidden: [...PY_LEFTOVERS, ['command-backend', COMMAND_BACKEND]] },
  ]

  const offenders = []
  for (const { files, forbidden } of MATRIX) {
    for (const rel of files) {
      const text = read(rel)
      for (const [label, pattern] of forbidden) {
        if (pattern.test(text)) offenders.push(`${rel}: ${label}`)
      }
    }
  }
  check('no Python / external-modifier / subprocess leftovers in code, config or docs', offenders.length === 0, offenders.join('\n'))
}

// ── 五、公开面不含个人本机路径 ──

console.log('')
console.log('── publishing hygiene ──')
{
  // 盘符路径与家目录路径；负向后顾断言排除 http:// 这类 scheme。
  const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/
  const USER_DIR = /(?:\/Users\/|\/home\/|Users\\)/
  const offenders = []
  for (const rel of PUBLIC) {
    const text = read(rel)
    for (const [label, pattern] of [['盘符路径', DRIVE_PATH], ['家目录路径', USER_DIR]]) {
      const match = pattern.exec(text)
      if (match !== null) offenders.push(`${rel}: ${label} → ${JSON.stringify(match[0])}`)
    }
  }
  check('no machine-specific absolute paths in code, config or docs', offenders.length === 0, offenders.join('\n'))
}
{
  // 上游是 MIT：与 Apache-2.0 同行会被读成"上游是 Apache-2.0"，即署名错误。
  const offenders = []
  for (const rel of PUBLIC) {
    read(rel).split('\n').forEach((line, index) => {
      if (/dsh/i.test(line) && /Apache-2\.0/.test(line)) offenders.push(`${rel}:${index + 1}`)
    })
  }
  check(
    'the upstream dsh license is never called Apache-2.0',
    offenders.length === 0,
    `dsh 是 MIT；这些行同时提到两者，请分行或改写：${offenders.join(', ')}`,
  )
}
{
  // preset 组合由安装器在用户机器上从他自己那份派生：不分发上游拷贝，也不随上游升级过期。
  const offenders = SOURCES.filter((rel) => rel.startsWith('preset/') && /^- id: /m.test(read(rel)))
  check(
    'no preset composition is shipped in the repo',
    offenders.length === 0,
    `这些文件看起来是 preset 组合，应当由 scripts/install-preset.mjs 在安装时派生：${JSON.stringify(offenders)}`,
  )
}
{
  // 包名必须与 package.json 一字不差：dsh 按它解析模块，漏改就是装上加载不了。
  const rows = [...read('cordis.patch.yml').matchAll(/^\s*name:\s*'([^']+)'/gm)].map((match) => match[1])
  check(
    'every cordis.patch.yml row names this package',
    rows.length > 0 && rows.every((name) => name === pkg.name),
    `package.json name=${pkg.name} rows=${JSON.stringify(rows)}`,
  )
}
{
  // 安装/卸载命令写的是包名：包名变了不同步，用户照文档装不上。
  const stale = ['README.md', 'README.zh.md'].filter((rel) => !read(rel).includes(pkg.name))
  check('both READMEs name this package', stale.length === 0, `未提及 ${pkg.name}：${JSON.stringify(stale)}`)
}
{
  // 全仓库 LF、无 BOM（README.zh.md 曾被编辑器存成 CRLF）；本文件只豁免违禁词扫描。
  const offenders = []
  for (const rel of [...PUBLIC, SELF]) {
    const bytes = readBytes(rel)
    if (bytes === null) {
      offenders.push(`${rel}: 读不到`)
      continue
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offenders.push(`${rel}: 带 BOM`)
    for (let i = 1; i < bytes.length; i += 1) {
      if (bytes[i] === 0x0a && bytes[i - 1] === 0x0d) {
        offenders.push(`${rel}: CRLF`)
        break
      }
    }
  }
  check('every tracked file is LF without BOM, as .gitattributes requires', offenders.length === 0, offenders.join('\n      '))
}
{
  // 中英混排：汉字与行内代码 / 半角字符之间要有空格，否则连成 "UTF-8BOM" 这样一串；
  // 该规则被编辑器吃掉空格回退过多次，故固化成断言。
  const CJK = '[\\u4e00-\\u9fff]'
  const RULES = [
    ['汉字与行内代码之间少空格', new RegExp(CJK + '\x60')],
    ['行内代码与汉字之间少空格', new RegExp('\x60' + CJK)],
    ['汉字与半角字符之间少空格', new RegExp(CJK + '[A-Za-z0-9]')],
    ['半角字符与汉字之间少空格', new RegExp('[A-Za-z0-9]' + CJK)],
    ['斜杠后紧跟加粗', /\/\*\*(?=[A-Za-z])/],
  ]
  const offenders = []
  for (const rel of ['README.md', 'README.zh.md']) {
    read(rel).split('\n').forEach((line, index) => {
      for (const [label, pattern] of RULES) {
        if (pattern.test(line)) offenders.push(`${rel}:${index + 1} ${label} → ${line.trim().slice(0, 70)}`)
      }
    })
  }
  check('the docs keep a space between CJK and code or latin text', offenders.length === 0, offenders.join('\n      '))
}

// ── 结论 ──

console.log('')
console.log((failures === 0 ? 'OK' : 'FAILED') + ' — ' + (checks - failures) + '/' + checks + ' checks passed')
if (failures === 0) {
  console.log('许可证：Apache-2.0 全文完整且与 package.json 一致；本包不安装任何依赖（peer 只指向宿主自带的 @deepseek-ai/*）⇒ 无第三方许可证义务。')
}
process.exitCode = failures === 0 ? 0 : 1
