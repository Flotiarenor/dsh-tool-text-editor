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

## 屏蔽原生 `write` / `edit`（可选）

`lib/mask.mjs` 是一行独立的插件：装进 preset 后，**该 preset 的会话里就没有原生 `write` / `edit`**。
安装时加一个开关即可：

```powershell
node scripts/install-preset.mjs --mask-native            # 多插一行 tool-native-edit-mask，并给编辑行写 guidance: short
node scripts/install-preset.mjs --mask-native --escape   # 同上，另加可选的 native_edit / native_write 逃生口
```

省下的是每次请求 **2362 B**（`node tools/measure-context.mjs --vs-native` 实测）：两个 schema
1754 B（`write` 728 + `edit` 1026，含沙箱升权字段）加两段引导 608 B（220 + 388）；再把编辑行的
`guidance` 换成 `short` 又省 81 B（241 → 160）。合计 **2443 B/请求**（约 600 token）。

它走三条通路，并且知道怎么**退出组合**：

1. **`apply()` 阶段就挂守卫**（`ctx.tools.guard(...)`，挂在本行自己的作用域层上）：与 agent 什么时候
   加入组合**无关**。任何时刻进来的 agent，第一次直呼原生工具都会被否决（原因里点名 `edit_text` /
   `write_text`），并且这一次调用就顺手把它收窄——于是**下一次请求**的工具表已经干净。它是"最迟防线"，
   不是主路径。
2. **`agent/created`**：建档时加入本 preset 的 agent（含 subagent）立即收窄，这条原样保留。
3. **`tools/change`**：`recompose()` 重绑作用域之后会发它，这就是 GUI 换 preset 的那条路；收到后枚举
   `ctx.agents.list()`，把**属于本组合**的 agent 收窄。
4. **退出组合也要还原**：`restrict`、空段、`native_*` 逃生口都注册在 **agent 自己的层**上，不随
   preset 更换消失。所以每个 agent 的注册句柄都留着，一旦它被重新挂到别的 preset 就成对撤销——否则
   那个 agent 在新 preset 里既没有原生名字、也没有本插件的工具，等于**一个写工具都不剩**。

| 通道 | 调用 | 效果 |
| --- | --- | --- |
| 守卫 | `ctx.tools.guard(...)` | 否决这次调用（原因里点名本插件的工具，模型可见）；`deny` 档下顺手把该 agent 收窄 |
| 工具表与执行 | `agent.ctx.tools.restrict({ deny: ['write','edit'] })` | 被拒的名字**既不出现在工具表里，也调不动**——直呼其名得到 `UNKNOWN_TOOL` |
| 提示词 | `agent.ctx.systemPrompt.section({ name: 'tool:write', text: '' })` | 在更近的层注册同名**空段**，遮蔽 `dsh-tool-fs` 注册的那两段引导——如今是冗余保险，见下面的配置表 |

`restrict()` 只能从**带作用域的上下文**（`agent.ctx`）调用，从 preset 常驻作用域（也就是插件行自己
的 ctx）调用会被拒绝——同一层里注册的名字不算"可限制的全局工具"。守卫的价值正在于让另外两条通路的时序
变得无关紧要：GUI 的真实流程是"先按默认 preset 建 agent，再把用户选的 preset 重新挂上去"，而
`AgentPresets.recompose()` 做的是**父级 re-link，不是重建 agent**，所以 `agent/created` 早就在旧组合下
发完了，新挂上来的监听器永远收不到那个 agent。实测：这个 preset 的会话里，`request/header` 事件中
25 条仍列着原生 `write` / `edit`，只有 3 条收窄了。

