// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * gen-schema.mjs —— 内嵌 JSON Schema 的**权威来源与校验器**。
 *
 * `lib/editor.mjs` 刻意零依赖（不 import 任何包，preset 行才能用绝对路径加载它），所以 schema 是**离线生成后
 * 内嵌**的；本脚本用 dsh 自己的转换器把下面的作者 DSL 转一遍，再与内嵌那份逐字段比对：一致打印 OK，不一致打印
 * 差异并退出码 1（可当 CI 门禁）。
 *
 * 需要一份装有 `@deepseek-ai/dsh-tools` 的 dsh：入口按常见布局去找（见 `findDshTools`），也可用
 * `DSH_TOOLS_ENTRY` 显式指定；找不到入口时退出码 2（"这次没跑成"，不是 schema 漂移）。
 *
 * 用法：node tools/gen-schema.mjs
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  EDIT_PARAMETERS,
  OUTPUT_SCHEMA,
  WRITE_PARAMETERS,
} from '../lib/editor.mjs'

/**
 * dsh 装在哪不定，故按布局枚举候选入口：`DSH_TOOLS_ENTRY` → dsh profile 的 `node_modules` → npm 全局前缀
 * （不写死任何机器上的路径）。
 * @returns 候选入口的绝对路径列表（按优先级）。
 */
function findDshTools() {
  const candidates = []
  const add = (root, nested) => {
    if (typeof root !== 'string' || root === '') return
    candidates.push(join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
    if (nested) candidates.push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }
  const explicit = process.env.DSH_TOOLS_ENTRY
  if (typeof explicit === 'string' && explicit !== '') candidates.push(explicit)
  add(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules'), false)
  const globalRoots = process.platform === 'win32'
    ? [process.env.APPDATA === undefined ? '' : join(process.env.APPDATA, 'npm', 'node_modules')]
    : ['/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.npm-global', 'lib', 'node_modules')]
  for (const root of globalRoots) add(root, true)
  return candidates
}

const candidates = findDshTools()
const ENTRY = candidates.find((candidate) => existsSync(candidate))
if (ENTRY === undefined) {
  console.error('SKIP 找不到 @deepseek-ai/dsh-tools；试过：')
  for (const candidate of candidates) console.error('  ' + candidate)
  console.error('     用 DSH_TOOLS_ENTRY 显式指向 dsh-tools 的 lib/index.js 再跑。')
  process.exit(2)
}

const {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  parameterSchemaSpecToJsonSchema,
  valueSchemaSpecToJsonSchema,
} = await import(pathToFileURL(ENTRY).href)

/** `edit_text` 的作者 DSL：改这里后跑本脚本，把输出贴回 `lib/editor.mjs`。 */
const editParametersDsl = {
  file_path: { type: 'string', required: true, description: 'Target file; relative resolves against the session cwd.' },
  new_text: { type: 'string', required: true, description: 'Replacement / inserted text.' },
  old_text: { type: 'string', description: 'Literal anchor text (exactly one anchor source).' },
  grep: { type: 'string', description: 'Regex anchor: the matching line block, its trailing newline included.' },
  lines: { type: 'string', description: 'Line anchor, e.g. "263:270" or "120"; trailing newline included.' },
  mode: { type: 'string', enum: ['replace', 'after', 'before', 'append', 'prepend'], description: 'replace (default) substitutes the anchor; after/before insert beside a grep/lines anchor; append/prepend use the file ends.' },
  count: { type: 'number', description: 'Declare the expected number of hits (mismatch refuses to write); for `lines` anchors it declares how many lines the anchor covers.' },
}

/** `write_text` 的作者 DSL。 */
const writeParametersDsl = {
  file_path: { type: 'string', required: true, description: 'Target file; relative resolves against the session cwd.' },
  content: { type: 'string', required: true, description: 'Complete new file content.' },
}

/**
 * 两个工具共用的规范返回值：四个字段全部是**模型通道**（`render` 只读它们），没有呈现层载荷。
 */
const outputDsl = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    ok: { type: 'boolean', required: true },
    brief: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
  },
}
const generated = {
  edit: parameterSchemaSpecToJsonSchema(editParametersDsl),
  write: parameterSchemaSpecToJsonSchema(writeParametersDsl),
  output: valueSchemaSpecToJsonSchema(outputDsl),
}
assertObjectJsonSchema(generated.edit)
assertObjectJsonSchema(generated.write)
assertSupportedJsonSchema(generated.output)

/** 键序无关的规范形式。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

let drifted = false
for (const [label, expected, actual] of [
  ['EDIT_PARAMETERS', generated.edit, EDIT_PARAMETERS],
  ['WRITE_PARAMETERS', generated.write, WRITE_PARAMETERS],
  ['OUTPUT_SCHEMA', generated.output, OUTPUT_SCHEMA],
]) {
  if (JSON.stringify(canonical(expected)) === JSON.stringify(canonical(actual))) {
    console.log(`OK    ${label} matches the DSL`)
    continue
  }
  drifted = true
  console.log(`DRIFT ${label} no longer matches the DSL. Generated value:`)
  console.log(JSON.stringify(expected, null, 2))
  console.log('embedded value:')
  console.log(JSON.stringify(actual, null, 2))
}

console.log('')
if (drifted) {
  console.log('把上面的 generated value 贴回 lib/editor.mjs 对应常量，再跑 node tools/selftest.mjs。')
  process.exitCode = 1
} else {
  console.log('OK — 内嵌 schema 与作者 DSL 一致')
}
