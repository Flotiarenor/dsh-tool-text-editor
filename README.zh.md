# dsh-tool-text-editor

中文 | [English](README.md)

[DeepSeek Harness](https://github.com/deepseek-ai)（dsh）的模型工具插件，提供两个**字节保真**的
文本编辑工具：`edit_text` 与 `write_text`。

原生工具在 Windows 上存在两处缺陷：

| 场景（文件为 UTF-8 **BOM + CRLF**） | 原生 `edit`                  | 原生 `write`                       | 本插件            |
| ---------------------------------------- | ----------------------------- | ----------------------------------- | ----------------- |
| 改一行                                   | CRLF 保住 / **BOM 丢失** | —                                  | BOM + CRLF 都保住 |
| 整篇覆盖                                 | —                            | **BOM 丢失 + CRLF 被拍成 LF** | BOM + CRLF 都保住 |

原因在于 `@deepseek-ai/dsh-fs-local` 完全没有 BOM 处理（Node 的 `TextDecoder` 默认吞掉前导
BOM 字节），且 `writeText` 不按原文件风格还原行尾。

在保真之外，本插件还提供：**统一 diff**（可用 dry-run 预览）、**写入前自动备份**、**编辑台账**、
**`grep` / `lines` 锚点**（无需人工誊抄原文）、**歧义时拒绝写入**，以及**最接近候选**提示。

两个工具的规范返回值、模型可见文本的构成与 UI 卡片的投影方式见「返回值」。

## 实现与依赖

实现是**进程内 Node**（`lib/core.mjs`）：只用 `node:` 内置模块，不启动任何子进程，无构建步骤、
无第三方依赖。

| 依赖 | 说明                                                                           |
| ---- | ------------------------------------------------------------------------------ |
| Node | 插件唯一的依赖。不启动解释器、不引入外部运行时；每次调用均无进程启动开销。 |

## 安装

### 方式一：preset（推荐，作用域最小）

仅选定该 preset 的会话可见这两个工具，其它项目与会话的工具表不受影响。**在本仓库根目录**执行：

```powershell
node scripts/install-preset.mjs
# 可选：--id <preset-id>（默认 texteditor）/ --base <自带 preset>（默认 standard）
#       / --force / --dry-run / --from <agent.cordis.yml 路径>
```

随后重启 `dsh web`，新建会话时选择 preset `texteditor`；preset 属会话创建期事实，已在运行的会话无法切换。

### 方式二：安装到 profile（所有会话可用）

`dsh plugin add` 支持多种来源，**以下来源均受支持**：本包为预构建的零依赖 ESM，无
`prepare` / `build` 步骤，因此既无需用户授权构建，安装时也不会执行任何构建脚本。

| 来源           | 命令                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| 本地仓库       | `dsh plugin --profile web add link:<本仓库的绝对路径>`                    |
| npm（发布后）  | `dsh plugin --profile web add @flotiarenor/dsh-tool-text-editor`          |
| 打包的 tarball | 先 `pnpm pack`，再 `dsh plugin --profile web add ./<pnpm pack 输出的文件名>.tgz` |
| git 仓库（跟随默认分支） | `dsh plugin --profile web add github:Flotiarenor/dsh-tool-text-editor` |

可在启动前用以下命令确认该层是否生效：

```powershell
dsh --profile web --dump-config   # 应当能看到 "# == @flotiarenor/dsh-tool-text-editor"
```

`edit_text` / `write_text` 与原生工具不重名，插入宿主组合不会产生注册冲突。

卸载：`dsh plugin --profile web remove @flotiarenor/dsh-tool-text-editor`。

两种方式可以并存：同名时 preset 层的注册会遮蔽宿主层的注册，二者定义相同、行为一致。

## 工具契约

### `edit_text` —— 局部替换

| 参数          | 必填 | 说明                                                                     |
| ------------- | ---- | ------------------------------------------------------------------------ |
| `file_path` | ✅   | 目标文件；相对路径按会话工作区解析。                           |
| `new_text`  | ✅   | 替换或插入的内容。                                                       |
| `old_text`  | -    | 字面量锚点（可直接复制 `read` 的输出）。                            |
| `grep`      | -    | 正则锚点：命中的行或行块作为锚点（含行尾换行符）。                       |
| `lines`     | -    | 行号锚点，如 `"263:270"` 或 `"120"`。                                 |
| `mode`      | -    | `replace`（默认）/ `after` / `before` / `append` / `prepend`。 |
| `count`     | -    | 要求恰好 N 处命中并全部替换（不符则拒绝写入）。                |
| `nth`       | -    | 只替换第 k 处（1-based）。                                               |
| `strict`    | -    | 禁用宽松匹配（只接受精确匹配）。                                         |
| `diff`      | -    | 结果里 diff 正文的详细程度：`auto`（默认，改动小时才给）/ `full`（总给，仍封顶）/ `none`（不给）。 |
| `dry_run`   | -    | 只输出 diff，不写入文件。                                                |
| `note`      | -    | 一行说明，记入编辑台账。                                                 |

`old_text` / `grep` / `lines` **必须且只能提供一个**；`append` / `prepend` 不接受锚点，`after` / `before`
只能与 `grep` / `lines` 搭配。数量不符将拒绝写入。`count` 与 `nth` 互斥。

### `write_text` —— 整文件新建/覆盖

`file_path` + `content`（另接受与 `edit_text` 相同的 `diff` / `dry_run` / `note`）；目标不存在时自动
新建，覆盖前先备份。新建文件的行尾风格取自同目录的多数派（同扩展名优先），默认不写 BOM。

### 返回值

两个工具返回同一份规范值（`OUTPUT_SCHEMA`）。字段内容与去向如下：

| 字段                  | 内容                                                                     | 去向             |
| --------------------- | ------------------------------------------------------------------------ | ---------------- |
| `path`              | 调用方给出的目标路径（原样回填）                                         | —                |
| `ok` / `wrote` / `dryRun` | 执行结果标志                                                       | —                |
| `brief`             | 警告行与一行统计，如 `replace@60 +1/-1`                              | 模型上下文       |
| `diff`              | 只含 `@@` 块头与改动行的 unified diff（0 上下文行、无 `---` / `+++` 文件头），受 `maxDiffLines` 限制 | 模型上下文       |
| `stdout`            | 人读全文：路径头、含上下文行的完整 diff、备份文件名                      | UI / 日志 / 排查 |
| `stderr`            | 失败原因（失败时非空）                                                   | 模型上下文       |

模型可见文本由 `brief` 与 `diff` 组成，路径在起始行出现一次；`diff` 正文不含 `---` / `+++` 文件头，
因此路径不会在正文中再次出现。完整 diff 另经 `output.presentationMeta` 投影为
`{ path, oldText, newText }` 列表，与原生 `edit` / `write` 的卡片词汇同形，由 `presentResult` 交给
Web UI；该元数据随 `tool/result` 持久化，不进入模型上下文。

失败时不返回 `brief` 与 `diff`：模型可见文本为 `FAIL` 加目标路径，其后是完整的失败原因；原因文本由
核心生成，其中通常再包含一次工作区相对路径（失败路径优先保证原因完整）。

`diff` 参数决定 `diff` 字段的详细程度：

| 取值      | 行为                                                                             |
| --------- | -------------------------------------------------------------------------------- |
| `auto`  | 默认。正文不超过 `maxDiffLines` 行时给出；超出时不给出正文，附一行省略提示       |
| `full`  | 始终给出正文；超过 `maxDiffLines` 行时截断，附一行截断提示                       |
| `none`  | 不给出正文                                                                       |

正文固定使用 0 上下文行；`context` 配置只影响 `stdout` 与 UI 卡片。`maxDiffLines` 的作用是限制单次
调用回吐到模型上下文的字节数——工具结果按追加方式进入会话历史，不参与前缀缓存，因此不含上限时，
整文件重写会产生与输入内容等量级的回吐（实测放大率 ≈ 1.0x）。

## 已知限制

以下均为有意的设计取舍，而非缺陷；采用前请对照自身场景确认。

- **写入不经由 `ctx.fs`。** 文件由本插件直接写入，因此不经过 fs 观察策略（先读后写、版本新鲜度校验）、
  沙箱与 `sandbox_permissions` 审批升权，也不保留 Windows DACL。原子写由本插件自行实现
  （同目录临时文件 + fsync + rename）；diff 卡片由本插件的 `presentationMeta` 提供，原生工具则取自
  `ctx.fs` 返回的 `before` / `after`。
- **行号锚点不做内容校验。** `lines` 与 `before` / `after <行号>` 仅按行号定位：行号有误不会报错，
  改动会落在非预期位置；定位需要可校验时，请改用 `old_text` 或 `grep`。
- **同目标串行仅限本进程。** 进程内按目标路径排队，并配合原子写，故并行的工具调用不会相互覆盖；
  但另一个 dsh 实例、编辑器或其它进程同时修改同一文件时，仍可能相互覆盖，本插件也不检测外部改动。
- **仅处理 UTF-8 文本。** 含 NUL 字节的二进制文件与非法 UTF-8 文件一律拒绝；`.git/`、`.dsh/` 内部
  以及工作区之外的路径一律拒绝写入。

## 配置

本插件不定义 Config schema：preset 行的 `config:` 字段原样透传。

| 键               | 默认              | 含义                                             |
| ---------------- | ----------------- | ------------------------------------------------ |
| `backup`       | `true`          | 写入前把原内容复制到 `artifactsDir/backups`     |
| `ledger`       | `true`          | 往 `artifactsDir/edits.log` 追加一条 JSONL 记录 |
| `artifactsDir` | `<工作区>/.dsh` | 备份与台账所在目录                               |
| `newFileBom`   | `false`         | 新建文件时是否写 UTF-8 BOM                       |
| `context`      | `3`             | `stdout` 与 UI 卡片中 diff 的上下文行数（模型可见正文固定 0 行） |
| `diff`         | `'auto'`        | `diff` 字段的默认策略（`auto` / `full` / `none`）；逐调用的 `diff` 参数优先 |
| `maxDiffLines` | `30`            | `diff` 字段的行数上限：`auto` 超出时不给出正文，`full` 超出时截断 |
| `root`         | `process.cwd()` | 无 agent 会话时的回退工作区                      |

环境变量 `DSH_TEXT_EDITOR_EOL`（`lf` \| `crlf`）可覆盖**新建文件**的行尾推断。

## 自测与门禁

```powershell
# 在本仓库根目录执行
node tools/selftest.mjs        # Windows + Node 24 参考结果 92/92
node tools/check-license.mjs   # 许可证 / 依赖 / 纯 Node 门禁
node tools/gen-schema.mjs      # 内嵌 schema 是否仍与作者 DSL 一致
```

`tools/selftest.mjs` 覆盖：BOM 与行尾保真、`dry_run`、四种锚点、`count`、歧义时拒绝写入、用法错误、
二进制与非法 UTF-8、路径护栏（`.dsh/`、工作区之外）、行尾多数派推断、跨多个 hunk、末尾换行差异、
并发写入不产生半截文件；**并含一层插件层断言**：以模拟 ctx 驱动 `apply()`，验证工具注册、引导段
身份、每个返回值均满足 `OUTPUT_SCHEMA`、`render()` 输出，以及 config 透传（`root` / `backup` /
`ledger` / `newFileBom`）；**以及一层返回值约束断言**：整文件重写不回显内容、小改动仍给出改动行、
`diff` 三种取值的行为边界、路径仅出现一次、完整 diff 只经 `presentationMeta` 投影。

`tools/gen-schema.mjs` 需要一份装有 `@deepseek-ai/dsh-tools` 的 dsh：它会在 dsh profile 的
`node_modules` 与 npm 全局目录中自动查找，也可用 `DSH_TOOLS_ENTRY` 显式指定；找不到入口时退出码为 2。

## 目录结构

```
lib/core.mjs             # 编辑核心：BOM/行尾、锚点、匹配、diff、备份、台账、原子写、同目标串行
lib/editor.mjs           # 插件本体：schema、参数校验、工具注册（零依赖 ESM，无构建）
preset/preset.yml        # preset 的名字/描述（dsh 列表里显示的内容）
scripts/install-preset.mjs  # 从本机 dsh 派生用户 preset
cordis.patch.yml         # 宿主平面安装用的 bundle patch
tools/selftest.mjs       # 端到端自测（核心 + 插件层）
tools/check-license.mjs  # 许可证 / 依赖 / 纯 Node 卫生门禁
tools/gen-schema.mjs     # 内嵌 schema 的权威来源与校验器
```

备份与台账采用固定的命名与字段：每次编辑在 `.dsh/backups/` 下留存一个文件，命名为
`<绝对路径扁平化>@<时间戳>`；`.dsh/edits.log` 每行一个 JSON 对象（`time`、`id`、`tool`、`file`、
`abspath`、`action`、`kinds`、`line_start`、`line_end`、`added`、`removed`、`bom`、`eol`、
`backup`、`summary`）。

## License

**Apache-2.0**，见 [LICENSE](LICENSE)。Copyright 2026 Flotiarenor。本包**零运行时依赖**，因此不承担
任何第三方许可证义务。

- `lib/editor.mjs` 内嵌的 JSON Schema 是 `@deepseek-ai/dsh-tools`（MIT，Copyright (c) 2026 DeepSeek）
  转换器的**生成产物**（由 `tools/gen-schema.mjs` 离线生成）。
- preset 组合**不在本包内**：`scripts/install-preset.mjs` 在安装时读取使用者所装 dsh 自带的组合。
- 源文件均带 `SPDX-License-Identifier` 头，许可证**逐文件机器可读**。