归属判据（"这个 agent 是不是加入了我这个组合"）不能 import `@deepseek-ai/dsh-scope`：本包"零依赖、
只用 `node:` 内建"是 `tools/check-license.mjs` 的硬断言。等价判据在 `dsh-tools` 里：用
`ctx.tools.guardReason(<本模块自己铸的探测对象>)` 探测——它会遍历 `exec.agent` 的作用域链，**本行的层
只在链上时才会走到本行的守卫**，所以这条判据只依赖 `dsh-tools`。判据是探测对象的**对象身份**，不是
名字：`guardReason()` 跑在"工具存不存在"之前，看不见的名字一样会走到守卫，所以"起个没人用的名字"并不
够。真实派发每次都会铸一个新的执行对象，永远不可能等于探测对象，也就永远拿不到哨兵。答复还要与哨兵
比对，所以"对任何调用都回一句理由"的别人的守卫（宿主里的 in-process subagent driver 就带一个，而
`guardReason` 先看全局层）不会被误认成本行的答复。判据是三态——`member` / `outsider` / `unknown`——
而巡查只在确定是 `outsider` 时才撤销：探测答不出来（守卫没挂上、这个版本的 dsh 没有 `guardReason`、
查询抛错）**或者答复来自别人**，都意味着"别动这个 agent"，把 `unknown` 当成 `outsider` 会**悄悄拆掉**
一条本来有效的收窄。这份谨慎的代价是双向的、也写在代码里：判据答不出来时，"换掉的 preset 把原生工具
还回来"那一半同样降级，所以本行会记一条 warn，而不是悄悄只做一半。

与"离开组合"配套的还有两处生命周期事实。第一，这些注册挂在 **agent 的 fiber** 上，所以**本行自己被
卸载**（HMR 重载、给 preset 行加 `disabled: true`）时它们不会跟着走——本行因此还注册了卸载钩子，把
手上所有 agent 的注册一并撤销。第二，宿主平面安装却忘了写 `scope: 'global'` 时，守卫会落在全局层上，
那里的"收窄"会连没有挂本插件的 preset 一起改；本行用同一个探测发现这件事（**不带 agent** 的探测只有
全局层上的守卫会回答），自动退化成"只管守卫"，并记一条点名修法的 warn。

### 屏蔽之后还能测原生工具吗？能，四条路

1. **换一个组合（另一个 preset）**：门禁是**组合事实**，不是全局开关。别的组合里的 agent 照旧看得见、
   也调得动——`tools/probe-mask.mjs` 与 `tools/repro-mask.mjs` 都断言了这条对照组；而**同一个 preset
   里的兄弟 agent 一样被屏蔽**，那是有意的。
2. **进程内探针**：`node tools/probe-mask.mjs` 用真实的 dsh 包（`dsh-tools` + `dsh-scope` +
   `dsh-system-prompt` + `cordis`）与真实的 `dsh-agent` 注册表复刻挂载形状：门禁行用**真实的作用域
   上下文**挂（守卫必须在 `apply` 阶段落到那一层上），`agent/created` 由注册表派发而不是手工投递。
   断言"看得见 / 看不见、调得动 / 调不动、提示词里还有没有那两段"，外加"**没有经过建档事件**的 agent
   也会被 apply 阶段的守卫拦下、并当场收窄"，23 项全过（找不到 dsh 包时退出码 2）。
3. **直接驱动原生工具**：`tools/measure-context.mjs --vs-native` 在进程内对真实的 `dsh-tool-fs` 调
   `apply()` 并量它的 schema 与引导段——不经过任何 agent，门禁管不着。
4. **临时撤掉**：给 preset 里的 `tool-native-edit-mask` 行加 `disabled: true`，或改用 `mode: 'guard'`。

### `mode: 'guard'`：留一条观察窗

`mode: 'guard'` 保留 apply 阶段的守卫，跳过 `restrict` 与逃生口：工具**保持可见**，调用被否决，拒绝
原因里点名 `edit_text` / `write_text`。代价是 **schema 的钱照付**（两张表照旧下发，1754 B），而那两段
引导仍被空段遮蔽——调用都被拒了，留着引导只会让模型去试。换来的是原生工具仍可被调用、可观察——想一边
屏蔽一边看原生行为时用它。`scope: 'global'` 是**只管守卫**的一档：两种模式下
它都不收窄，因为那一档的目的就是守住**每个** agent。

### 门禁行配置

