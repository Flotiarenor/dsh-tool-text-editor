# 结算与交接 —— dsh-tool-text-editor

> **开发交接件**，不是发布件：`package.json` 的 `files` 白名单没有它，不会进 npm。路径用变量
> （`$env:DSH_HOME`、`%APPDATA%`）或相对路径；`tools/check-license.mjs` 会断言"无机器专属绝对路径"。

## 0. 现状（TL;DR）

| 项目 | 状态 |
|---|---|
| 插件本体 `lib/` | 可用；`edit_text` / `write_text` 语义与返回形状未变（本轮修掉 10 个缺陷，§1.4） |
| 自测与闸门 | 全绿：`selftest` 150/150、`check-license` 30/30、`probe-mask` 18/18、`repro-mask` 23/23 |
| 本机 dsh | **0.1.5-rc.2**（CLI 与 profile 同步升级，cordis 4.0.2） |
| preset | 只剩 `<DSH_HOME>/.agent-presets/texteditor`（屏蔽档，约 700 tok/请求），mask 行不带 `config` |
| 屏蔽失效 bug（原最大未修项） | **已修**（§2.1）：修复前 25 条 `request/header` 带原生 `write`/`edit`，仅 3 条收窄 |
| 上游钩子 | 0.1.5-rc.2 的 `recompose()` 会发 `tools/change`（§2.2）；未照搬上游代码 |
| 下一步 | 重启 `dsh web` + 新建会话，再 `node tools/audit-session.mjs --tools` 查**第一条** `request/header` 是否已收窄（§7） |

## 1. 最近一轮做了什么

### 1.1 仓库改动

| 文件 | 改动 | 原因 |
|---|---|---|
| `lib/mask.mjs` | **重写收窄通路**：`apply` 阶段挂守卫 + 保留 `agent/created` + 新增 `tools/change` 巡查 + 离开组合时成对撤销 | 原实现只有一个入口，而 GUI 先建 agent、后换 preset，`recompose()` 只做父级 re-link（§2.1） |
| `tools/repro-mask.mjs` | **新增**（约 300 行）：用真 `dsh-agent-presets` + `dsh-agent` 驱动四条组合路径并断言工具表 | 修前 4/7 条失败，即验收标准 |
| `tools/probe-mask.mjs` | 门禁行改用**真实作用域上下文**挂载、agent 走**真实注册表**；新增"无建档事件也拦得住"的断言 | 假 ctx 的 `tools` 拿不到本行作用域层，守卫会落到全局层 |
| `tools/selftest.mjs` | 门禁套件从假 `{ on, logger }` 扩成可建模"守卫注册 / 归属探测 / 巡查 / 撤销"的假世界（136 → 167 项）；后又补相似度阈值 4 项、并在"减法轮"删掉呈现层/备份台账相关断言 → 150 项 | 三条通路与撤销在**不需要 dsh** 时也要钉住 |
| `tools/audit-session.mjs` | 新增 `--tools`：逐会话打印每条 `request/header` 的工具表与判定行 | 判断屏蔽是否生效只看这张表（§5.3） |
| `tools/measure-context.mjs` | 假 ctx 补 `systemPrompt.getSectionOrder` 与按可见性求值的段文本（`sectionText()`） | `--vs-native` 在 0.1.5-rc.2 上**必崩**（`dsh-tool-fs` 注册引导段要问段序号；`tool:write` / `tool:edit` 的 `text` 已是函数）。修后：2362 B/请求 = 1754 B schema（`write` 728 + `edit` 1026）+ 608 B 引导（220 + 388），`guidance: short` 再省 81 B（241 → 160）= 2443 B |
| `package.json` | `scripts` 加 `repro:mask` | 与 `probe:mask` 并列 |
| `HANDOVER.md` / `README.md` / `README.zh.md` | 同步更新 | "最大未修 bug"的说法已过期 |

发布内容见 P2。

### 1.2 本机环境改动（不在 git 里）

- 删除 `<DSH_HOME>/.agent-presets/` 下的 `test`、`test1`、`winminmal`（用户要求）。
- `texteditor` 本轮以 `node scripts/install-preset.mjs --mask-native --force` 重生成（屏蔽档，无额外 config）。
- 用户完成：dsh 升到 0.1.5-rc.2；profile 移除 `@linxin666/dsh-web-ui-all`。
- **未做**：重启 `dsh web` —— 进程握着旧版 `lib/mask.mjs` 与旧 preset 世代，修复对**已在跑的会话**无效。

### 1.3 验证记录（均在 0.1.5-rc.2 上）

`selftest` 150/150；`check-license` 30/30；`probe-mask` 18/18（真 dsh 包 + 真注册表）；`repro-mask` 23/23（真 `AgentPresets`，修前 12/19）；`gen-schema` OK。分工：`probe-mask` 验**注册表语义**（"看不见"与"调不动"是否同一张视图、guard 档、宿主平面降级），`repro-mask` 验**组合时序**（挂载 / 换 preset / 首次绑定 / 换出去）。

