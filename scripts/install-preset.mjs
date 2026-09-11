#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * install-preset.mjs —— 把 `edit_text` / `write_text` 装成一个**用户 preset**。
 *
 * 做法：读**本机 dsh 自带的 preset 组合**（默认 `standard`），把 `tool-text-editor` 那一行插进去，
 * 再连同本仓库的 `preset/preset.yml` 写到 `<DSH_HOME>/.agent-presets/<id>/`。
 *
 * 为什么不在仓库里放一份 preset 组合的拷贝：
 *   * dsh 自带的组合是**别人（MIT, Copyright (c) 2026 DeepSeek）的作品**，随包分发它就要连带履行
 *     它的署名义务，而这份拷贝与本插件的功能无关；
 *   * 从用户自己的 dsh 里取，preset 自然跟着他装的 dsh 版本走 —— 不会像拷贝那样随 dsh 升级而过期。
 *
 * 用法：
 *   node scripts/install-preset.mjs                      # 默认 --id texteditor --base standard
 *   node scripts/install-preset.mjs --id my-edit --base code
 *   node scripts/install-preset.mjs --from <path-to-agent.cordis.yml>   # 自己指定源组合
 *   node scripts/install-preset.mjs --force              # 覆盖已存在的 preset（只覆盖两个文件）
 *   node scripts/install-preset.mjs --dry-run            # 只打印会做什么，不落盘
 *
 * 退出码：0 成功，1 失败，2 用法错误 / 找不到 dsh 自带的 preset 组合。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PLUGIN = join(REPO, 'lib', 'editor.mjs').replace(/\\/g, '/')
const META = join(REPO, 'preset', 'preset.yml')
const SHIPPED_PRESET_DIR = ['config', 'agent-presets']
const COMPOSITION = 'agent.cordis.yml'

function flagValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error('FAIL ' + name + ' 缺少取值')
    process.exit(2)
  }
  return value
}

/**
 * dsh 可能装在任何位置，所以按布局枚举"自带 preset 组合"的候选路径（不写死本机路径）：
 *   1. `--from` / `DSH_PRESET_SOURCE` —— 显式指定，任何布局都能用；
 *   2. dsh profile 的 node_modules（`<DSH_HOME|~/.dsh>/profiles/node_modules`）；
 *   3. npm 全局前缀下的 node_modules（Windows `%APPDATA%\npm`；POSIX `/usr/local/lib`、
 *      `/usr/lib`、`~/.npm-global/lib`）。
 * @param base - 自带 preset 的 id（standard / code / cordis / minimal）。
 * @returns 候选绝对路径（按优先级）。
 */
function findCompositions(base) {
  const candidates = []
  const explicit = flagValue('--from') ?? process.env.DSH_PRESET_SOURCE
  if (typeof explicit === 'string' && explicit !== '') candidates.push(resolve(explicit))
  const add = (nodeModules) => {
    if (typeof nodeModules !== 'string' || nodeModules === '') return
    candidates.push(join(nodeModules, '@deepseek-ai', 'dsh', ...SHIPPED_PRESET_DIR, base, COMPOSITION))
  }
  add(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules'))
  const globalRoots = process.platform === 'win32'
    ? [process.env.APPDATA === undefined ? '' : join(process.env.APPDATA, 'npm', 'node_modules')]
    : ['/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.npm-global', 'lib', 'node_modules')]
  for (const root of globalRoots) add(root)
  return candidates
}

/** 我们插进组合里的那一段（只有这一段是我们自己的文字 + 行）。 */
function pluginBlock(sourcePath) {
  return [
    '# ── 字节保真的文本编辑工具（edit_text / write_text）─────────────────────────',
    '#',
    '# 存在理由（三条）：原生 `write` 丢掉 UTF-8 BOM 并把 CRLF 文件改写成 LF，原生 `edit` 也丢 BOM，',
    '# 且只做精确匹配（`old_string` 差一个空格就报 FS_EDIT_NOT_FOUND）。这两个工具保住 BOM 与行尾，',
    '# 用"精确 → 宽松 → 最接近候选"匹配，并带上落盘前备份、编辑台账与 grep/lines 锚点；结果只回',
    '# 一行统计，不回显改动内容。实现是**进程内 Node**：零依赖、零外部运行时、每次调用没有进程',
    '# 启动开销（不启动任何解释器或外部命令）。',
    '#',
    '# 原生 `edit`/`write` **保留不动**：本行注册的是两个**不同名**工具，同一层不会同名冲突，',
    '# 想回退只需给这一行加 `disabled: true`（或整行删掉）。',
    '#',
    '# 本文件由 `scripts/install-preset.mjs` 生成：源 = 本机 dsh 自带的 preset 组合',
    `#   ${sourcePath}`,
    '# 行名写的是本仓库 `lib/editor.mjs` 的绝对路径 —— preset 行的**裸包名**会从宿主组装基址解析，',
    '# 但模块**内部的**裸 import 由 Node 按文件真实路径解析，而 preset 目录下没有 node_modules，',
    '# 所以该插件刻意零依赖（只用 node: 内置模块），可以放在任何位置。',
    '#',
    '# 该插件消费宿主服务（tools / systemPrompt），不发布任何服务，因此不需要 isolate realm。',
    '#',
    '# 可选 config（插件没有 Config schema，字段原样透传）：',
    '#   backup / ledger: boolean   默认都 true（备份到 artifactsDir/backups，台账 artifactsDir/edits.log）',
    '#   artifactsDir: <路径>       默认 <会话工作区>/.dsh',
    '#   newFileBom: boolean        默认 false（新建文件是否写 BOM）',
    '#   context: number            diff 上下文行数，默认 3',
    '#   root: <路径>               没有 agent 会话时的回退工作区',
    '- id: tool-text-editor',
    `  name: '${PLUGIN}'`,
    '',
  ].join('\n')
}