门禁行同样不定义 Config schema：preset 行的 `config:` 字段原样透传。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `mode` | `'deny'` | `deny`：名字从工具表里消失（`restrict`），守卫再兜住仍然看得见的调用；`guard`：工具保持可见，每次调用都被否决 |
| `scope` | `'agent'` | `agent`：只作用于加入本组合的 agent；`global`：装在宿主平面（profile 层），对所有 agent、所有 preset 生效，**只做守卫**——不 `restrict`、不注册空段、不给逃生口，绝不收窄 |
| `escape` | `false` | 配合 `mode: 'deny'` + `scope: 'agent'`：把被收窄掉的执行体以 `native_edit` / `native_write` 注册回 agent 自己的作用域。默认关闭，安装器的 `--escape` 打开它 |
| `deny` | `['write','edit']` | 要收窄的名字；只点名该 agent **真的看得见**的名字 |
| `sections` | `['tool:write','tool:edit']` | 用空段遮蔽的引导段名，`[]` 关闭。如今是**冗余保险**：0.1.5-rc.2 起 `dsh-tool-fs` 的引导段按作用域求值（`({ scope }) => ctx.tools.get('write', scope) === undefined ? '' : '…'`），工具一被收窄，那段引导自己就不下发了 |

逃生口是可选功能，装好的 preset 里默认关闭：
`node scripts/install-preset.mjs --mask-native --escape` 会把它写进行配置。原生**名字**仍然看不见
（直呼 `edit` 依旧是 `UNKNOWN_TOOL`），而 `native_edit` / `native_write` 跑的是同一份执行体——参数
schema、沙箱升权解析、先读后写与版本新鲜度前置策略都一样。它们的描述只陈述"跑的是哪个原生工具、代价
是什么"，不给任何使用条件：逃生口不该由提示词劝模型去用。它也不便宜——两个原生 schema 会重新回到每次
请求里，所以默认是关的。

### 边界

- **不是权限边界**：这是 dsh 文档所说的 live visibility composition。原生工具**仍然注册在注册表里**
  （GUI 的插件/工具清单可能照旧列出它们），shell 命令也一样能写文件——`tools/probe-mask.mjs` 专门
  断言了这条。
- **是组合事实，不是全局开关**：`scope: 'agent'`（默认）只碰加入本行组合的 agent——**同一个 preset 的
  兄弟 agent 一起屏蔽，别的 preset 的 agent 一个不碰**；`scope: 'global'` 是有意的例外：它装在宿主
  平面，守住所有 preset 的所有 agent，并且从不收窄。
- **名字可配**：`deny` / `sections` 都是 config，`tool-fs` 改名或拆包时改配置即可。
- **只点名看得见的名字**：preset 没挂 `tool-fs` 时门禁什么都不做（不会因未知名字抛错），段遮蔽照旧；
  守卫在**调用发生时**按 `exec.agent` 重新问一次可见性，所以"别处看得见、这个 agent 看不见"的名字它
  不会碰。

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
| `count`     | -    | 声明期望的命中数：`old_text` 是"同一字面量出现几次"（全部替换），`grep` 是"正则命中几处"，`lines` 是"覆盖几行"。与实际情况不符即拒绝写入。 |

`old_text` / `grep` / `lines` **必须且只能提供一个**；`append` / `prepend` 不接受锚点，`after` / `before`
只能与 `grep` / `lines` 搭配。数量不符将拒绝写入。

两种锚点都覆盖整行行块**并含行尾换行符**，所以 `new_text` 也要以换行结尾——否则替换会把下一行并进来，
文件少一行（统计里的 `+1/-2` 会反映出来）。

匹配顺序为精确 → 宽松（忽略行尾空白、按行块相似度）→ 失败时给出最接近的候选；命中多处且未声明
`count` 时拒绝写盘。宽松命中会在结果里带一行 `[warn]`。宽松命中也遵守"命中多处即拒绝"：
两处同样能宽松命中时不会按文件顺序挑第一处，而是列出候选行号请你抄更长的 `old` 或改用 `lines` / `grep`。