### 1.4 本轮（代码审计轮）修掉的 `lib/` 缺陷

| 缺陷 | 症状 | 修法 |
|---|---|---|
| `matchLiteral(text, '')` 内存爆掉 | `edit_text` 带 `oldText: ''` 时 `findAllExact` 的 `from += max(1, 0)` 原地打转，**整个宿主进程 OOM 退出**（实测 512 MB～默认堆都能撑爆） | 空锚点在 `matchLiteral` 开头直接拒绝；`planEdit` 也在参数层拒一次 |
| `grep` + `count` 的非相邻命中永远失败 | 合并块文本在全文里并不存在，`matchLiteral` 必然 `miss`；而多命中报错原文正是"用 count 声明命中数" | `grepSpan` 额外返回每一次命中自己的**行块**（`blocks`），`applyPlan` 对多处命中逐处替换 |
| `grep` 上的 `count` 被静默忽略 | 命中一处却声明 `count: 5` 照样写盘 | `count` 与 `old_text` / `lines` 一致：不符即拒绝（"命中 N 处…与声明的 count=M 不符"） |
| `mode: 'after' / 'before'` 忽略 `count` | 同一个锚点 `replace` 档拒绝、`after` 档照写 | 插入档也把 `count` 传进 `resolveAnchor` |
| 内联 `(?m)` 正则不可用 | 本函数已按 `gm` 编译，再写 `(?m)` 会抛 `Invalid group` | 剥掉开头的 `(?ims…)` 并按需补 `i` / `s` |
| 多处替换的下标错位 | 逐处替换时右侧长度变化，第二处起替换到错误位置（症状是结果里出现重复片段） | 改为"间隙 + 新文本"升序拼接（§5.4 第 13 条） |
| `analyzeBytes()` 的 `invalidUtf8` | 硬编码 `false`，永远是假的标志位 | 删掉；非法 UTF-8 由 `decodeText` 的 `fatal: true` 判定 |
| `inferNewline` 的空扩展名 | `name.endsWith('')` 恒真，无扩展名目标把带点的文件也算进"同扩展名" | 无扩展名时只认无扩展名的兄弟文件 |
| `mask.mjs` 的 TDZ | `guard` 闭包读 `narrowing`，而声明在挂守卫之后：挂上后被同步调到就抛 TDZ | 声明提到挂守卫之前 |
| `mask.mjs` 巡查非隔离 | 一个 agent 失败会把整次 `tools/change` 派发带崩；`ctx.on` 失败会让整行挂载失败 | 逐 agent try/catch + 监听注册逐个 try/catch |

`tools/` 侧同轮修掉的主要缺陷：`audit-session` 把 `tool-call.arguments` 当成对象（"成功不得回显 `file_path`"这条断言因此**永远不可能失败**）、尾帧损坏会丢掉全部已解码帧、`--cap abc` 静默失效；`check-license` 的裸 import 扫描看不见跨行 import 与 `import('pkg')`、异常路径打堆栈而不是 `FAIL`；`selftest` 五条"名字与断言内容不符"的检查；已删除的 `bench-tokens` 也曾有一条恒真断言与一个只查 `existsSync` 的假校验（详见各文件注释）。

### 1.5 减法轮（当前）

一轮独立的"这算不算过度设计"复盘，用真实安装做了对照实验，然后**删掉五样东西**。删的依据不是偏好，是实测：

| 删掉 | 依据 |
|---|---|
| `output.presentationMeta` / `presentCall` / `presentResult`（GUI diff 卡片，`hunks` / `hunksTruncated` / `operation` 三个字段） | 宿主本来就会渲染调用参数；卡片只是把同一件事换个通道再说一遍 |
| 备份（`.dsh/backups/`）与台账（`.dsh/edits.log`），以及 `backup` / `ledger` / `artifactsDir` 三个配置键 | 没有任何下游读过它们；改动前的内容一次 `read` 就有，历史由编辑器/版本控制负责 |
| `escape` 逃生口（`native_edit` / `native_write`）与 `--escape` | 已默认关闭；为一个没人用的对照通道维护注册转发与一组断言 |
| `scope: 'global'` 配置键 | 挂载形状自己就能判出来（守卫落在全局层即降级成"只管守卫"），不需要配置表达 |
| `tools/bench-tokens.mjs`（约 1400 行 + `--assert` / `--logs` / `--md`） | 它只服务"论证本插件划算"；结论已固化进 README 的对照表与 §2.5，脚本本身是维护负担 |