/** 插入位置：dsh 自带组合里"文件系统"之后、"后台任务"之前；找不到锚点就追加到末尾。 */
const ANCHORS = [
  { pattern: /^# ── background jobs/m, label: 'background jobs 段之前' },
  { pattern: /^- id: tool-jobs$/m, label: 'tool-jobs 行之前' },
]

/**
 * 把插件段插进源组合。
 * @returns `{ text, anchor }`
 * @throws {Error} 源组合看起来已经打过补丁时。
 */
function inject(source, sourcePath) {
  if (/^- id: tool-text-editor$/m.test(source)) {
    throw new Error('源组合里已经有 tool-text-editor 行了 —— 请指向 dsh 自带的原始组合')
  }
  const block = pluginBlock(sourcePath)
  for (const { pattern, label } of ANCHORS) {
    const match = pattern.exec(source)
    if (match !== null) {
      const at = match.index
      return { text: source.slice(0, at) + block + '\n' + source.slice(at), anchor: label }
    }
  }
  const separator = source.endsWith('\n') ? '\n' : '\n\n'
  return { text: source + separator + block, anchor: '文件末尾' }
}

// ── 参数与前置检查 ──────────────────────────────────────────────────────────

const id = flagValue('--id') ?? 'texteditor'
const base = flagValue('--base') ?? 'standard'
const force = process.argv.includes('--force')
const dryRun = process.argv.includes('--dry-run')
const fromFlag = flagValue('--from')

if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error('FAIL preset id 必须是 [a-z0-9][a-z0-9-]*（会作为目录名），收到：' + id)
  process.exit(2)
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(base)) {
  console.error('FAIL --base 必须是 dsh 自带 preset 的 id（如 standard / code / minimal），收到：' + base)
  process.exit(2)
}
if (!existsSync(PLUGIN)) {
  console.error('FAIL 找不到插件文件：' + PLUGIN)
  process.exit(1)
}
if (!existsSync(META)) {
  console.error('FAIL 找不到 preset 元数据：' + META)
  process.exit(1)
}

const candidates = findCompositions(base)
const sourcePath = candidates.find((candidate) => existsSync(candidate))
if (sourcePath === undefined) {
  console.error(`FAIL 找不到本机 dsh 自带的 preset 组合（--base ${base}）；试过：`)
  for (const candidate of candidates) console.error('  ' + candidate)
  console.error('     装了 dsh 就有；也可以用 --from <agent.cordis.yml 路径> 或 DSH_PRESET_SOURCE 指定。')
  process.exit(2)
}

const source = readFileSync(sourcePath, 'utf8')
let injected
try {
  injected = inject(source, sourcePath)
} catch (error) {
  console.error('FAIL ' + error.message)
  process.exit(2)
}

const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const targetDir = join(dshHome, '.agent-presets', id)
const targetComposition = join(targetDir, COMPOSITION)
const targetMeta = join(targetDir, 'preset.yml')

console.log('仓库        : ' + REPO)
console.log('插件        : ' + PLUGIN)
console.log('源组合      : ' + sourcePath + (fromFlag === undefined && process.env.DSH_PRESET_SOURCE === undefined ? `（--base ${base}）` : ''))
console.log('插入位置    : ' + injected.anchor)
console.log('DSH_HOME    : ' + dshHome)
console.log('目标 preset : ' + targetDir)

const exists = existsSync(targetComposition)

if (dryRun) {
  console.log('')
  console.log('[dry-run] 会写入：')
  console.log('  ' + targetComposition + `（源组合 ${source.split('\n').length} 行 + 插件段）`)
  console.log('  ' + targetMeta)
  if (exists && !force) {
    console.error('')
    console.error('[dry-run] 但目标已存在，真跑会被拒绝：' + targetComposition)
    console.error('          要覆盖请加 --force（只覆盖 agent.cordis.yml 与 preset.yml，同目录其它文件不动）。')
    process.exit(1)
  }
  process.exit(0)
}

if (exists && !force) {
  console.error('')
  console.error('FAIL 该 preset 已存在：' + targetComposition)
  console.error('      要覆盖请加 --force（只覆盖 agent.cordis.yml 与 preset.yml，同目录其它文件不动）。')
  process.exit(1)
}
if (exists) {
  console.log('注意        : --force 将覆盖 ' + targetComposition)
}

mkdirSync(targetDir, { recursive: true })
writeFileSync(targetComposition, injected.text, 'utf8')
writeFileSync(targetMeta, readFileSync(META, 'utf8'), 'utf8')

console.log('')
console.log('OK 已安装 preset "' + id + '"')
console.log('下一步：')
console.log('  1. 重启 dsh web（preset 名单在启动时读取；运行中的会话不会换 preset）')
console.log('  2. 新建一个会话，preset 选 "' + id + '"')
console.log('  3. 会话里直接用 edit_text / write_text（纯 Node 进程内实现：零依赖、零外部运行时）')
console.log('升级 dsh 后重跑本脚本（加 --force）即可让 preset 跟上新版自带组合。')
console.log('回退：给 ' + targetComposition + ' 里的 tool-text-editor 行加 disabled: true，或删掉 ' + targetDir)