**没有"只改第 k 处"这类参数**：`count` 是唯一消歧旋钮，它的语义是**确认**（声明命中数、不符即拒绝）
而不是**选择**（挑一处、其余照旧）。需要"只改其中一处"时，把锚点写准到唯一——抄更长的 `old`，或
改用 `lines` / `grep` 直接点名位置。这样一次错锚点不会变成静默的错编辑。

宽松命中的 span 是**整行块**（含行尾空白与换行符），而 `old_text` 可能没有换行结尾——最常见的原因是
它抄自 `read` 的输出，那里不显示行尾空白。这时工具把行尾空白与换行符留在文件里，只换行内容：
`old_text: 'gamma'` 配上 `new_text: 'GAMMA'` 会把 `'\tgamma   \n'` 变成 `'\tGAMMA   \n'`，
行数不变，并在 `[warn]` 里说明。锚点**自己带着换行结尾**、`new_text` 却没有时，行会被并起来
（`lines` / `grep` 锚点同理）——那是调用方在按行边界寻址，结果里的 `[warn]` 会点名这件事。

### `write_text` —— 整文件新建/覆盖

`file_path` + `content`；目标不存在时自动新建（含补齐缺失的父目录），覆盖前先备份。新建文件的行尾
风格取自同目录的多数派（同扩展名优先），默认不写 BOM。**`content: ''` 配一个不存在的目标就是创建
零字节文件**（统计行是 `write +0/-0`，卡片按新建整篇展示空内容）；但往一个已经空的文件再写空内容仍
按"没有产生任何变化"拒绝——那是真的一致，不是新建。

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
- **只镜像了 `read-only` 一档，且不做任何路径限制。** `workspace-write` 与 `danger-full-access` 下两个
  工具都能写**任何**路径：工作区之外、`.dsh/` 与 `.git/` 内部、以及工作区里指向外部的 junction /
  symlink 之后。这不是遗漏，是一次明确的取舍——本包曾有的路径护栏按**字符串前缀**判定，既能被符号
  链接绕过（看着有护栏、实际能穿出去），又会在 full-access 会话里把模型本来有权限写的位置一并禁掉，
  而后者的代价更大。因此本包**不是安全边界**，也不假装能替代宿主策略、沙箱或审批：要限制可写范围，
  请用会话文件策略、沙箱与 `sandbox_permissions`（或 shell 侧护栏），本包不参与那层判断。
- **行号锚点不做内容校验。** `lines` 与 `before` / `after <行号>` 仅按行号定位：行号有误不会报错，
  改动会落在非预期位置；定位需要可校验时，请改用 `old_text` 或 `grep`。
- **同目标串行仅限本进程。** 进程内按目标路径排队，并配合原子写，故并行的工具调用不会相互覆盖；
  但另一个 dsh 实例、编辑器或其它进程同时修改同一文件时，仍可能相互覆盖，本插件也不检测外部改动。
- **仅处理 UTF-8 文本。** 含 NUL 字节的二进制文件与非法 UTF-8 文件一律拒绝。被操作系统标记为只读的
  文件同样拒绝（原子 rename 会以 `EPERM` 失败），并且**不会**悄悄清掉那个属性。
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
| `guidance`     | `'full'`        | 引导段三档：`full`（含"优先于原生"）/ `short`（原生已被门禁屏蔽时用）/ `false`（整段不注册） |
| `root`         | `process.cwd()` | 无 agent 会话时的回退工作区                      |

环境变量 `DSH_TEXT_EDITOR_EOL`（`lf` \| `crlf`）可覆盖**新建文件**的行尾推断。

## 自测与门禁