对照实验同时**推翻了本包一条原本的声称**：原生 `write` 并不"把 CRLF 拍成 LF"——它把 `content` 原样落盘，所以 CRLF 进 CRLF 出；真正发生的是"不还原文件风格"，往 CRLF 文件里写 LF 内容才会把整个文件变成 LF。README 的表格已按实测改写（§"与原生工具的实际差异"）。

同理，`probe-mask` 因为删掉逃生口与 global 档从 23 项降到 18 项，`selftest` 从 171 项降到 150 项。这两处减少是**删除功能带来的**，不是覆盖退化：留下的每一项都还钉着一条仍在的行为。

## 2. 关键结论与证据

### 2.1 屏蔽失效的原因与修法（**已修**）

原实现：全部 deny 动作（`restrict()` + 空段遮蔽）只在 `maskAgent()` 里，唯一调用点是 `ctx.on('agent/created', ...)`。GUI 换 preset 的实际流程：

```
dsh-host-apiproxy   agentPreset.select → presets.recompose(agent.ctx, id)
                                       → session.append('agent-preset/selected', ...)
dsh-agent-presets   recompose(): "The swap is a parent re-link, not an unmount"
                                 只做 binding.rebind(standing.key)，不重建 agent
dsh-agent           announce() 对同一个 agent 二次调用会抛 "was already announced"
```

目标 agent 早已 announce → **监听器永远收不到东西**；只有 agent 被重建（重启 / 恢复会话）才命中。

**真实会话数据**（`node tools/audit-session.mjs --tools`，全量 88 个会话日志、128 条 `request/header`）：

| 那条 header 的工具表 | 条数 | 含义 |
|---|---|---|
| 原生 `write`/`edit` 在 + 本插件工具也在 | **25** | bug 现场：组合挂上了，收窄没发生 |
| 原生不在 + 本插件工具在 | 3 | 建档路径命中（含本次会话） |
| 原生在 + 本插件工具不在 | 94 | 别的 preset（无门禁行），不是 bug |
| 原生不在 + 本插件工具也不在 | 31 | 别的只读组合 |

**修法**（三条通路 + 一条回退）：

1. **`apply` 阶段挂守卫**（`ctx.tools.guard`，本行作用域层，与创建顺序无关）：任何 agent 首次直呼原生工具即被否决（原因"改用 `edit_text` / `write_text`"），并顺手经 `exec.agent.ctx` 补一次收窄。
2. **`agent/created`**：建档即加入本 preset 的 agent（含 subagent）立即收窄。
3. **`tools/change`**：`recompose()` 重绑作用域后发出（§2.2），此时枚举 `ctx.agents.list()` 收窄本组合成员。
4. **换出去要还原**：`restrict` / 空段 / 逃生口注册在 **agent 自己的层**上，不随 preset 更换消失；巡查发现它不再是本组合成员即成对撤销，否则该 agent 在新 preset 里**一个写工具都不剩**。

**归属判据**：把**本模块自铸的探测 exec** 交给 `ctx.tools.guardReason()`，按**对象身份**得三态 `member` / `outsider` / `unknown`，仅在确定 `outsider` 时撤销；它跑在"工具存不存在"之前。本包"零依赖、只用 `node:` 内建"是 `check-license` 的硬断言，`scopeOf` / `scopeChainOf` 只由 `@deepseek-ai/dsh-scope` 导出，故等价判据取自 `dsh-tools`：`guardReason()` 遍历 `chainLayers(exec.agent)`，即该 agent 作用域链上的每一层。

**四段验收**（`node tools/repro-mask.mjs`）：建档前挂载、建档后换 preset、首次绑定、换出去，工具表都须与组合一致。

### 2.2 新版给的修复钩子（已用上）

0.1.5-rc.2 的 `AgentPresets.recompose()` 在重绑作用域后新增 `this.ctx.emit('tools/change')`（包在 try 里，失败记 warn）：

```js
try { this.ctx.emit('tools/change') } catch (error) { /* 记 warn */ }
```

这正是 GUI 换 preset 的路径；它**不带 agent 参数**，故需自行枚举活 agent（`ctx.agents.list()`）再认领归属（§2.1）。旧版 0.1.0-rc.6 的 `recompose()` 无任何 emit。

### 2.3 上游两个缺陷在 0.1.5-rc.2 仍然存在 → 插件理由成立

| 缺陷 | 证据 |
|---|---|
| 覆盖写把 CRLF 抹成 LF | `dsh-fs-local` 的 `writeText()` 仍把 `content` 原样交给 `writeFileAtomic`，只有返回给 diff 用的 `after` 做了归一 |
| 编辑/写入丢 UTF-8 BOM | `dsh-fs-local` 的 `decodeUtf8()` 仍是 `new TextDecoder('utf-8', { fatal: true })`，默认 `ignoreBOM: false` → 解码时剥掉 BOM |

