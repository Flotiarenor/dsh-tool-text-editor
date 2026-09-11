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
 *   node scripts/install-preset.mjs --id my-edit --base minimal
 *   node scripts/install-preset.mjs --from <path-to-agent.cordis.yml>   # 自己指定源组合
 *   node scripts/install-preset.mjs --force              # 覆盖已存在的 preset（只覆盖两个文件）
 *   node scripts/install-preset.mjs --dry-run            # 只打印会做什么，不落盘
 *   node scripts/install-preset.mjs --mask-native        # 额外插入屏蔽原生 write/edit 的门禁行
 *   node scripts/install-preset.mjs --mask-native --escape   # 门禁 + native_edit/native_write 逃生口
 *
 * `--mask-native` 会多插一行 `tool-native-edit-mask`（`lib/mask.mjs`），并给编辑行写
 * `guidance: short`：这个 preset 的会话里，原生 `write`/`edit` 既不出现在工具表里也调不动，
 * 两段原生引导也被空段遮蔽（原生那一对约 2.4 KB/请求不再下发）。其它 preset 的会话不受影响，可作对照组。
 * 净账（含本插件自己的两个 schema）用 `node tools/bench-tokens.mjs` 量。
 *
 * `--escape` 给门禁行加 `escape: true`：原生名字仍不可见，但执行体以 `native_edit`/`native_write`
 * 回到该 agent 的作用域，便于随时对照原生行为；代价是两张 schema 重新下发（实测约 493 token/请求）。
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
 * dsh 自带 preset 组合在 `node_modules` 里的布局，按版本从上到下试：
 *   * `@deepseek-ai/dsh/config/agent-presets/<base>/` —— ≤ 0.1.0-rc.6 的布局（本脚本最初就是照它写的）；
 *   * `@deepseek-ai/dsh-agent-presets/presets/<base>/` —— 0.1.5-rc.2 起自带组合搬进了**另一个包**
 *     （该包用 `SHIPPED_PRESET_ROOT = new URL('../presets/', import.meta.url)` 自己定位），
 *     旧路径 `@deepseek-ai/dsh/config` 在新版里已经不存在。
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
    for (const layout of SHIPPED_LAYOUTS) {
      candidates.push(join(nodeModules, '@deepseek-ai', ...layout, base, COMPOSITION))
    }
  }
  add(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules'))
  const globalRoots = process.platform === 'win32'
    ? [process.env.APPDATA === undefined ? '' : join(process.env.APPDATA, 'npm', 'node_modules')]
    : ['/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.npm-global', 'lib', 'node_modules')]
  for (const root of globalRoots) add(root)
  return candidates
}

/**
 * 我们插进组合里的那一段（只有这一段是我们自己的文字 + 行）。
 * @param sourcePath - 源组合路径（写进注释，便于升级后重跑）。
 * @param maskNative - 是否同时插入"屏蔽原生 write/edit"的门禁行，并让编辑行改用短引导。
 * @param escape - 门禁行是否带 `escape: true`（原生执行体以 `native_edit` / `native_write` 保留）。
 */