```powershell
# 在本仓库根目录执行
node tools/selftest.mjs                 # Windows + Node 24 参考结果 167/167
node tools/check-license.mjs            # 许可证 / 依赖 / 纯 Node 门禁，30/30
node tools/gen-schema.mjs               # 内嵌 schema 是否仍与作者 DSL 一致
node tools/measure-context.mjs          # 逐场景量模型可见字节
node tools/audit-session.mjs            # 用真实会话日志对账（含文本形状检查）
node tools/audit-session.mjs --tools    # 逐条 request/header 的真实工具表（门禁验收）
node tools/probe-mask.mjs               # 真实 dsh 包 + 注册表上的门禁语义（23 项，缺包时退出码 2）
node tools/repro-mask.mjs               # 真实 preset + agent 注册表上的组合时序（23 项，缺包时退出码 2）
node tools/bench-tokens.mjs --assert    # token 对比的 16 项断言
```

`npm test` 串起许可证门禁、自测与 `measure-context --cap 2048`；后者保证任何一次调用的模型可见文本
都不超过 2 KB——当前实现的最坏场景是 1.6 KB 的歧义提示，成功路径固定 2 行 / 17–21 B。

`tools/selftest.mjs` 覆盖：BOM 与行尾保真、四种锚点、`count`、歧义时拒绝写入、宽松匹配通报、用法错误、
二进制与非法 UTF-8、`.dsh/` 内部与工作区之外的路径照写（无路径护栏）、行尾多数派推断、多 hunk、末尾换行差异、并发写入
不产生半截文件、新建时补齐父目录、系统调用失败只报 errno；**并含一层插件层断言**：以模拟 ctx 驱动
`apply()`，验证工具注册、引导段身份、每个返回值均满足 `OUTPUT_SCHEMA`、`render()` 的字面形状，以及
config 透传（`root` / `backup` / `ledger` / `newFileBom`）；**一层返回值约束断言**：无论输入多大，
成功路径都只有两行、不含改动内容、也不重复路径；**一层呈现层断言**：`presentCall` 的形状、实际 hunk
的投影、回放窄化、投影缺失/为空/畸形时的降级，以及卡片上限；**一层策略断言**：`read-only` 下
两个工具在任何 I/O 之前拒写（不留字节、不留备份），`workspace-write` / `danger-full-access` 照旧写，
策略服务缺席或抛错不误伤写入；**一层门禁断言**：假世界另外建模了 `apply` 阶段的守卫注册、归属探测
（`guardReason()` 只对成员走到本行守卫）、`tools/change` 巡查、离开组合时成对撤销与重新加入后再收窄，
外加只点名本 agent 看得见的名字、两种模式各自调用什么、空段与顺序、重复事件不重复注册、探测不可用时
绝不撤销既有收窄、守卫注册失败要留日志、注册表或提示词服务抛错时不把 agent 创建带崩；**以及一层引导段断言**：
`full` / `short` / `false` 三档与非法取值报错。

`tools/probe-mask.mjs` 用**真实的** dsh 包（`dsh-tools` + `dsh-scope` + `dsh-system-prompt` + `cordis`）
与真实的 `dsh-agent` 注册表复刻 preset 的挂载形状：门禁行用**真实的作用域上下文**挂（守卫必须在
`apply` 阶段落到那一层上），`agent/created` 由注册表派发，不再手工投递。验证门禁在注册表里的实际语义：
受限 agent 的工具表里没有 `write` / `edit`、直呼得到 `UNKNOWN_TOOL`、**别的组合**里的 agent 照旧看得见
也调得动、受限 agent 的提示词里没有原生那两段引导、常驻作用域仍注册着它们（可见性组合而非权限边界）、
**没有经过建档事件**的 agent 也会被 apply 阶段的守卫拦下并当场收窄、`mode: 'guard'` 下"可见但被拒"、
可选的 `escape: true` 下原生名字仍不可见而 `native_*` 能跑、以及 `scope: 'global'` 守住每个 agent。
共 23 项；缺少 dsh 包时退出码 2。