`dsh-tool-fs` 的 `edit` 仍是**精确字面匹配**（无宽松匹配、无行号/正则锚点），故本插件"保 BOM/行尾 + 宽松匹配 + `grep`/`lines` 锚点"三条差异化未被上游吃掉。

### 2.4 没法"只挂上游的 read"

`dsh-tool-fs` 的 `apply()` 一次性注册 `read`（+ `read_image`）与 `write`、`edit`，`Config` 只有四个 read 上限，`applyReadTool` 未导出 ⇒ 要零原生写工具只有两条路：**不挂** `dsh-tool-fs`（最稳，代价是自带上游那个 `read`），或挂上再**运行时收窄**（即 mask，依赖 `restrict` 的时序）。

### 2.5 token 账（`node tools/measure-context.mjs --static --vs-native`）

| 组合 | 静态开销 |
|---|---|
| 原生 `read` + `write` + `edit`（沙箱后端） | **773 tok/请求** |
| 插件 + 屏蔽原生（`guidance: short`）—— **当前 preset** | **700 tok/请求**（省 73） |
| 原生 + 插件共存（profile 层安装形态，也是屏蔽失效时的账单） | **1315 tok/请求** |

动态账：单次调用省 27～260 tok（失败重试最省）；典型构成的会话总量：原生 60984 vs 插件 51975（含两侧相同的共享 `read`），省 18%。屏蔽失效时真实会话付的是 **1315** 那一档，修好后回到 700。原先的 1193 那一档（`escape` 逃生口）已随该功能删除。

### 2.6 npm peer 的预发布陷阱（实测）

| range | 0.1.0-rc.6 | 0.1.5-rc.2 | 0.1.5 | 0.2.0 |
|---|---|---|---|---|
| `>=0.1.0-rc.6`（旧写法） | 命中 | **不命中** | 命中 | 命中 |
| `^0.1.0-rc.6` | 命中 | **不命中** | 命中 | 不命中 |
| `*` | 不命中 | 不命中 | 命中 | 命中 |
| `>=0.1.0-rc.6 \|\| >=0.1.5-rc.2`（现写法） | 命中 | 命中 | 命中 | 命中 |

规则：带 prerelease 的版本，只有当 range 里存在**同一 `major.minor.patch` 元组**且自身带 prerelease 的比较符时才算满足；故每验证一条新 rc 线要加一个子句。

### 2.7 引导段按可见性求值（空段遮蔽已是冗余保险）

0.1.5-rc.2 的 `dsh-tool-fs` 把工具引导段写成函数并查可见性：

```js
text: ({ scope }) => ctx.tools.get("write", scope) === void 0 ? "" : "Use the write tool ..."
```

即**工具被收窄后那段引导自动不下发**（`repro-mask` 的 "the native guidance is gone with the native tools" 即此断言；修前提示词里两边引导同时在场）。故"注册同名空段"是**冗余保险**：留着不花 token（空段渲染时被丢弃），而别的写工具行未必把引导写成函数；`sections: []` 可以关掉它。

### 2.8 沙箱链新增前置（会打断自建 harness）

0.1.5-rc.2 的 `SandboxPolicyService` 变成 `static inject = ['sessionProjections']`，改用 `ctx.sessionProjections.stateOf(session, 'sandboxMode')`；自建组合不先挂投影登记表则策略行不落地 → 沙箱版 fs 的 `inject: ['sandboxPolicy']` 解析不了 → `ctx.fs` 不存在（症状是后面某个 `createScope(host)` 报 "Cannot read properties of undefined"）。挂载顺序照 `tools/measure-context.mjs` 与 `tools/repro-mask.mjs` 里的写法。

### 2.9 判定屏蔽是否生效的读法

唯一标准是会话日志里 `request/header` 的工具表（`header.tools[].name`）；`--tools` 逐会话打印它、`reason` 字段与一行判定（`native write/edit: PRESENT (...)` / `masked`，外加本插件工具在不在）。对照组要换一个组合，不能靠"同一 preset 里没被通知到的兄弟 agent" —— 它现在也会被巡查收窄（有意为之）。

### 2.10 对抗性评审（10 条，按处理结果记账）

修完后做过一轮独立对抗性评审（只读、不改文件、读 0.1.5-rc.2 的安装源码）。**没有一条是"设计错了"**：三条通路被判正确，子 agent / 恢复会话 / 逃生口不绕策略这几类它明确写了"没找到问题"。