function pluginBlock(sourcePath, maskNative, escape = false) {
  const editorTail = [
    '# 可选 config（插件没有 Config schema，字段原样透传）：',
    '#   backup / ledger: boolean   默认都 true（备份到 artifactsDir/backups，台账 artifactsDir/edits.log）',
    '#   artifactsDir: <路径>       默认 <会话工作区>/.dsh',
    '#   newFileBom: boolean        默认 false（新建文件是否写 BOM）',
    '#   context: number            diff 上下文行数，默认 3',
    '#   root: <路径>               没有 agent 会话时的回退工作区',
    '#   guidance: full|short|false 默认 full；short 去掉"优先于原生"那半句（原生已被下面的门禁屏蔽）',
    '- id: tool-text-editor',
    `  name: '${PLUGIN}'`,
    ...(maskNative
      ? ['  config:', '    guidance: short']
      : []),
    '',
  ]
  const maskLines = maskNative
    ? [
      '',
      '# ── 屏蔽原生的 write / edit（每个 agent 的作用域）──────────────────────────',
      '#',
      '# 原生两个工具即便有上面那对工具也仍在工具表里，每次请求要付 1754 B 的两个 schema 加 608 B 的',
      '# 两段引导，而它们存在的唯一作用就是让模型**别**用原生工具。这一行把它按 agent 作用域收窄——',
      '# 三条通路任何一条先到就先收窄（0.1.5-rc.2 之后重写过：早先只挂 `agent/created`，而 GUI 是',
      '# "先建 agent、后换 preset"，重挂是父级 re-link，那个事件早就发完了）：',
      '#   * `apply` 阶段就挂守卫：与创建顺序无关，第一次直呼原生工具就被否决（原因里点名 edit_text /',
      '#     write_text），并顺手收窄，于是下一次请求的工具表就干净了；',
      '#   * `agent/created`：建档时就加入本 preset 的 agent（含 subagent）立即收窄；',
      '#   * `tools/change`：换 preset 时 `recompose()` 会发它，此时枚举活 agent，把属于本组合的收窄；',
      '#     反方向换出去的 agent 会被成对撤销，不会卡成"一个写工具都没有"。',
      '#',
      '# 收窄用的是 `agent.ctx.tools.restrict({ deny })`：注册表只有一套可见性解析器，schema 下发、查找',
      '# 与派发读同一张视图，所以被拒的名字既不出现在工具表里，也调不动（直呼得到 UNKNOWN_TOOL）；',
      '# 另外在更近的层注册同名**空段**遮蔽 tool:write / tool:edit 引导（0.1.5-rc.2 起那段引导自己就按',
      '# 可见性求值了，空段只是冗余的保险）。',
      '#',
      '# 只影响选了本 preset 的会话：其它 preset 与 profile 层的会话里原生工具照旧可用（天然的对照组，',
      '# 想随时观察或对比原生行为就用那边的新会话）。',
      '#',
      '# 只写模型看不见的名字才安全：门禁只点名"本 agent 真的看得见"的工具，preset 没挂 tool-fs 时不会',
      '# 因未知名字抛错（归属判据本身也不靠名字，靠探测对象的身份）。`mode: guard` 可换成"工具保持可见、',
      '# 调用被否决"：想留观察窗时用它，schema 的钱照付、两段引导仍被空段遮蔽；`sections: []` 则保留原生',
      '# 那两段引导文字。',
      '#',
      '# 回退：删掉这一行（或给编辑行加 `guidance: full` 恢复原引导段）。',
      ...(escape
        ? [
          '#',
          '# `escape: true`：原生**名字**仍然看不见（直呼 `edit` / `write` 得到 UNKNOWN_TOOL），但执行体以',
          '# `native_edit` / `native_write` 回到本 agent 自己的作用域 —— 想对照或观察原生行为时不必换会话。',
          '# 代价是这两张 schema 重新下发（实测约 1.9 KB ≈ 493 token/请求，见 `node tools/bench-tokens.mjs`）。',
        ]
        : []),
      '- id: tool-native-edit-mask',
      `  name: '${MASK}'`,
      ...(escape ? ['  config:', '    escape: true'] : []),
      '',
    ]
    : []
  return [
    '# ── 字节保真的文本编辑工具（edit_text / write_text）─────────────────────────',
    '#',
    '# 存在理由（三条）：原生 `write` 丢掉 UTF-8 BOM 并把 CRLF 文件改写成 LF，原生 `edit` 也丢 BOM，',
    '# 且只做精确匹配（`old_string` 差一个空格就报 FS_EDIT_NOT_FOUND）。这两个工具保住 BOM 与行尾，',
    '# 用"精确 → 宽松 → 最接近候选"匹配，并带上落盘前备份、编辑台账与 grep/lines 锚点。',
    '#',
    '# 模型可见文本只有一行统计：既不回显改动内容（调用方刚发过 new_text），也不回显路径（结果与调用',
    '# 一一绑定，file_path 就在参数里）。"哪个文件、改了什么"由呈现通道承担——presentCall /',
    '# presentationMeta / presentResult 给 GUI 画 diff 卡片，载荷有上限且不进模型上下文。',
    '#',
    '# read-only 会话下两个工具都在任何 I/O 之前拒写：写盘绕开 ctx.fs，这条路径上没有第二个强制点，',
    '# 所以插件把宿主 sandboxPolicy 里唯一禁止写入的那一档镜像了回来（其余模式仍按常量护栏）。',
    '#',
    '# 实现是**进程内 Node**：零依赖、零外部运行时、每次调用没有进程启动开销（不启动任何解释器或',
    '# 外部命令）。',
    '#',
    ...(maskNative
      ? ['# 原生 `edit`/`write` 由下面的门禁行按 agent 作用域屏蔽（本行自己也就不再需要"优先于原生"那',
        '# 半句引导，见编辑器行的 `guidance: short`）。']
      : ['# 原生 `edit`/`write` **保留不动**：本行注册的是两个**不同名**工具，同一层不会同名冲突，',
        '# 想回退只需给这一行加 `disabled: true`（或整行删掉）。']),
    '#',
    '# 本文件由 `scripts/install-preset.mjs` 生成：源 = 本机 dsh 自带的 preset 组合',
    `#   ${sourcePath}`,
    '# 行名写的是本仓库 `lib/editor.mjs` 的绝对路径 —— preset 行的**裸包名**会从宿主组装基址解析，',
    '# 但模块**内部的**裸 import 由 Node 按文件真实路径解析，而 preset 目录下没有 node_modules，',
    '# 所以该插件刻意零依赖（只用 node: 内置模块），可以放在任何位置。',
    '#',
    '# 该插件消费宿主服务（tools / systemPrompt），不发布任何服务，因此不需要 isolate realm。',
    '#',
    ...editorTail,
    ...maskLines,
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
function inject(source, sourcePath, maskNative, escape) {
  if (/^- id: tool-text-editor$/m.test(source)) {
    throw new Error('源组合里已经有 tool-text-editor 行了 —— 请指向 dsh 自带的原始组合')
  }
  const block = pluginBlock(sourcePath, maskNative, escape)
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
const maskNative = process.argv.includes('--mask-native')
const escape = process.argv.includes('--escape')
const fromFlag = flagValue('--from')

if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error('FAIL preset id 必须是 [a-z0-9][a-z0-9-]*（会作为目录名），收到：' + id)
  process.exit(2)
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(base)) {
  console.error('FAIL --base 必须是 dsh 自带 preset 的 id（如 standard / minimal / cordis / ptc），收到：' + base)
  process.exit(2)
}
if (escape && !maskNative) {
  console.error('FAIL --escape 只对 --mask-native 有意义（它加在门禁行上）。')
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
  injected = inject(source, sourcePath, maskNative, escape)
} catch (error) {
  console.error('FAIL ' + error.message)
  process.exit(2)
}

/**
 * 写出去的 `preset.yml` 要跟**实际组合**一致。
 *
 * `preset/preset.yml` 是仓库里那份与模式无关的文字，而这一行状态是随 `--mask-native` / `--escape`
 * 变的：旧版脚本原样拷贝，于是开着门禁的 preset 描述里也一直写着"原生 edit/write 保持不变"。
 * @returns 补上状态句的元数据文本。
 */
function metadataText() {
  const head = readFileSync(META, 'utf8').trimEnd()
  const tail = maskNative
    ? (escape
      ? '；原生 `edit`/`write` 已被门禁行按 agent 作用域屏蔽，执行体以 `native_edit`/`native_write` 保留（`escape: true`）。'
      : '；原生 `edit`/`write` 已被门禁行按 agent 作用域屏蔽：既不出现在工具表里，也调不动。')
    : '；原生 edit/write 保持不变。'
  return head + tail + '\n'
}

const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const targetDir = join(dshHome, '.agent-presets', id)
const targetComposition = join(targetDir, COMPOSITION)
const targetMeta = join(targetDir, 'preset.yml')

console.log('仓库        : ' + REPO)
console.log('插件        : ' + PLUGIN)
if (maskNative) console.log('门禁        : ' + MASK + `（屏蔽原生 write/edit${escape ? ' + native_edit/native_write 逃生口' : ''}，编辑行 guidance: short）`)
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