`tools/repro-mask.mjs`（npm 脚本 `npm run repro:mask`）在临时目录里用**真实的**
`@deepseek-ai/dsh-agent-presets` 服务与**真实的** `@deepseek-ai/dsh-agent` 注册表驱动真实的
`agent.cordis.yml` 组合（本仓库的 `lib/mask.mjs` 按绝对路径入列），逐条路径断言最终的工具表：建档前
挂载、建档后换 preset（`recompose()`）、首次绑定、换出去、以及跟随父组合的子 agent——外加"自带一个对
任何调用都回理由的守卫"的宿主（归属探测不能被它蒙对）与另一个组合的 agent 作对照组。共 23 项；它是
组合时序 bug 的回归测试（修之前 4/7），需要上面那些 dsh 包（缺包时退出码 2）。

### 上下文开销的测量

`tools/measure-context.mjs` 以模拟 ctx 驱动 `apply()`，走真实的 `execute()` → `output.render()` 路径，
逐场景输出入参字节、模型可见字节、倍率与行数。`--cap N`：任一场景超过 N 字节即退出码 1。`--static`
输出每请求的静态开销；`--vs-native` 追加宿主 `write` / `edit` 的同一组数据（未找到 dsh 安装时输出 SKIP）。

`tools/audit-session.mjs` 以真实会话日志（`<DSH_HOME>/sessions/`，分帧 zstd，按调用对账）核对三项：
结果文本的形状是否符合上面两种之一（出现 diff 正文、`=== ` 头、`OK ` 尾、备份名或内部临时文件名即
报告）、成功结果是否回显了本次调用自己的 `file_path`（那正是这次形状要杜绝的回归），以及单条结果是否
超过 `--cap`（默认 1024 B）。

`--tools` 换一个视角：逐个会话打印每条 `request/header` 事件里**真正下发的工具表**与判定行
（`native write/edit: PRESENT (...)` 还是 `masked`，以及 `edit_text` / `write_text` 在不在），末尾给
汇总。这张表就是模型当轮看到的东西，所以它是判断门禁有没有生效的唯一验收标准：
`node tools/audit-session.mjs --tools`。

`tools/bench-tokens.mjs --assert` 把同一组 token 对比固化成 16 项断言：屏蔽原生的组合是
**700 tok/请求静态开销**，原生 `write` / `edit` 是 **773**，这次修复没有改动这些数字。

`tools/gen-schema.mjs` 需要一份装有 `@deepseek-ai/dsh-tools` 的 dsh：它会在 dsh profile 的
`node_modules` 与 npm 全局目录中自动查找，也可用 `DSH_TOOLS_ENTRY` 显式指定；找不到入口时退出码为 2。

## 目录结构

```
lib/core.mjs             # 编辑核心：BOM/行尾、锚点、匹配、备份、台账、原子写、同目标串行、hunk 投影
lib/editor.mjs           # 插件本体：schema、参数校验、工具注册、diff 卡片、read-only 镜像（零依赖 ESM，无构建）
lib/mask.mjs             # 可选门禁行：按 agent 作用域屏蔽原生 write / edit（apply 阶段挂守卫 + restrict 收窄）
preset/preset.yml        # preset 的名字/描述（dsh 列表里显示的内容）
scripts/install-preset.mjs  # 从本机 dsh 派生用户 preset（--mask-native 一并装门禁）
cordis.patch.yml         # 宿主平面安装用的 bundle patch
tools/selftest.mjs       # 端到端自测（核心 + 插件层 + 呈现层 + 策略层 + 门禁层 + 引导段）
tools/probe-mask.mjs     # 用真实 dsh 包与注册表验证门禁的注册表语义（缺包时退出码 2）
tools/repro-mask.mjs     # 用真实 preset 服务与 agent 注册表验证门禁的组合时序（缺包时退出码 2）
tools/check-license.mjs  # 许可证 / 依赖 / 纯 Node 卫生门禁
tools/gen-schema.mjs     # 内嵌 schema 的权威来源与校验器
tools/measure-context.mjs  # 模型可见字节的逐场景测量 + 原生工具对照
tools/audit-session.mjs  # 真实会话日志的上下文对账 + 文本形状检查 + --tools 工具表视图
tools/bench-tokens.mjs   # 与原生 write/edit 的 token 成本对比（静态、逐场景、真实日志）
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