| 编号 | 它说的问题 | 处理 |
|---|---|---|
| F1 | 别人的守卫**抢答**（`guardReason` 先看全局层、再取作用域链上第一个非空答复）⇒ 判成 `outsider` ⇒ 巡查**撤销**一条真成员的收窄 | **已修**：答复非哨兵且非 `undefined` 时判 `unknown`（`membership()`），仅确定 `outsider` 才撤销 |
| F2 | `guardReason` **不在** `dsh-tools` 的公开表面里（`dsh-tool-cordis` 未列出它），改名/移除即"永远 `unknown` 且没有任何日志" | **已修**：判据不可用时记一条 `warnOnce`（点名"换 preset / 换出去还原不再生效"）；文件头注明这是实现方法而非公开接口 |
| F3 | 注册挂在 **agent 的 fiber** 上，本行卸载（HMR / `disabled: true`）不带走它们，留下没人能撤的屏蔽 | **已修**：`installs` 改成可枚举的 `Map` + 行级 `ctx.effect` 卸载钩子；`agent/disposed` 时摘账 |
| F4 | 收窄同步发 `tools/change` ⇒ 嵌套巡查，N 个 agent 同时加入即 O(N²) | **已修**：重入闸门 + "跑完再跑一次"的待办位 |
| F5 | `masked.add()` 在 try 之前、失败也记账 ⇒ **一次瞬时失败永久生效** | **已修**：幂等判据改成 `installs.has(agent)`，且**只有真的装上东西才记账** |
| F6 | `registerEscape()` 可能返回 `undefined` 却被当作撤销句柄 push | **已修**（今天不可达） |
| F7 | 文件头声称"看不见的名字走不到守卫" —— **是错的**：`guardReason()` 跑在"工具存不存在"之前 | **已修**：探测改用**对象身份**（只有本模块铸出来的探测对象才得到哨兵）；评审里最有价值的一条 |
| F8 | guard 档其实也遮蔽了那两段引导，而文档说"schema 与引导的钱照付" | **改文档**（行为保留：调用都被拒，留着引导只会让模型去试）：`lib/mask.mjs` 头、`scripts/install-preset.mjs`、两份 README |
| F9 | 宿主平面安装时守卫落在全局层，"收窄"会连别的 preset 一起改 | **已修**：用不带 agent 的探测认出"守卫在全局层"，退化成"只管守卫"并记一条 warn（后随 `scope` 配置键一起删除，改为唯一行为） |
| F10 | 同一 preset 两代常驻组合共享哨兵，第二代把第一代成员认成自己的 ⇒ 重复注册同名段 ⇒ 每 agent 一条 warn（**无功能损失**） | **接受现状**：触发条件是"改组合文件又不重启"，代价只是警告噪音；修它要么把账本提到模块级（跨代互相干扰），要么放宽 section 冲突 |

**它还抓到一条我们自己没测出的真回归**：`installs` 记账挪到"装完再记"后，`restrict()` 同步发出的 `tools/change` 会在记账前把嵌套巡查引回来，同一 agent 被装两遍、第二遍的同名段抛错；`probe-mask` 当场报出，而 `selftest` 的假世界那时还不会 notify。现两头都补：`lib/mask.mjs` 用 `installing` 集合立"正在装"的牌子（与 `dsh-tool-subagent` 同形），假世界也在注册时同步发 `tools/change`，并有两条断言钉住"不重复安装"与"闸门不许吃掉后续巡查"。

## 3. 设计思路

### 3.1 插件的定位与取舍

- **返回值只留一行统计**：成功 `WROTE` + `replace@17 +1/-1`，失败 `FAIL` + 原因 —— 结果每轮重发，回显改动内容是纯浪费。
- **成功不回显路径**：`file_path` 就在同轮参数里；失败原因**允许**带路径，它要指名文件。
- **锚点三选一**（`old_text` / `grep` / `lines`）+ `count` 声明期望命中数：用**索引**表达"改哪里"。实测块重写省 44%、重复块里改一行省 26%。
- **宽松匹配**：精确失败按"行尾空白 / 行块相似度"回退（相似度 ≥ 0.9 视为命中）并加一行 `[warn]`；对应"锚点差一个尾随空格 → 原生报 `FS_EDIT_NOT_FOUND` → 只能再读一次文件"，实测省 79%。
- **字节保真**：保 BOM 与文件自身行尾 —— 立身之本；注意实测后修正的说法：原生 `write` 不"拍平 CRLF"，它只是不还原风格（§1.5）。
- **不写旁路产物**：没有备份、台账与 diff 投影；`DSH_TEXT_EDITOR_EOL`（`lf` \| `crlf`）覆盖**新建文件**的行尾推断。

### 3.2 mask 的设计与失效的假设

门禁当初挂在 `agent/created`：`tools.restrict()` 只能从**有作用域的上下文**调用。**失效的假设**是"agent 一定在 preset 挂好之后才创建" —— 真实 GUI 流程是"先按默认 preset 建 agent，再换上用户选的 preset"（§2.1），而重新挂载是 relink 而非重建，监听器错过了唯一一次事件；`probe-mask.mjs` 因手工投递事件恰好绕过这个前提，从未报警（本轮已改真注册表）。

