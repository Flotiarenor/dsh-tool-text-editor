#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * install-preset.mjs —— 把 `edit_text` / `write_text` 装成一个用户 preset：读本机 dsh 自带的 preset 组合
 * （默认 `standard`），插入 `tool-text-editor` 行，连同 `preset/preset.yml` 写到
 * `<DSH_HOME>/.agent-presets/<id>/`。
 *
 * 组合必须从用户自己的 dsh 派生，不在仓库里放拷贝：自带组合是别人（MIT, Copyright (c) 2026 DeepSeek）的
 * 作品，随包分发要连带履行其署名义务。
 *
 * 用法：`node scripts/install-preset.mjs [--id <id>] [--base <id>] [--from <组合路径>] [--force] [--dry-run]
 * [--mask-native]`；`--id` 默认 `texteditor`，`--base` 默认 `standard`。
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
const MASK = join(REPO, 'lib', 'mask.mjs').replace(/\\/g, '/')
const META = join(REPO, 'preset', 'preset.yml')
/**
 * 自带 preset 组合的两种布局（按版本从上到下试）：`@deepseek-ai/dsh/config/agent-presets/<base>/`
 * （≤ 0.1.0-rc.6）与 `@deepseek-ai/dsh-agent-presets/presets/<base>/`（0.1.5-rc.2 起自带组合搬进另一个
 * 包，该包按 `new URL('../presets/', import.meta.url)` 定位，旧路径在新版里已不存在）。
 */
const SHIPPED_LAYOUTS = [
  ['dsh', 'config', 'agent-presets'],
  ['dsh-agent-presets', 'presets'],
]
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
 * 枚举自带 preset 组合的候选路径（dsh 可能装在任何位置，故不写死本机路径）：`--from` /
 * `DSH_PRESET_SOURCE` → profile 的 node_modules（`<DSH_HOME>` 与默认 `~/.dsh` 都试：`DSH_HOME` 可能被指到
 * 别处如临时目录，而 dsh 本体仍在默认 home 下）→ npm 全局前缀。
 * @param explicitPath - 显式指定的源组合（已确认存在）。
 */
function findCompositions(base, explicitPath, dshHome) {
  const candidates = explicitPath === undefined ? [] : [explicitPath]
  const add = (nodeModules) => {
    if (nodeModules === '') return
    for (const layout of SHIPPED_LAYOUTS) {
      candidates.push(join(nodeModules, '@deepseek-ai', ...layout, base, COMPOSITION))
    }
  }
  for (const home of new Set([dshHome, join(homedir(), '.dsh')])) {
    add(join(home, 'profiles', 'node_modules'))
  }
  const globalRoots = process.platform === 'win32'
    ? [process.env.APPDATA === undefined ? '' : join(process.env.APPDATA, 'npm', 'node_modules')]
    : ['/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.npm-global', 'lib', 'node_modules')]
  for (const root of globalRoots) add(root)
  return candidates
}

/**
 * 插进组合里的那一段（只有这一段是本仓库自己的文字与行）。
 * @param sourcePath - 源组合路径（写进注释，便于升级后重跑）。
 * @param maskNative - 是否插入屏蔽原生 write/edit 的门禁行，并让编辑行改用短引导。
 * @returns 插件段文本（以单个换行结尾）。
 */
