# dsh-tool-text-editor

中文 | [English](README.md)

[DeepSeek Harness](https://github.com/deepseek-ai)（dsh）的模型工具插件，提供两个**字节保真**的
文本编辑工具：`edit_text` 与 `write_text`。

它只解决原生 `write` / `edit`（由 `@deepseek-ai/dsh-fs-local` 实现）做不到的三件事：

| 缺陷 | 成因 | 本插件 |
| ---- | ---- | ------ |
| 改一行或整篇覆盖都**丢 UTF-8 BOM** | 该实现没有 BOM 处理；Node 的 `TextDecoder` 默认吞掉前导 BOM 字节 | BOM 保住 |
| 整篇覆盖把 **CRLF 拍成 LF** | `writeText` 不按原文件风格还原行尾 | 行尾跟随文件 |
| `old_string` 差一个空格即报 **`FS_EDIT_NOT_FOUND`** | 原生 `edit` 只做精确匹配，没有回退 | 精确 → 宽松 → 最接近候选（歧义时拒绝写盘） |

在此之外提供**写入前自动备份**、**编辑台账**、**`grep` / `lines` 锚点**（无需人工誊抄原文）与
**最接近候选**提示。返回值与模型可见文本的构成见「返回值」。

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

本包为预构建的零依赖 ESM，无 `prepare` / `build` 步骤：安装时不执行任何构建脚本，也不需要授权构建。
下列来源均受支持：

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
| `lines`     | -    | 行号锚点，如 `"263:270"` 或 `"120"`（同样含行尾换行符）。             |
| `mode`      | -    | `replace`（默认）/ `after` / `before` / `append` / `prepend`。 |
| `count`     | -    | 要求恰好 N 处命中并全部替换（不符则拒绝写入）。                |
| `nth`       | -    | 只替换第 k 处（1-based）。                                               |

`old_text` / `grep` / `lines` **必须且只能提供一个**；`append` / `prepend` 不接受锚点，`after` / `before`
只能与 `grep` / `lines` 搭配。数量不符将拒绝写入。`count` 与 `nth` 互斥。

两种锚点都覆盖整行行块**并含行尾换行符**，所以 `new_text` 也要以换行结尾——否则替换会把下一行并进来，
文件少一行（统计里的 `+1/-2` 会反映出来）。

匹配顺序为精确 → 宽松（忽略行尾空白、按行块相似度）→ 失败时给出最接近的候选；命中多处且未指定
`nth` / `count` 时拒绝写盘。宽松命中会在结果里带一行 `[warn]`。

### `write_text` —— 整文件新建/覆盖

`file_path` + `content`；目标不存在时自动新建（含补齐缺失的父目录），覆盖前先备份。新建文件的行尾
风格取自同目录的多数派（同扩展名优先），默认不写 BOM。

### 返回值

两个工具返回同一份规范值（`OUTPUT_SCHEMA`）。前四个字段是**模型通道**的依据（`render` 只读它们），
其余是**呈现通道**（GUI 的 diff 卡片）的载荷，只经 `output.presentationMeta` 投影进会话日志，
永不进入模型上下文。失败值只有前四个字段。

| 字段       | 内容                                             | 去向       |
| ---------- | ------------------------------------------------ | ---------- |
| `path`   | 调用方给出的目标路径                             | 仅规范值，**不渲染** |
| `ok`     | 是否写入成功                                     | —          |
| `brief`  | 一行统计（如 `replace@17 +1/-1`）与必要的警告行  | 模型上下文 |
| `stderr` | 失败原因（失败时非空）                           | 模型上下文 |
| `operation` | `create` 或 `update`                         | 卡片标题   |
| `hunks`  | 实际落盘的改动，逐 hunk 一对 `{ oldText, newText }`（含上下文行） | GUI 卡片 |
| `hunksTruncated` | 卡片载荷是否触到上限                      | 卡片标题   |

模型可见文本因此只有两种形状：

```
WROTE                   # 成功：一行统计 + 警告
replace@17 +1/-1
FAIL                    # 失败：完整原因（决定下一次调用）
<原因>
```

**成功路径不回显改动内容**：工具结果按追加方式进入会话历史，任何内容回显都会随调用次数累积，而
调用方刚发过 `new_text`；`replace@17 +1/-1` 已说明改在哪几行、改了多少，需要看正文时 `read` 一次
即可。因此单次调用的模型可见字节与输入规模无关（实测：400 KB 的单行写入仍只回 2 行 / 17 B）。

**成功路径也不回显路径**：结果与调用一一绑定（`tool/result` 带 `source.callId`），调用方自己那条
`file_path` 参数就在同一轮历史里，逐字回显它新信息量为零——而它并不便宜：在本机 79 个会话、86 条
当前形状的结果里，一次成功平均 116 B，其中 `WROTE <路径>` 一行占 **55.6 B（48%）**；去掉路径后
平均 66 B（−43%）。路径仍然出现在**它真正携带信息**的两处：需要指名文件的失败**原因**里，以及
下面的 GUI 卡片上。

### 呈现通道（GUI 的 diff 卡片）

两个工具声明了 `presentCall`、`output.presentationMeta` 与 `presentResult`：

- `presentCall(args)` 用调用参数画出**待定卡片**（`edit_text` 是 diff，`write_text` 是整篇覆盖形状；
  `grep` / `lines` 锚点没有现成的 old 文本，按新增侧展示）；
- `presentationMeta(args, value)` 投影**实际落盘**的 hunk——文件身份与真正的改动落在这里，而不是
  模型的上下文里；
- `presentResult(args, result)` 把持久化的投影窄化回 `DiffResultView`；投影缺失、为空或畸形时一律
  回落到原始结果文本。

投影会随会话日志持久化，因此有上限：`lib/core.mjs` 里的 `PRESENT_MAX_HUNKS`（40）与
`PRESENT_MAX_BYTES`（4096）。整篇重写这类超限改动会丢掉卡片正文、只在标题标注 `（部分 diff）`
——宁可卡片没内容，也不把整个文件塞进会话日志。

改动记录由备份与台账承担，二者都不进入模型上下文：`.dsh/backups/` 下的原件副本，以及
`.dsh/edits.log` 的 JSONL（字段见「目录结构」之后）。

系统调用失败只报 errno 与一句原因（`ENOENT`、`ENOTDIR`、`EISDIR`、`EACCES` 等）：Node 原始 message
中的绝对路径与内部临时文件名（`.<名字>.<pid><ts>.tmp`）不进入模型上下文。

## 已知限制

以下均为有意的设计取舍，而非缺陷；采用前请对照自身场景确认。

- **写入不经由 `ctx.fs`。** 文件由本插件直接写入，因此不经过 fs 观察策略（先读后写、版本新鲜度校验）、
  沙箱与 `sandbox_permissions` 审批升权，也不保留 Windows DACL。原子写由本插件自行实现
  （同目录临时文件 + fsync + rename）。正因为这条路径上没有第二个强制点，插件把会话自己的文件策略里
  **唯一禁止写入的那一档**镜像了回来：`read-only` 会话下两个工具都在任何 I/O 之前拒写，原因里点明
  这是会话策略而非路径问题。`sandboxPolicy` 是可选消费（`ctx.get`），服务缺席或解析抛错时退回既有
  行为，不会把写盘全禁掉。
- **只镜像了 `read-only` 一档。** `workspace-write` 与 `danger-full-access` 仍走下面的常量护栏；
  本插件并不精确复刻宿主策略，也**不是安全边界**——shell 命令照样能写到沙箱允许的任何地方。
- **行号锚点不做内容校验。** `lines` 与 `before` / `after <行号>` 仅按行号定位：行号有误不会报错，
  改动会落在非预期位置；定位需要可校验时，请改用 `old_text` 或 `grep`。
- **同目标串行仅限本进程。** 进程内按目标路径排队，并配合原子写，故并行的工具调用不会相互覆盖；
  但另一个 dsh 实例、编辑器或其它进程同时修改同一文件时，仍可能相互覆盖，本插件也不检测外部改动。
- **仅处理 UTF-8 文本。** 含 NUL 字节的二进制文件与非法 UTF-8 文件一律拒绝；`.git/`、`.dsh/` 内部
  以及工作区之外的路径一律拒绝写入（护栏是常量，不可配置）。被操作系统标记为只读的文件同样拒绝
  （原子 rename 会以 `EPERM` 失败），并且**不会**悄悄清掉那个属性。
- **新建文件会补齐缺失的父目录。** `write_text` 目标不存在时按 `mkdir -p` 补齐（与原生 `write` 一致）；
  该动作不产生额外输出。
- **台账失败不改变写入结果。** 目标文件写入成功后，台账失败只在结果里追加一行 `[warn]`，`ok` 仍为真；
  否则调用方会重试，导致同一次编辑写入两次。
- **卡片载荷有上限，所以超大改动看不到 diff。** 超过上面的 hunk 条数 / 字节上限时卡片正文为空、标题
  标注 `（部分 diff）`；那两行原始结果仍是记录。

## 配置

本插件不定义 Config schema：preset 行的 `config:` 字段原样透传。

| 键               | 默认              | 含义                                             |
| ---------------- | ----------------- | ------------------------------------------------ |
| `backup`       | `true`          | 写入前把原内容复制到 `artifactsDir/backups`     |
| `ledger`       | `true`          | 往 `artifactsDir/edits.log` 追加一条 JSONL 记录 |
| `artifactsDir` | `<工作区>/.dsh` | 备份与台账所在目录                               |
| `newFileBom`   | `false`         | 新建文件时是否写 UTF-8 BOM                       |
| `root`         | `process.cwd()` | 无 agent 会话时的回退工作区                      |

环境变量 `DSH_TEXT_EDITOR_EOL`（`lf` \| `crlf`）可覆盖**新建文件**的行尾推断。

## 自测与门禁

```powershell
# 在本仓库根目录执行
node tools/selftest.mjs                 # Windows + Node 24 参考结果 105/105
node tools/check-license.mjs            # 许可证 / 依赖 / 纯 Node 门禁
node tools/gen-schema.mjs               # 内嵌 schema 是否仍与作者 DSL 一致
node tools/measure-context.mjs          # 逐场景量模型可见字节
node tools/audit-session.mjs            # 用真实会话日志对账（含文本形状检查）
```

`npm test` 串起许可证门禁、自测与 `measure-context --cap 2048`；后者保证任何一次调用的模型可见文本
都不超过 2 KB——当前实现的最坏场景是 1.6 KB 的歧义提示，成功路径固定 2 行 / 17–21 B。

`tools/selftest.mjs` 覆盖：BOM 与行尾保真、四种锚点、`count`、歧义时拒绝写入、宽松匹配通报、用法错误、
二进制与非法 UTF-8、路径护栏（`.dsh/`、工作区之外）、行尾多数派推断、多 hunk、末尾换行差异、并发写入
不产生半截文件、新建时补齐父目录、系统调用失败只报 errno；**并含一层插件层断言**：以模拟 ctx 驱动
`apply()`，验证工具注册、引导段身份、每个返回值均满足 `OUTPUT_SCHEMA`、`render()` 的字面形状，以及
config 透传（`root` / `backup` / `ledger` / `newFileBom`）；**一层返回值约束断言**：无论输入多大，
成功路径都只有两行、不含改动内容、也不重复路径；**一层呈现层断言**：`presentCall` 的形状、实际 hunk
的投影、回放窄化、投影缺失/为空/畸形时的降级，以及卡片上限；**以及一层策略断言**：`read-only` 下
两个工具在任何 I/O 之前拒写（不留字节、不留备份），`workspace-write` / `danger-full-access` 照旧写，
策略服务缺席或抛错不误伤写入。

### 上下文开销的测量

`tools/measure-context.mjs` 以模拟 ctx 驱动 `apply()`，走真实的 `execute()` → `output.render()` 路径，
逐场景输出入参字节、模型可见字节、倍率与行数。`--cap N`：任一场景超过 N 字节即退出码 1。`--static`
输出每请求的静态开销；`--vs-native` 追加宿主 `write` / `edit` 的同一组数据（未找到 dsh 安装时输出 SKIP）。

`tools/audit-session.mjs` 以真实会话日志（`<DSH_HOME>/sessions/`，分帧 zstd，按调用对账）核对三项：
结果文本的形状是否符合上面两种之一（出现 diff 正文、`=== ` 头、`OK ` 尾、备份名或内部临时文件名即
报告）、成功结果是否回显了本次调用自己的 `file_path`（那正是这次形状要杜绝的回归），以及单条结果是否
超过 `--cap`（默认 1024 B）。

`tools/gen-schema.mjs` 需要一份装有 `@deepseek-ai/dsh-tools` 的 dsh：它会在 dsh profile 的
`node_modules` 与 npm 全局目录中自动查找，也可用 `DSH_TOOLS_ENTRY` 显式指定；找不到入口时退出码为 2。

## 目录结构

```
lib/core.mjs             # 编辑核心：BOM/行尾、锚点、匹配、备份、台账、原子写、同目标串行
lib/editor.mjs           # 插件本体：schema、参数校验、工具注册（零依赖 ESM，无构建）
preset/preset.yml        # preset 的名字/描述（dsh 列表里显示的内容）
scripts/install-preset.mjs  # 从本机 dsh 派生用户 preset
cordis.patch.yml         # 宿主平面安装用的 bundle patch
tools/selftest.mjs       # 端到端自测（核心 + 插件层）
tools/check-license.mjs  # 许可证 / 依赖 / 纯 Node 卫生门禁
tools/gen-schema.mjs     # 内嵌 schema 的权威来源与校验器
tools/measure-context.mjs  # 模型可见字节的逐场景测量
tools/audit-session.mjs  # 真实会话日志的上下文对账 + 文本形状检查
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