**修好后的形状**是"三个触发点 + 一个归属判据 + 成对撤销"：

| 部件 | 解决什么 | 不解决什么 |
|---|---|---|
| `apply` 阶段的守卫 | 与创建顺序无关，最迟在第一次原生调用时否决；顺手收窄，下一次请求就干净 | 只保证"调不动"，管不了工具表 |
| `agent/created` | 建档后才加入的 agent 立刻收窄 | 换 preset 的 agent（事件早发完了） |
| `tools/change` 巡查 | 换 preset（以及换出去）那一刻就收窄 / 还原 | 没有 `agents` 注册表的自建组合 |
| 守卫探测归属 | 只认"本层在这个 agent 的作用域链上"，不需要 import `dsh-scope` | 依赖 `guardReason` 的语义（实现方法，非公开表面，见 F2） |

代价：多一个常驻守卫（每次工具调用过一遍，非 deny 名字立即返回）、每次 `tools/change` 枚举一次活 agent；"撤销"必须成对（§2.1 第 4 条）。

### 3.3 三条路线的对比

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. 修 mask（**已做完**） | 守卫 + `tools/change` 巡查 + 就近收窄 + 成对撤销 | 代码量最小，保留上游 `read`（含 `read_image`、GUI 卡片、观察事件） | 仍依赖上游事件/限制语义，新版再改还得跟 |
| B. 不挂 `dsh-tool-fs`，自带 `read` | preset 里把那行换掉，自己实现 `read` | 屏蔽问题从根上消失（工具不存在，不是藏起来） | 要接手上游 `read` 的语义面（窗口/截断/footer/错误码/呈现 meta/`read_image`），估约 450 行 |
| C. 换 `str_replace_editor` | preset 里挂 `@deepseek-ai/dsh-tool-str-replace-editor`（一个工具含 `view`/`create`/`str_replace`/`insert`） | 上游现成，一个 schema | 要求 `old_str` EXACT 匹配；走 `ctx.fs`，BOM/行尾两个缺陷一样继承；和本插件差异化全丢 |

A 已落地并有四段回归（`repro-mask`）；B 只在"必须零原生 schema 且不依赖任何 mask 机制"时才值得，且要先立对拍（§3.5）。

### 3.4 跑分方法学（脚本已删除，留在 §2.5 的结论里）

当时的做法：真栈不 mock（真 cordis `Context` + 真 `dsh-tools` / `dsh-system-prompt` / `dsh-fs-local` / `dsh-tool-fs` / 本插件，再 `ctx.tools.execute()`）；两侧都真跑并读回文件校验，每侧取自己的最优；共享的 `read` 单列计价、不计入 Δ。计价用 `@deepseek-ai/dsh-token-meter` 的 `estimateContent`（`ceil(chars/4)` + 每块 4 token，与 GUI 上下文压力条同一把尺子）。边界：`chars/4` 是启发式，会话聚合用一个写死的"典型构成"，真实日志含早期版本的形状。

**再做时不要从零写**：`tools/measure-context.mjs --static --vs-native` 已经给出静态那一档（2362 B / 700 vs 773 tok），而这正是当初唯一值得反复引用的数字；其余场景级 Δ 只用于内部论证，已随脚本删除。

### 3.5 如果将来要走 B 路线：先立对拍

写 `tools/diff-read.mjs` 把"重写 read"变成**可验证的移植**：同一语料 × 同一批参数，把上游 `read` 与自研 `read` 的 `execute → render` **逐字节对拍**（上游 `read` 会吃掉 BOM，见 §2.3）。

## 4. 未完成的工作（按优先级）

### P0 —— 修 mask（**已完成**）

1. 复现：`tools/repro-mask.mjs`（真 `AgentPresets` + 真注册表），修前 12/19，修后 23/23（后补"换出去""子 agent 加入""宿主里还有别人的守卫"三段）。
2. `lib/mask.mjs` 三条一起上：`apply` 阶段挂守卫、`agent/created`、`tools/change` 巡查；外加**换出去时成对撤销**（原计划没有）。
3. 空段遮蔽保留并注明冗余（§2.7）。
4. 回归：`probe-mask` / `repro-mask` / `selftest` 全绿。

**唯一还欠的一步**：在重启后的宿主上跑一次真实验收（§7 开头那三条命令）。

### P1 —— 收尾

- `npm test` 保持"不带 dsh 也能跑"：`probe:mask` / `repro:mask` 不进 `npm test`（没有 dsh 包时退出码 2）。
- 跑分脚本已删除（§1.5）；需要重新论证开销时用 `node tools/measure-context.mjs --static --vs-native`，它给的是同一组静态数字。

### P2 —— 决策项

