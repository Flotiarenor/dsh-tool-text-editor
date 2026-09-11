// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * check-license.mjs —— 仓库卫生门禁：许可证 + 依赖 + "纯 Node" 约束。
 *
 * 它把三件容易腐坏的事变成可复现的断言：
 *   1. **许可证**：LICENSE 是完整、未经改动的 Apache-2.0 全文（1–9 节 + APPENDIX 齐备），
 *      `package.json` 的 `license` 与之相符，`files` 白名单里带着 LICENSE；
 *   2. **依赖**：本包自己不装任何东西（没有 dependencies/optionalDependencies/bundledDependencies），
 *      且 `lib/` `tools/` `scripts/` 里没有任何**裸 package import**（只允许 `node:` 与相对路径）——
 *      这正是 preset 行能用绝对路径加载本插件的前提。`peerDependencies` 只允许写宿主自带的
 *      `@deepseek-ai/*`：那是"需要哪个 dsh"的声明，不是要被安装的依赖；
 *   3. **纯 Node**：代码、配置与文档里都不留 Python / 外部修改器 / 子进程后端的痕迹
 *      （`python`、`.py` 脚本、`DSH_PYEDITOR_*` 环境变量、`child_process`/`spawn`、`config.backend`）。
 *   4. **公开面干净**：任何文件里都不出现作者本机的绝对路径（`X:\...`、`/Users/...`、`/home/...`），
 *      也不出现只在某台机器上成立的目录结构示例。这是一个公开插件：写成通用的占位符（`<...>`）。
 *
 * 用法：node tools/check-license.mjs
 * 退出码：0 = 全过，1 = 有失败。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 本文件豁免扫描：下面的"违禁词表"本身包含那些词，扫自己没有意义。 */
const SELF = fileURLToPath(import.meta.url)

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

function read(rel) {
  return readFileSync(join(REPO, rel), 'utf8')
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

// ── 一、许可证 ──────────────────────────────────────────────────────────────

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
  // 末尾换行会多出一个空串，所以比较行数时按"有效行"算
  const lineCount = license.endsWith('\n') ? lines.length - 1 : lines.length
  check(`LICENSE is the canonical Apache-2.0 text (${CANONICAL_LINES} lines)`, lineCount === CANONICAL_LINES, `实际 ${lineCount} 行`)
  const missingMarkers = LICENSE_MARKERS.filter((marker) => !license.includes(marker))
  check('LICENSE keeps every canonical marker', missingMarkers.length === 0, `缺少：${JSON.stringify(missingMarkers)}`)
  const missingSections = LICENSE_SECTIONS.filter((section) => !license.includes(section))
  check('LICENSE keeps sections 1-9 (not truncated)', missingSections.length === 0, `缺少：${JSON.stringify(missingSections)}`)
}

// ── 二、package.json：许可证一致性 + 零依赖 + files 白名单 ───────────────────

console.log('')
console.log('── package.json ──')
const pkg = JSON.parse(read('package.json'))
check('package.json license is Apache-2.0', pkg.license === 'Apache-2.0', String(pkg.license))
check('package.json ships LICENSE', Array.isArray(pkg.files) && pkg.files.includes('LICENSE'), JSON.stringify(pkg.files))
for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies']) {
  const value = pkg[field]
  check(`no ${field} (this package installs nothing)`, value === undefined || Object.keys(value).length === 0, JSON.stringify(value))
}
{
  // peerDependencies 只允许指向**宿主自带**的 @deepseek-ai/*（由 dsh 安装目录提供）：这样声明的是
  // "需要哪个 dsh"，而不是把第三方包拖进用户的 profile。
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
  // 装出去的包必须"够用"：lib 是 patch/preset 行加载的模块；scripts + preset 是 preset 安装路径要读的
  // 两个文件；cordis.patch.yml 是 dsh.bundle.patch 的目标；LICENSE/README 是发布合规与文档。
  const REQUIRED = ['lib', 'preset', 'scripts', 'cordis.patch.yml', 'README.md', 'LICENSE']
  const missing = REQUIRED.filter((entry) => !(pkg.files ?? []).includes(entry))
  check('the package ships everything the install paths need', missing.length === 0, `files 里缺少：${JSON.stringify(missing)}`)
}
{
  // 开发工具（自测 + 两个门禁）刻意只留在仓库里：它们不是运行时依赖，用户装完也用不到。
  const forbidden = ['tools'].filter((entry) => (pkg.files ?? []).includes(entry))
  check('the dev tooling stays out of the published package', forbidden.length === 0, `files 里不该有：${JSON.stringify(forbidden)}`)
}
{
  const missing = (pkg.files ?? []).filter((entry) => !existsSync(join(REPO, entry)))
  check('every path in files exists', missing.length === 0, `不存在：${JSON.stringify(missing)}`)
}