function pluginBlock(sourcePath, maskNative) {
  const lines = [
    '# ── 字节保真的文本编辑工具（edit_text / write_text）─────────────────────────',
    '#',
    '# 原生 `edit` / `write` 都会丢 UTF-8 BOM，且不还原文件自身的行尾（往 CRLF 文件写 LF 内容就变成 LF）；',
    '# 原生 `edit` 还只做精确匹配（`old_string` 差一个空格就报 FS_EDIT_NOT_FOUND）。本行两个工具保 BOM 与文件',
    '# 自身行尾，精确失败时按行块相似度回退并给出最接近的候选。read-only 会话下在任何 I/O 之前拒写；模型可见',
    '# 文本只有一行统计。',
    '#',
    ...(maskNative
      ? ['# 原生 `edit`/`write` 由下面的门禁行按 agent 作用域屏蔽，本行因此改用 `guidance: short`。']
      : ['# 原生 `edit`/`write` 保留不动：注册的是两个不同名工具，同一层不会同名冲突（回退：给本行加',
        '# `disabled: true`，或整行删掉）。']),
    '#',
    '# 由 `scripts/install-preset.mjs` 从本机 dsh 自带的 preset 组合派生：',
    `#   ${sourcePath}`,
    '# 行名写绝对路径：preset 行的裸包名由宿主组装基址解析，模块内部的裸 import 由 Node 按文件真实路径解析，',
    '# 而 preset 目录下没有 node_modules —— 该插件刻意零依赖（只用 node: 内置模块），可放任何位置。',
    '#',
    '# 可选 config（插件没有 Config schema，字段原样透传）：',
    '#   newFileBom: boolean        默认 false（新建文件是否写 BOM）',
    '#   root: <路径>               没有 agent 会话时的回退工作区',
    '#   guidance: full|short|false 默认 full；short 去掉"优先于原生"那半句',
    '- id: tool-text-editor',
    `  name: '${PLUGIN}'`,
    ...(maskNative ? ['  config:', '    guidance: short'] : []),
  ]
  if (maskNative) {
    lines.push(
      '',
      '# ── 屏蔽原生的 write / edit（每个 agent 的作用域）──────────────────────────',
      '#',
      '# 原生两个工具仍在工具表里：每次请求付 1754 B 的两个 schema 加 608 B 的两段引导，只为劝模型别用它们。',
      '# 本行按 agent 作用域收窄，三条通路任一条先到就先收窄（早先只挂 `agent/created`，而 GUI 是"先建 agent、',
      '# 后换 preset"，重挂是父级 re-link，那个事件早已发完）：',
      '#   * `apply` 阶段就挂守卫：与创建顺序无关，第一次直呼原生工具即被否决并顺手收窄；',
      '#   * `agent/created`：建档时收窄本 preset 的 agent（含 subagent）；',
      '#   * `tools/change`：换 preset 时 `recompose()` 发它，此时枚举活 agent 收窄属于本组合的，反向换出的成对撤销。',
      '#',
      '# 收窄用 `agent.ctx.tools.restrict({ deny })`：注册表只有一套可见性解析器，被拒的名字既不在工具表里也调不动',
      '# （直呼得到 UNKNOWN_TOOL）；另注册同名空段遮蔽 tool:write / tool:edit 引导。只影响选了本 preset 的会话，',
      '# 其它 preset 照旧可用（天然对照组）；只点名本 agent 真的看得见的工具，归属判据靠探测对象的身份。',
      '# `mode: guard` 改为"可见但拒绝"，`sections: []` 保留那两段引导；回退：删掉本行或给编辑行加',
      '# `guidance: full`。',
      '- id: tool-native-edit-mask',
      `  name: '${MASK}'`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

/** 插入位置：自带组合里"文件系统"之后、"后台任务"之前；找不到锚点就追加到末尾。 */
const ANCHORS = [
  { pattern: /^# ── background jobs/m, label: 'background jobs 段之前' },
  { pattern: /^- id: tool-jobs$/m, label: 'tool-jobs 行之前' },
]

/**
 * 把插件段插进源组合。
 * @returns `{ text, anchor }`
 * @throws {Error} 源组合看起来已经打过补丁时。
 */
function inject(source, sourcePath, maskNative) {
  if (/^- id: tool-text-editor$/m.test(source)) {
    throw new Error('源组合里已经有 tool-text-editor 行了 —— 请指向 dsh 自带的原始组合')
  }
  const block = pluginBlock(sourcePath, maskNative)
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

// ── 参数与前置检查 ──

const id = flagValue('--id') ?? 'texteditor'
const base = flagValue('--base') ?? 'standard'
const force = process.argv.includes('--force')
const dryRun = process.argv.includes('--dry-run')
const maskNative = process.argv.includes('--mask-native')
/** `--from` / `DSH_PRESET_SOURCE`：显式源组合，给定时不再枚举自带布局。 */
const explicitSource = (flagValue('--from') ?? process.env.DSH_PRESET_SOURCE ?? '').trim()
const explicitPath = explicitSource === '' ? undefined : resolve(explicitSource)
/** 生效的用户目录：`DSH_HOME` 非空则用它，否则 `~/.dsh`。 */
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error('FAIL preset id 必须是 [a-z0-9][a-z0-9-]*（会作为目录名），收到：' + id)
  process.exit(2)
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(base)) {
  console.error('FAIL --base 必须是 dsh 自带 preset 的 id（如 standard / minimal / cordis / ptc），收到：' + base)
  process.exit(2)
}
if (!existsSync(PLUGIN)) {
  console.error('FAIL 找不到插件文件：' + PLUGIN)
  process.exit(1)
}
if (maskNative && !existsSync(MASK)) {
  console.error('FAIL 找不到门禁文件：' + MASK + '（--mask-native 需要它）')
  process.exit(1)
}
if (!existsSync(META)) {
  console.error('FAIL 找不到 preset 元数据：' + META)
  process.exit(1)
}
if (explicitPath !== undefined && !existsSync(explicitPath)) {
  console.error('FAIL --from / DSH_PRESET_SOURCE 指向的组合不存在：' + explicitPath)
  process.exit(2)
}

const candidates = findCompositions(base, explicitPath, dshHome)
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
  injected = inject(source, sourcePath, maskNative)
} catch (error) {
  console.error('FAIL ' + error.message)
  process.exit(2)
}

/**
 * 写出的 `preset.yml` 必须与实际组合一致：仓库那份与模式无关，而"原生工具是否被屏蔽"随 `--mask-native` 变
 * （旧版原样拷贝，开着门禁的描述里也写着"原生 edit/write 保持不变"）。状态句接在 `preset/preset.yml` 的最后
 * 一行 `description:` 之后；它是 YAML 纯标量，不能出现 `: ` 或 ` #`。
 */
function metadataText() {
  const state = maskNative
    ? '；原生 `edit`/`write` 已被门禁行按 agent 作用域屏蔽：既不出现在工具表里，也调不动。'
    : '；原生 edit/write 保持不变。'
  return readFileSync(META, 'utf8').trimEnd() + state + '\n'
}

const targetDir = join(dshHome, '.agent-presets', id)
const targetComposition = join(targetDir, COMPOSITION)
const targetMeta = join(targetDir, 'preset.yml')

console.log('仓库        : ' + REPO)
console.log('插件        : ' + PLUGIN)
if (maskNative) console.log('门禁        : ' + MASK + '（屏蔽原生 write/edit，编辑行 guidance: short）')
console.log('源组合      : ' + sourcePath + (explicitPath === undefined ? `（--base ${base}）` : ''))
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
    // 只预告冲突：dry-run 不落盘，退出码按契约仍为 0。
    console.error('')
    console.error('[dry-run] 但目标已存在，真跑会被拒绝：' + targetComposition)
    console.error('          要覆盖请加 --force（只覆盖 agent.cordis.yml 与 preset.yml，同目录其它文件不动）。')
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
writeFileSync(targetMeta, metadataText(), 'utf8')

console.log('')
console.log('OK 已安装 preset "' + id + '"')
console.log('下一步：')
console.log('  1. 重启 dsh web（preset 名单在启动时读取；运行中的会话不会换 preset）')
console.log('  2. 新建一个会话，preset 选 "' + id + '"')
console.log('  3. 会话里直接用 edit_text / write_text（纯 Node 进程内实现：零依赖、零外部运行时）')
if (maskNative) {
  console.log('     该 preset 的会话里原生 write/edit 既不出现在工具表里、也调不动（直呼得到 UNKNOWN_TOOL）；')
  console.log('     想对比或观察原生行为，用别的 preset（如 standard）新建会话即可 —— 门禁只作用于本 preset。')
}
console.log('升级 dsh 后重跑本脚本（加 --force）即可让 preset 跟上新版自带组合。')
console.log('回退：给 ' + targetComposition + ' 里的 tool-text-editor 行加 disabled: true，或删掉 ' + targetDir)
if (maskNative) console.log('      只想撤掉屏蔽：删掉同文件里的 tool-native-edit-mask 行，并把编辑行的 guidance 改回 full。')