- ~~`escape` 去留~~：**已随减法轮删除**（§1.5）。不再有对照通道；要看原生行为就用别的 preset 新建会话。
- 发布：`package.json` 已是 `1.2.0`（registry 上最新是 `1.1.2`）；发布前重跑 `npm test`。发布内容含本轮的 `lib/`；`tools/` 与 `scripts/` 不在白名单里。注意 `preset/preset.yml` 的描述变了，装好的 preset 需要重生成才会同步。

### P3 —— 选做

- B 路线（自带 `read`，§3.3 / §3.5）；或 C 路线（换 `str_replace_editor`）作为对照。

### P4 —— 未决问题

- **许可证是否从 Apache-2.0 改成 MIT**：结论上可以 —— 版权人是自己，已发布的 `1.0.0`～`1.1.2` 对已获得者仍按
  Apache-2.0 生效，后续版本可改；但**照搬上游 MIT 代码并不需要先改**（MIT 兼容 Apache-2.0，保留上游声明即可）。
- 真要改，动四处：`LICENSE`、`package.json` 的 `license`、两个 README 的 License 段，以及
  `tools/check-license.mjs` 里针对"零依赖 + Apache-2.0"的断言。

## 5. 交接操作手册

### 5.1 环境与路径

| 变量 / 路径 | 含义 |
|---|---|
| `$env:DSH_HOME` | dsh 的家目录（`sessions/`、`.agent-presets/`、`profiles/` 都在它下面） |
| `<DSH_HOME>/profiles/node_modules/@deepseek-ai` | profile 装的 dsh 包（0.1.5-rc.2），`tools/*` 的默认查找位置 |
| `<DSH_HOME>/.agent-presets/texteditor` | 唯一的用户 preset（生成物，可用脚本重生成） |
| `<DSH_HOME>/settings.yaml` | 含 `agent-presets.default: texteditor` |
| `<DSH_HOME>/sessions/<工作区>/session-*/session.jsonl.zstd` | 会话日志（分帧 zstd） |
| `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` | 全局 dsh CLI |
| 本仓库根目录 | `lib/`、`preset/`、`scripts/`、`tools/` 所在，命令都在这里跑 |

脚本找 dsh 包的位置都支持覆盖：`DSH_PACKAGES_ROOT`（`probe-mask` / `repro-mask`）、`DSH_PRESET_SOURCE` 或 `--from`（`install-preset`）、`DSH_TOOL_FS_ENTRY` / `DSH_TOOLS_ENTRY`（测量脚本）。

### 5.2 常用命令

```powershell
# 闸门与自测（不需要 dsh）
node tools/selftest.mjs
node tools/check-license.mjs

# 需要 dsh 的验证（找不到包时退出码 2）
node tools/probe-mask.mjs                    # 注册表语义
node tools/repro-mask.mjs                    # 组合时序（真 AgentPresets）
node tools/gen-schema.mjs                    # 内嵌 schema 是否仍与 DSL 一致
node tools/measure-context.mjs --static --vs-native   # 静态开销 + 原生那一侧的对照

# 真实会话：屏蔽到底有没有生效
node tools/audit-session.mjs --tools         # 每个会话的 request/header 工具表 + 判定行

# preset 的生成 / 预览 / 回滚（当前形态：屏蔽档，无额外 config）
node scripts/install-preset.mjs --mask-native --dry-run
node scripts/install-preset.mjs --mask-native --force
#   回滚：删掉 <DSH_HOME>/.agent-presets/texteditor，或给 tool-text-editor 行加 disabled: true
```

preset 是**会话创建时的事实**：改完必须重启 `dsh web` 再**新建**会话才生效，已开着的会话切不过去（§5.4 第 12 条）。

### 5.3 怎么读真实会话日志

文件是分帧 zstd，Node 的 `zstdDecompressSync` 只解第一帧，要按魔数 `28 b5 2f fd` 切帧再拼。现成实现是 `tools/audit-session.mjs`（`decodeFrames()` 可抄，`--tools` 见 §2.9）。关心的事件：`request/header`（`data.header.tools[].name` 就是那一轮真实下发的工具表；`data.reason: initial` 表示第一轮）与 `session` 的 `agentPreset` / `agent-preset/selected`。

### 5.4 已知坑清单