// ── 三、SPDX 头 + 零裸依赖（只允许 node: 与相对路径）────────────────────────

console.log('')
console.log('── source hygiene ──')
const SOURCES = [
  ...listFiles('lib', '.mjs'),
  ...listFiles('tools', '.mjs'),
  ...listFiles('scripts', '.mjs'),
  ...listFiles('preset', '.yml'),
  'cordis.patch.yml',
].filter((rel) => join(REPO, rel) !== SELF)

/** 公开面：代码、配置，加上随包发布的文档与仓库元文件。 */
const PUBLIC = [
  ...SOURCES,
  'README.md',
  'README.zh.md',
  'package.json',
  'LICENSE',
  '.gitattributes',
  '.gitignore',
]

{
  const noSpdx = SOURCES.filter((rel) => !read(rel).split('\n').slice(0, 3).some((line) => line.includes('SPDX-License-Identifier: Apache-2.0')))
  check('every source file carries an Apache-2.0 SPDX header', noSpdx.length === 0, `缺少：${JSON.stringify(noSpdx)}`)
}
{
  // Apache-2.0 不要求把版权行写进 LICENSE（附录里的 [yyyy] 是说明模板，填了反而破坏全文一致性），
  // 所以署名必须落在两处：package.json 的 author，以及每个文件的 SPDX-FileCopyrightText —— 且两者一致。
  const holder = typeof pkg.author === 'object' && pkg.author !== null ? pkg.author.name : pkg.author
  check('package.json names the copyright holder (author)', typeof holder === 'string' && holder !== '', JSON.stringify(pkg.author))
  const noCopyright = SOURCES.filter((rel) => !read(rel).split('\n').slice(0, 4).some((line) => line.includes('SPDX-FileCopyrightText:') && line.includes(holder)))
  check('every source file names that holder in its SPDX header', noCopyright.length === 0, `缺少或与 author 不一致：${JSON.stringify(noCopyright)}`)
}
{
  // 仓库地址与作者必须是同一个人 —— 之前 homepage/bugs/repository 曾被写成另一个人的账号。
  const urls = [pkg.homepage, pkg.bugs?.url, pkg.repository?.url].filter((value) => typeof value === 'string')
  check('homepage / bugs / repository are https URLs', urls.length === 3 && urls.every((url) => url.startsWith('https://')), JSON.stringify(urls))
  const owners = [...new Set(urls.map((url) => /github\.com[/:]([^/]+)\//.exec(url)?.[1]).filter(Boolean))]
  check('homepage / bugs / repository name the same owner', owners.length === 1, JSON.stringify(owners))
  const holder = typeof pkg.author === 'object' && pkg.author !== null ? pkg.author.name : pkg.author
  check('the author is that owner', owners[0] === holder, `author=${holder} owner=${owners[0]}`)
}

{
  // 裸 package import：既不是 node: 内置，也不是相对/绝对路径 —— 本插件一个都不能有
  const specifier = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
  const offenders = []
  for (const rel of SOURCES.filter((entry) => entry.endsWith('.mjs'))) {
    for (const match of read(rel).matchAll(specifier)) {
      const target = match[1] ?? match[2]
      if (target.startsWith('node:') || target.startsWith('.') || target.startsWith('/') || target.startsWith('file:')) continue
      offenders.push(`${rel}: ${target}`)
    }
  }
  check('no bare package imports anywhere (zero-dependency guarantee)', offenders.length === 0, offenders.join('\n'))
}

// ── 四、纯 Node：代码与配置里不留 Python / 子进程后端 ───────────────────────

console.log('')
console.log('── Node-only ──')
{
  // 违禁词（大小写不敏感）。preset 的 `provider: spawn`、注释里的 spawn/fork **后端** 是 dsh 自己的
  // 子代理概念，与本插件无关，所以那里只匹配真正会造成依赖的写法（config.backend / .py 脚本）。
  const PYTHON = /python/i
  const PATCH_SCRIPT = /patch\.py/i
  const PY_ENV = /DSH_PYEDITOR/
  const SUBPROCESS = /child_process/
  const SPAWN = /\bspawn\b/
  const BACKEND = /backend/
  const CONFIG_BACKEND = /config\.backend/
  const COMMAND_BACKEND = /command-backend/

  const MATRIX = [
    { files: SOURCES.filter((rel) => rel.startsWith('lib/')), forbidden: [['python', PYTHON], ['patch.py', PATCH_SCRIPT], ['DSH_PYEDITOR', PY_ENV], ['child_process', SUBPROCESS], ['spawn', SPAWN], ['backend', BACKEND]] },
    { files: SOURCES.filter((rel) => rel.startsWith('tools/') || rel.startsWith('scripts/')), forbidden: [['python', PYTHON], ['patch.py', PATCH_SCRIPT], ['DSH_PYEDITOR', PY_ENV], ['child_process', SUBPROCESS]] },
    { files: SOURCES.filter((rel) => rel.startsWith('preset/') || rel === 'cordis.patch.yml'), forbidden: [['python', PYTHON], ['patch.py', PATCH_SCRIPT], ['DSH_PYEDITOR', PY_ENV], ['config.backend', CONFIG_BACKEND]] },
    { files: ['package.json'], forbidden: [['python', PYTHON], ['patch.py', PATCH_SCRIPT], ['DSH_PYEDITOR', PY_ENV]] },
    // 文档也面向使用者：公开的 README 不该解释"以前是什么实现"
    { files: ['README.md', 'README.zh.md'], forbidden: [['python', PYTHON], ['patch.py', PATCH_SCRIPT], ['DSH_PYEDITOR', PY_ENV], ['command-backend', COMMAND_BACKEND]] },
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

// ── 五、公开面不含个人本机路径 ──────────────────────────────────────────────

console.log('')
console.log('── publishing hygiene ──')
{
  // 盘符路径（`D:\...`、`C:/...`）与家目录路径（`/Users/x`、`/home/x`）：后者要排除
  // `http://` 这类 scheme —— 负向后顾断言保证"字母+冒号+斜杠"里的字母不是紧跟在字母后面。
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
  // 上游 dsh 是 MIT（`Copyright (c) 2026 DeepSeek`）。把 dsh 与 Apache-2.0 写在同一行，很容易被读成
  // "上游是 Apache-2.0" —— 这正是要避免的署名错误，所以直接禁掉。
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
  // 仓库里不该再出现 **preset 组合**（特征是一串 `- id:` 行）：组合由安装器在用户机器上从他自己那份 dsh
  // 派生 —— 这样既不分发 dsh（MIT）的拷贝，也不会随 dsh 升级而过期。
  const offenders = SOURCES.filter((rel) => rel.startsWith('preset/') && /^- id: /m.test(read(rel)))
  check(
    'no preset composition is shipped in the repo',
    offenders.length === 0,
    `这些文件看起来是 preset 组合，应当由 scripts/install-preset.mjs 在安装时派生：${JSON.stringify(offenders)}`,
  )
}
{
  // patch 行的包名必须与 package.json 一字不差：dsh 按这个名字解析模块，漏改一处 = 装上却加载不了。
  const rows = [...read('cordis.patch.yml').matchAll(/^\s*name:\s*'([^']+)'/gm)].map((match) => match[1])
  check(
    'every cordis.patch.yml row names this package',
    rows.length > 0 && rows.every((name) => name === pkg.name),
    `package.json name=${pkg.name} rows=${JSON.stringify(rows)}`,
  )
}
{
  // 文档里的安装/卸载命令写的是包名：包名变了却不同步，用户照文档装不上。
  const stale = ['README.md', 'README.zh.md'].filter((rel) => !read(rel).includes(pkg.name))
  check('both READMEs name this package', stale.length === 0, `未提及 ${pkg.name}：${JSON.stringify(stale)}`)
}
{
  // 本仓库自己规定 `* text=auto eol=lf`（见 .gitattributes），所以源码与文档必须 LF 且无 BOM。
  // 这条同样被真实踩过：编辑器把 README.zh.md 存成了 CRLF —— 在一个专治行尾的仓库里尤其难看。
  const offenders = []
  for (const rel of PUBLIC) {
    const bytes = readFileSync(join(REPO, rel))
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
  // 中英混排：汉字与 `code` / 半角字符之间要有空格，否则渲染成 "UTF-8BOM"、"从read" 这种粘连。
  // 这条规则被真实回退过多次（编辑器保存时吃掉空格），所以固化成断言而不是靠人眼。
  const CJK = '[\\u4e00-\\u9fff]'
  const RULES = [
    ['汉字与行内代码之间少空格', new RegExp(CJK + '\x60')],
    ['行内代码与汉字之间少空格', new RegExp('\x60' + CJK)],
    ['汉字与半角字符之间少空格', new RegExp(CJK + '[A-Za-z0-9]')],
    ['半角字符与汉字之间少空格', new RegExp('[A-Za-z0-9]' + CJK)],
    ['斜杠后紧跟加粗', /[^\s]\*\*(?=[A-Za-z])/],
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

// ── 结论 ────────────────────────────────────────────────────────────────────

console.log('')
console.log((failures === 0 ? 'OK' : 'FAILED') + ' — ' + (checks - failures) + '/' + checks + ' checks passed')
if (failures === 0) {
  console.log('许可证：Apache-2.0 全文完整且与 package.json 一致；本包不安装任何依赖（peer 只指向宿主自带的 @deepseek-ai/*）⇒ 无第三方许可证义务。')
}
process.exitCode = failures === 0 ? 0 : 1
