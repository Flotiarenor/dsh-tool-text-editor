# dsh-tool-text-editor
中文 | [English](README.md)

[DeepSeek Harness](https://github.com/deepseek-ai)（dsh）的模型工具插件，提供两个**字节保真**的文本编辑工具：`edit_text` 与 `write_text`。它替换原生 `write` / `edit`（由 `@deepseek-ai/dsh-fs-local` 实现）并修复以下缺陷：

| 原生行为 | 成因 | 本插件 |
| ---- | ---- | ------ |
| 改一行或整篇覆盖丢失 UTF-8 BOM | 未实现 BOM 处理；Node 的 `TextDecoder` 默认吞掉前导 BOM 字节 | BOM 不变 |
| 整篇覆盖不还原行尾风格 | `writeText` 原样落盘 `content` | 行尾跟随文件 |
| `old_string` 差一个空格即报 **`FS_EDIT_NOT_FOUND`** | 原生 `edit` 只做精确匹配，没有回退 | 精确 → 忽略空白 → 失败时给一处差异（歧义时拒绝写盘） |

此外提供 `grep` / `lines` 锚点。

## 实现与依赖

实现是**进程内 Node**（`lib/core.mjs`），不启动任何子进程，无构建步骤，无第三方依赖。

## 安装

### 方式一：preset（作用域最小）

仅选定该 preset 的会话可见这两个工具，其它项目与会话的工具表不受影响。**在本仓库根目录**执行：

```powershell
node scripts/install-preset.mjs
# 可选：--id <preset-id>（默认 texteditor）/ --base <自带 preset>（默认 standard）
#       / --force / --dry-run / --from <agent.cordis.yml 路径>
```

随后重启 `dsh web`，新建会话时选择 preset `texteditor`；preset 属会话创建期事实，已在运行的会话无法切换。

### 方式二：安装到 profile（所有会话可用）

本包为预构建的零依赖 ESM，无 `prepare` / `build` 步骤：安装时不执行任何构建脚本，也不需要授权构建。下列来源均受支持：

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

`edit_text` / `write_text` 与原生工具不重名，插入宿主组合不会产生注册冲突。卸载：`dsh plugin --profile web remove @flotiarenor/dsh-tool-text-editor`。

| 机制 | 作用方式 |
| --- | --- |
| `apply()` 阶段挂在本行作用域层上的守卫 | 否决任何 agent 的首次原生调用，并在同一次调用中将其收窄 |
| 工具表与执行 | `agent.ctx.tools.restrict({ deny: ['write','edit'] })`——被点名的工具离开工具表，且无法调用 |
| 提示词 | `agent.ctx.systemPrompt.section({ name: 'tool:write', text: '' })` 遮蔽 `dsh-tool-fs` 注册的两段引导 |
| 退出组合与卸载 | `restrict` 与空段均注册在 **agent 自身的层**上，不随 preset 更换消失； |
| 宿主平面安装 | 挂在宿主平面（profile 层）的行没有作用域，守卫落入全局层，而该层的"收窄"会连带修改未挂本插件的 preset。


### 门禁行配置

不定义 Config schema：preset 行的 `config:` 字段原样透传。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `deny` | `['write','edit']` | 要收窄的名字 |
| `sections` | `['tool:write','tool:edit']` | 用空段遮蔽的引导段名，`[]` 关闭遮蔽 |

## 工具契约

### `edit_text` —— 局部替换

| 项 | 规则 |
| --- | --- |
| 必填 | `file_path` 与 `new_text` |
| 锚点，且恰好一个 | `old_text`（字面量，抄自 `read`；**仅 `replace`**，`after` / `before` 需 `grep` / `lines`）/ `grep`（正则；命中的行或行块，含行尾换行符）/ `lines`（如 `"263:270"`，同样含行尾换行符） |
| `mode` | `replace`（默认）/ `after` / `before`（两者只吃 `grep` / `lines` 锚点，不吃 `old_text`）/ `append` / `prepend` |
| `count` | 声明的命中数：`old_text` 为字面量出现次数（全部替换），`grep` 为正则命中处数，`lines` 为覆盖行数。与实际情况不符即拒绝写入 |
| 尾随换行 | 两种锚点都覆盖整行行块**并含行尾换行符**，因此 `new_text` 也应以换行结尾；否则替换会把下一行并入 |
| 匹配顺序 | 精确 → 忽略空白（空格、缩进、空行、换行一律忽略，命中的是文件自己的整行块）→ 未命中时给出**一处**差异（你的第几行 vs 文件第几行）；命中多处且未声明 `count` 时拒绝写盘，忽略空白的命中会在结果中附加一行 `[warn]`。字符不同一律拒写并点名第一处：旧版本的整块相似度回退会在这种时候静默吃掉差异字符 |
| 无"第 k 处" | `count` 是唯一的消歧旋钮，语义是**确认**而非**选择**。需要只改其中一处时，把锚点写到唯一——更长的 `old_text`，或改用 `lines` / `grep` |

`old_text` / `grep` / `lines` **必须且只能提供一个**；`append` / `prepend` 不接受锚点，`after` / `before` 只能与 `grep` / `lines` 搭配。**空的** `old_text` 会被拒绝：它没有指向任何内容（行块锚点请用 `lines` / `grep`）。

### `write_text` —— 整文件新建/覆盖

`file_path` + `content`；目标不存在时自动新建（含补齐缺失的父目录），新建文件的行尾风格跟随同目录（同扩展名优先），默认不写 BOM。**`content: ''` 配不存在的目标即创建零字节文件**（统计行为 `write +0/-0`）；但向已为空的文件再写空内容仍按"没有产生任何变化"拒绝。

### 返回值

`render` 只读 `ok` / `brief` / `stderr`；`path` 为调用方保留，但不渲染。

| 字段 | 内容 | 去向 |
| --- | --- | --- |
| `path` | 调用方给出的目标路径 | 仅规范值，**不渲染** |
| `ok` | 是否写入成功 | 模型上下文（`FAIL` 或 `WROTE`） |
| `brief` | 一行统计（如 `replace@17 +1/-1`）与必要的警告行 | 模型上下文 |
| `stderr` | 失败原因（失败时非空） | 模型上下文 |

模型可见文本如下：

```
WROTE                   # 成功：一行统计 + 警告
replace@17 +1/-1
FAIL                    # 失败：完整原因（决定下一次调用）
<原因>
```

## 已知限制

| 限制 | 说明 |
| --- | --- |
| **写入不经由 `ctx.fs`** | 文件由本插件直接写入，因此不经过 fs 观察策略（先读后写、版本新鲜度校验）、沙箱、`sandbox_permissions` 审批升权，也不保留 Windows DACL；原子写由本插件自行实现（同目录临时文件 + fsync + rename）。这条路径上没有第二个强制点，插件因此把会话文件策略里**唯一禁止写入的那一档**镜像回来：`read-only` 会话下两个工具都在任何 I/O 之前拒写，原因中指明这是会话策略而非路径问题。`sandboxPolicy` 是可选消费（`ctx.get`），服务缺席或解析抛错时照旧写入，不会把写盘全部禁掉 |
| **只镜像 `read-only` 一档，且不做任何路径限制** | `workspace-write` 与 `danger-full-access` 下两个工具都能写**任何**路径：工作区之外、`.dsh/` 与 `.git/` 内部、以及工作区内指向外部的 junction / symlink 之后。本包**不是安全边界**：要限制可写范围，请用会话文件策略、沙箱与 `sandbox_permissions` |
| **行号锚点不做内容校验** | `lines` 与 `before` / `after <行号>` 仅按行号定位：行号有误不会报错，改动会落在非预期位置。定位需可校验时，请改用 `old_text` 或 `grep` |
| **同目标串行仅限本进程** | 进程内按目标路径排队，并配合原子写，因此并行的工具调用不会相互覆盖；但另一个 dsh 实例、编辑器或其它进程同时修改同一文件时，仍可能相互覆盖，本插件也不检测外部改动 |
| **仅处理 UTF-8 文本** | 含 NUL 字节的二进制文件与非法 UTF-8 文件一律拒绝；被操作系统标记为只读的文件同样拒绝（原子 rename 会以 `EPERM` 失败） |

## 配置

本插件不定义 Config schema：preset 行的 `config:` 字段原样透传。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `newFileBom` | `false` | 新建文件时是否写 UTF-8 BOM |
| `guidance` | `'full'` | 三档：`full`（指名原生工具）/ `short`（门禁屏蔽原生工具时用）/ `false`（整段不注册） |
| `root` | `process.cwd()` | 无 agent 会话时的回退工作区 |

环境变量 `DSH_TEXT_EDITOR_EOL`（`lf` \| `crlf`）可覆盖**新建文件**的行尾推断。

## License

**Apache-2.0**，见 [LICENSE](LICENSE)。Copyright 2026 Flotiarenor。本包**零运行时依赖**，因此不承担任何第三方许可证义务。

- `lib/editor.mjs` 内嵌的 JSON Schema 是 `@deepseek-ai/dsh-tools`（MIT，Copyright (c) 2026 DeepSeek）转换器的**生成产物**（由 `tools/gen-schema.mjs` 离线生成）。
- preset 组合**不在本包内**：`scripts/install-preset.mjs` 在安装时读取使用者所装 dsh 自带的组合。
- 源文件均带 `SPDX-License-Identifier` 头，许可证**逐文件机器可读**。