1. **`agent/created` 只发一次**，`announce()` 二次调用会抛；`recompose()` 是父级 re-link 而非重建 —— "创建时做一次"的设计要先问 agent 会不会被重新组合。
2. **`tools.restrict()` 只能在有作用域的上下文调**（`agent.ctx`）：preset 的所有行共享同一常驻层（`scopeOf(rowCtx)` 就是 `standings` 那把 `{ agentPreset: <id> }` 键，与 `presets.standingKeyFor(id)` 同一引用），从行 ctx 调必抛 `names unknown global tool ... known global tools: (none)`。
3. **`agent.ctx.tools` 需要作用域铸自"声明了 inject 的上下文"**，否则抛 `cannot get property "tools" without inject`，门禁静默失败（只留 warn）。
4. **收窄写在 agent 自己的层上，不随 preset 更换消失**：换出去的 agent 必须成对撤销，否则一个写工具都没有（§2.1 第 4 条）。
5. **npm 预发布范围**：每验证一条新 rc 线要在 peer 里加一个子句（§2.6）。
6. **`@deepseek-ai/*` 子包的 `latest` dist-tag 指向很老的 `0.0.1-rc.1`**，装时必须带版本号或连 CLI 一起装（`npm i -g @deepseek-ai/dsh@0.1.5-rc.2`）。
7. **自带 preset 位置随版本搬家**：≤ 0.1.0-rc.6 在 `@deepseek-ai/dsh/config/agent-presets/`，≥ 0.1.5-rc.2 在 `@deepseek-ai/dsh-agent-presets/presets/`。
8. **沙箱组合要先挂 `sessionProjections`**（§2.8），否则整条链静默不落地。
9. **行尾约定**：`.gitattributes` 规定全仓库 LF、无 BOM（`check-license` 会断言）；中英混排留空格，同一行不得同时出现 `dsh` 与上游那份许可证名。
10. **profile 层安装 = 共存**（静态 +542 tok/请求），只有 preset 能真正换掉组合。宿主平面那一档的守卫落在全局层，本行会自己探测出来并退化成"只管守卫"（记一条 warn），绝不收窄别的 preset。
11. **注册会同步 notify**：`restrict()` / `section()` 落地即发 `tools/change`，而门禁正在听它 —— "先记账还是先注册"的顺序有后果（§2.10）。
12. **改了 `lib/mask.mjs` 或 preset 都要重启 `dsh web`**（进程握着挂载时的模块实例与 preset 世代），新建会话才走新代码。
13. **替换多处命中时不要用"从后往前 + 下标修正"**：区间是**原文**下标，每替换一处右侧长度就变了。`applyPlan` 现在改成按 `start` 升序拼"间隙 + 新文本"的一次遍历（§1.4），没有任何坐标换算。

## 6. 文件地图

```
lib/core.mjs                 编辑内核：BOM/行尾、锚点解析、匹配、原子写、同目标串行
lib/editor.mjs               插件面：schema、校验、注册、只读镜像
lib/mask.mjs                 可选行：按 agent 收窄原生 write/edit（守卫 + 事件通路 + 成对撤销）
preset/preset.yml            preset 元数据（安装脚本按模式补状态句）
scripts/install-preset.mjs   生成用户 preset（--mask-native 一并装门禁）
cordis.patch.yml             profile（宿主平面）安装用的 bundle patch
tools/selftest.mjs           端到端自测（150 项；不需要 dsh）
tools/probe-mask.mjs         门禁语义探针（18 项；需要 dsh）
tools/repro-mask.mjs         组合时序复现（23 项；需要 dsh，真 AgentPresets）
tools/measure-context.mjs    单次调用的上下文字节数 + 静态开销
tools/audit-session.mjs      会话日志对账（路径回显、上限；`--tools` 看每轮工具表）
tools/gen-schema.mjs         内嵌 schema 的权威来源与检查
tools/check-license.mjs      许可证 / 依赖 / 行尾 / 文档风格闸门
```

## 7. 验收与口径

- **"屏蔽原生"已修好**（§2.1），四条组合路径都有回归（`repro-mask`）；上游 0.1.5-rc.2 的 `tools/change` 钩子已用上，未照搬上游代码。
- **减法轮**（§1.5）删掉了 diff 卡片、备份台账、`escape`、`scope` 配置键与跑分脚本；README 里"原生把 CRLF 拍成 LF"的说法已按实测改写。
- **还欠一次真实验收**（重启宿主得由人来点）：

  ```powershell
  node tools/check-license.mjs                 # 30/30
  node tools/selftest.mjs                      # 150/150
  node tools/probe-mask.mjs; node tools/repro-mask.mjs   # 18/18、23/23
  # 然后：重启 dsh web → 新建一个会话（走 GUI 的"先建后换"路径）→
  node tools/audit-session.mjs --tools
  #   期望：新会话的**第一条** request/header 就已经是 masked（§2.1）；
  #   修复前的基线：88 个会话日志里 25 条 header 同时带原生工具与本插件工具。
  ```

- 判断屏蔽是否生效的标准只有一个：**会话日志里 `request/header` 的工具表**（`--tools` 就是它）；脚本全绿不等于线上生效 —— `probe-mask` 全绿的那一版曾经整整一轮都没生效。
- 每个数字都标注了来源（脚本、事件、文件行）；改代码前先跑对应脚本，用同一把尺子复现，再动手。
