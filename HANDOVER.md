# 结算与交接 —— dsh-tool-text-editor

> 这是**开发交接件**，不是发布件：`package.json` 的 `files` 白名单没有它，它不会进 npm。
> 目的：让下一个接手的人（或下一个会话）不用重读整个对话，就能知道**结论、证据、坑与下一步**。
> 写作约定：路径用变量（`$env:DSH_HOME`、`%APPDATA%`）或相对路径，不写死的机器路径 —— 这条同时受
> `tools/check-license.mjs` 的"无机器专属绝对路径"断言保护。

## 0. 一眼看现状（TL;DR）

| 项目 | 状态 |
|---|---|
| 插件本体 `lib/` | 可用；`edit_text` / `write_text` 语义与返回形状未变 |
| 自测与闸门 | 全绿：`selftest` 167/167、`check-license` 30/30、`probe-mask` 23/23、`repro-mask` 23/23、`bench-tokens --assert` 16/16 |
| 本机 dsh | **0.1.5-rc.2**（CLI 与 profile 同步升级，cordis 4.0.2） |
| preset | `<DSH_HOME>/.agent-presets/` 只剩 `texteditor`；**已去掉 `escape`**（回到 700 tok/请求），mask 行不带 `config` |
| ~~最大的未修 bug~~ | **已修**：屏蔽在 GUI 换 preset 的路径上不生效（§2.1）。真实会话证据：文本编辑 preset 的 `request/header` 里 25 条仍带原生 `write`/`edit`，只有 3 条收窄了 |
| 修它用的上游钩子 | 0.1.5-rc.2 的 `recompose()` 会发 `tools/change`（§2.2），已用上；不需要照搬上游代码 |
| 下一步第一件事 | **重启 `dsh web` + 新建一个会话**，然后 `node tools/audit-session.mjs --tools` 看新会话的**第一条** `request/header` 是否已经收窄（本地这一轮验证还没跑：重启宿主得由你来点） |

## 1. 最近一轮做了什么

### 1.1 仓库改动

| 文件 | 改动 | 原因 |
|---|---|---|
| `lib/mask.mjs` | **重写收窄的通路**：`apply` 阶段就挂守卫（与创建顺序无关）+ 保留 `agent/created` + 新增 `tools/change` 巡查 + 离开组合时成对撤销 | 原实现只有 `agent/created` 一个入口，而 GUI 是"先建 agent、后换 preset"，`recompose()` 只做父级 re-link，事件早就发完了（§2.1） |
| `tools/repro-mask.mjs` | **新增**（约 300 行） | 用**真实的** `dsh-agent-presets` + `dsh-agent` 驱动四条组合路径并断言工具表；修之前 4/7 条失败，就是这次的验收标准 |
| `tools/probe-mask.mjs` | 门禁行改用**真实的作用域上下文**挂载，agent 走**真实注册表**（不再手工投递 `agent/created`）；新增"没有建档事件也拦得住"的断言 | 假 ctx 里的 `tools` 拿不到本行的作用域层，守卫会落到全局层；手工投递那个坑（§2.1）也不该继续留在探针里 |
| `tools/selftest.mjs` | 门禁套件从假 `{ on, logger }` 扩成能建模"守卫注册 / 归属探测 / 巡查 / 撤销"的假世界（136 → 167 项） | 三条通路与撤销都要能在**不需要 dsh** 的前提下钉住 |
| `tools/audit-session.mjs` | 新增 `--tools`：逐个会话打印每条 `request/header` 的真实工具表与判定行 | 判断屏蔽是否生效的唯一标准就是这张表（§5.3），以前只能手工解帧看 |
| `tools/measure-context.mjs` | 假 ctx 补上 `systemPrompt.getSectionOrder` 与"按可见性求值"的段文本（`sectionText()`） | `--vs-native` 在 0.1.5-rc.2 上**必崩**：`dsh-tool-fs` 注册引导段时会问段序号，且 `tool:write` / `tool:edit` 的 `text` 已经变成函数（直接 `bytes(section.text)` 量到的是函数源码）。它崩了，README 里三处引用它的话就成了空话；修好后数字仍是 1754 B schema + 608 B 引导 = 2362 B |
| `package.json` | `scripts` 加 `repro:mask` | 与 `probe:mask` 并列 |
| `HANDOVER.md` / `README.md` / `README.zh.md` | 跟着上面改 | 交接件与文档里"最大未修 bug"的说法已经过期 |

`tools/` 与 `scripts/` 都不在发布白名单里，所以以上改动不影响 npm 包内容（但 `lib/mask.mjs` 在发布内容里）。

### 1.2 本机环境改动（不在 git 里）

- 删除了 `<DSH_HOME>/.agent-presets/` 下的 `test`、`test1`、`winminmal`（用户要求清掉）。
- `texteditor` 重新生成过两次：一次从新版自带 `standard` 注入插件段（验证方式见上一版交接），一次就是这一轮——
  `node scripts/install-preset.mjs --mask-native --force`，**去掉了 `escape`**（用户决定：门禁修好之后不再需要
  `native_edit` / `native_write` 那条对照通道，省 493 tok/请求）。
- 用户自己完成的：dsh 升到 0.1.5-rc.2；profile 里移除了 `@linxin666/dsh-web-ui-all`。
- **还没做的**：重启 `dsh web`。运行中的进程握着旧版的 `lib/mask.mjs` 模块实例与旧的 preset 世代，所以这次的
  修复对**已经在跑的会话**无效（包括写这份交接的那个会话）。新建会话 + `--tools` 复核是新宿主上的事。

### 1.3 验证记录（都在 0.1.5-rc.2 上）

```powershell
node tools/selftest.mjs            # 167/167
node tools/check-license.mjs       # 30/30
node tools/probe-mask.mjs          # 23/23（真实 dsh 包 + 真实注册表）
node tools/repro-mask.mjs          # 23/23（真实 AgentPresets；修之前 12/19）
node tools/bench-tokens.mjs --assert   # 16/16，数字与 0.1.0-rc.6 上完全一致（屏蔽组合仍 700 tok/请求）
node tools/gen-schema.mjs          # OK
```

`probe-mask` 与 `repro-mask` 的分工：前者验**注册表语义**（收窄之后"看不见"与"调不动"是不是同一张视图、
逃生口、guard 档、global 档），后者验**组合时序**（建档前挂载 / 建档后换 preset / 首次绑定 / 换出去）。
两者都需要 dsh 包，缺包时退出码 2。


## 2. 关键结论与证据

### 2.1 屏蔽为什么不生效，以及这一轮怎么修的（**已修**）

**当时的机制**：`lib/mask.mjs` 的全部 deny 动作（`restrict()` + 空段遮蔽）只在 `maskAgent()` 里做，
而 `maskAgent()` **只有一个调用点**：`ctx.on('agent/created', ...)`。没有兜底路径、没有懒触发。

**为什么这个钩子收不到事件**（GUI 实际流程）：

```
dsh-host-apiproxy   agentPreset.select → presets.recompose(agent.ctx, id)
                                       → session.append('agent-preset/selected', ...)
dsh-agent-presets   recompose(): "The swap is a parent re-link, not an unmount"
                                 只做 binding.rebind(standing.key)，不重建 agent
dsh-agent           announce() 对同一个 agent 二次调用会抛 "was already announced"
```

也就是说：新挂上来的门禁行注册了监听器，但目标 agent 早就 announce 过了 → **监听器永远收不到东西**。
只有 agent 被重新创建（重启 / 恢复会话）时才会命中。

**真实会话数据**（`node tools/audit-session.mjs --tools`，全量 88 个会话日志、128 条 `request/header`）：

| 那条 header 的工具表 | 条数 | 含义 |
|---|---|---|
| 原生 `write`/`edit` 在 + 本插件工具也在 | **25** | **bug 的现场**：组合挂上了，收窄没发生 |
| 原生不在 + 本插件工具在 | 3 | 建档路径命中了（含写这份交接的会话） |
| 原生在 + 本插件工具不在 | 94 | 用的是别的 preset（没有门禁行），不是 bug |
| 原生不在 + 本插件工具也不在 | 31 | 别的只读组合 |

**这一轮的修法**（`lib/mask.mjs` 现在三条通路 + 一条回退）：

1. **`apply` 阶段就挂守卫**（`ctx.tools.guard`，挂在本行自己的作用域层上）：与 agent 创建顺序无关。
   组合里任何 agent 第一次直呼原生工具都会被否决（原因是"改用 `edit_text` / `write_text`"），
   并且**顺手用 `exec.agent.ctx` 补一次收窄**——于是下一次请求的工具表就已经干净。这是"最迟防线"。
2. **`agent/created`**：建档时就加入本 preset 的 agent（含 subagent）立即收窄。原样保留。
3. **`tools/change`**：`recompose()` 重绑作用域之后会发它（§2.2）。此时枚举 `ctx.agents.list()`，
   把**属于本组合**的 agent 收窄。这就是 GUI 换 preset 的那条路。
4. **换出去也要还原**：`restrict` / 空段 / 逃生口都注册在 **agent 自己的层**上，不随 preset 更换消失。
   所以每个 agent 的注册句柄都留着，巡查发现它"不再是本组合成员"就成对撤销——否则那个 agent 在新 preset 里
   既没有原生名字、也没有本插件的名字，**一个写工具都不剩**。

**四段验收**（`node tools/repro-mask.mjs`，真 `AgentPresets` + 真注册表）：建档前挂载、建档后换 preset、
首次绑定、换出去，工具表都必须与组合一致。修之前 4/7 条失败（换出去的还原那时也不存在）。

**归属判据为什么不用 `dsh-scope`**：本包"零依赖、只用 `node:` 内建"是 `check-license` 的硬断言，
而 `scopeOf` / `scopeChainOf` 只有 `@deepseek-ai/dsh-scope` 导出。等价的判据在 `dsh-tools` 里：
`ctx.tools.guardReason(exec)` 遍历 `chainLayers(exec.agent)`，也就是**这个 agent 的作用域链上的每一层**——
本行的守卫只挂在本行的层上，所以"守卫被调用"当且仅当"本层在链上"。探测用一个**不存在的工具名**：
看不见的名字在守卫阶段之前就已经是 `UNKNOWN_TOOL`，真实调用永远带不进这个名字，所以它不影响任何真实行为。
（同一个形状在 `dsh-tool-subagent` 里写作 `scopeChainOf(scopeOf(candidate.ctx)).includes(compositionScope)`，
那是上游包，可以自由 import `dsh-scope`；本包不行。）

**这一轮顺带发现的三件事**（写代码时别再踩）：

1. **preset 的所有行共享同一个常驻层**：`scopeOf(rowCtx)` 就是 `standings` 那把键（`{ agentPreset: <id> }`，
   实测与 `presets.standingKeyFor(id)` 返回的对象**同一引用**），所以从行自己的 ctx 调 `restrict()` 必然抛
   `names unknown global tool ... known global tools: (none)`——原生工具与本行注册在**同一层**里。收窄只能经
   `agent.ctx`。
2. **`agent.ctx.tools` 要求 agent 作用域是从"声明了 inject 的上下文"铸出来的**：`createScope()` 的文档写着
   "scoped context inherits the minting plugin's dependency API"。自建 harness 里若从裸 `Context` 铸作用域，
   `agent.ctx.tools` 会抛 `cannot get property "tools" without inject`——门禁会静默失败（只留一条 warn）。
   真实的 agent 工厂是从注入过 `tools` 的上下文铸的，所以线上没这个问题；`repro-mask` / `probe-mask` 里
   都从带 inject 的 host ctx 铸。
3. **守卫是唯一"与创建顺序无关"的杠杆**：它挂在层上，`guardReason` 按 `exec.agent` 的作用域链求值，
   所以注册时刻不影响覆盖范围。`restrict` 不行（它写进 agent 自己的层），所以它必须靠事件驱动 + 巡查补。

### 2.2 新版给了修复钩子（已用上）

0.1.5-rc.2 的 `AgentPresets.recompose()` 在重新绑定作用域之后新增：

```js
try { this.ctx.emit('tools/change') } catch (error) { /* 记 warn */ }
```

这正是 GUI 换 preset 的路径。它**不带 agent 参数**，所以修的时候要自己枚举活 agent（`ctx.agents.list()`）
再认领归属（§2.1 末尾那个守卫探测）。旧版（0.1.0-rc.6）的 `recompose()` 没有任何 emit，
这也是为什么"先升级再修"是更省的那条路。

### 2.3 上游两个缺陷在 0.1.5-rc.2 仍然存在 → 插件理由成立

| 缺陷 | 证据 |
|---|---|
| 覆盖写把 CRLF 抹成 LF | `dsh-fs-local` 的 `writeText()` 仍把 `content` 原样交给 `writeFileAtomic`，只有返回给 diff 用的 `after` 做了归一 |
| 编辑/写入丢 UTF-8 BOM | `dsh-fs-local` 的 `decodeUtf8()` 仍是 `new TextDecoder('utf-8', { fatal: true })`，默认 `ignoreBOM: false` → 解码时剥掉 BOM |

另外 `dsh-tool-fs` 的 `edit` 仍是**精确字面匹配**（没有宽松匹配、没有行号/正则锚点），
所以本插件的"保 BOM/行尾 + 宽松匹配 + `grep`/`lines` 锚点"三条差异化都没有被上游吃掉。

### 2.4 没法"只挂上游的 read"

`dsh-tool-fs` 的 `apply()` 一次性注册 `read`（+ `read_image`）与 `write`、`edit`，`Config` 只有四个 read 上限，
`applyReadTool` 也没有导出。所以想要"没有原生写工具"，只有两条路：

1. **不挂** `dsh-tool-fs`（组合层事实，结构上最稳），代价是得自带上游那个 `read`；
2. 挂上再**运行时收窄**（就是现在的 mask），代价是依赖 `restrict` 的时序 —— 也就是 §2.1 那个坑，
   现在用三条通路 + 撤销堵上了。

### 2.5 token 账（`node tools/bench-tokens.mjs`）

| 组合 | 静态开销 |
|---|---|
| 原生 `read` + `write` + `edit`（沙箱后端） | **773 tok/请求** |
| 插件 + 屏蔽原生（`guidance: short`，无 `escape`）—— **当前 preset** | **700 tok/请求**（省 73） |
| 插件 + 屏蔽原生 + `escape` | **1193 tok/请求**（比原生多 420） |
| 原生 + 插件共存（profile 层安装时的形态，也是屏蔽失效时的实际账单） | **1315 tok/请求** |

动态账：单次调用省 27～260 tok（看场景），失败重试场景最省（原生要"报错 → 再读一次文件 → 重试"）；
真实会话日志的可比子集里，原生 505.5 tok/次 vs 插件 310.2 tok/次。
一个典型构成的会话总量：原生 60984 vs 插件 51975（含两侧相同的共享 `read`），省 18%。

注意最后两行的关系：**屏蔽失效时，真实会话付的是 1315 那一档**（原生照旧下发 + 插件也在），比原生单独还贵；
修好之后回到 700。这也是这次修复的经济理由。

### 2.6 npm peer 的预发布陷阱（实测）

| range | 0.1.0-rc.6 | 0.1.5-rc.2 | 0.1.5 | 0.2.0 |
|---|---|---|---|---|
| `>=0.1.0-rc.6`（旧写法） | 命中 | **不命中** | 命中 | 命中 |
| `^0.1.0-rc.6` | 命中 | **不命中** | 命中 | 不命中 |
| `*` | 不命中 | 不命中 | 命中 | 命中 |
| `>=0.1.0-rc.6 \|\| >=0.1.5-rc.2`（现写法） | 命中 | 命中 | 命中 | 命中 |

规则：带 prerelease 的版本，只有当 range 里存在**同一 `major.minor.patch` 元组**且自身带 prerelease 的
比较符时才算满足。所以每验证一条新的 rc 线就要加一个子句 —— 上游那些包是靠"每次发版同步抬 peer"绕开的。

### 2.7 新版引导段按可见性求值（mask 的空段遮蔽已经是冗余的保险）

0.1.5-rc.2 的 `dsh-tool-fs` 把工具引导段写成函数并查可见性：

```js
text: ({ scope }) => ctx.tools.get("write", scope) === void 0 ? "" : "Use the write tool ..."
```

含义：**只要工具被收窄，那段引导就自动不下发**了。`repro-mask` 里那条 "the native guidance is gone with
the native tools" 就是这个事实的断言（修复之后成立；修复之前提示词里同时留着原生引导与本插件的引导）。
所以 mask 的"注册同名空段"现在是**冗余的保险**：留着不花 token（空段在渲染时被丢弃），
而别的写工具行未必把引导写成函数。`sections: []` 可以关掉它。

### 2.8 沙箱链新增前置（会打断自建 harness）

0.1.5-rc.2 的 `SandboxPolicyService` 变成 `static inject = ['sessionProjections']`，并且改用
`ctx.sessionProjections.stateOf(session, 'sandboxMode')`。自建组合如果不先挂投影登记表，
策略行不会落地 → 沙箱版 fs 的 `inject: ['sandboxPolicy']` 解析不了 → `ctx.fs` 根本不存在
（症状是后面某个 `createScope(host)` 报 "Cannot read properties of undefined"）。
`tools/bench-tokens.mjs` 里已修好并留了注释。

### 2.9 真实会话日志里"屏蔽有没有生效"的读法

`node tools/audit-session.mjs --tools` 就是这一条的现成实现（这一轮加的）：逐个会话打印每条
`request/header` 的工具表、`reason` 字段、以及一行判定（`native write/edit: PRESENT (...)` / `masked`，
外加本插件工具在不在），最后给一行汇总。判断标准只有这一个——`header.tools[].name`。

README 的"能不能还测原生"那一节也依赖这条：**对照组要换一个组合**（另一个 preset 的会话），
不能靠"同一个 preset 里没被通知到的兄弟 agent"——那个 agent 现在也会被巡查收窄（这是有意的）。

### 2.10 对抗性评审（这一轮做的一遍，结论与修法）

修完之后请一轮独立的对抗性评审（只读、不改文件、读的是 0.1.5-rc.2 的安装源码），它按"能不能实证"给出了
10 条。**没有一条是"设计错了"**：三条通路本身被判为正确，子 agent / 恢复会话 / 逃生口不绕策略这几类
它明确写了"没找到问题"。下面按处理结果记账。

| 编号 | 它说的问题 | 处理 |
|---|---|---|
| F1 | 别人的守卫**抢答**（`guardReason` 先看全局层、再取作用域链上第一个非空答复）⇒ 答复不是哨兵 ⇒ 被当成 `outsider` ⇒ 巡查**撤销**一条真成员的收窄 | **已修**：答复不是哨兵但也不是 `undefined` 时判 `unknown`（`membership()`），只在确定 `outsider` 时撤销 |
| F2 | 判据依赖 `guardReason`，而它**不在** `dsh-tools` 的公开表面里（`dsh-tool-cordis` 列出的表面没有它），未来改名/移除就是"永远 `unknown` 且没有任何日志" | **已修**：判据不可用时记一条 `warnOnce`（点名"换 preset / 换出去还原不再生效"），文件头也写明这是实现方法而非公开接口 |
| F3 | 那些注册挂在 **agent 的 fiber** 上，本行卸载（HMR / `disabled: true`）不会带走它们，于是留下没人能撤的屏蔽 | **已修**：`installs` 改成可枚举的 `Map` + 一个行级 `ctx.effect` 卸载钩子；`agent/disposed` 时把账摘掉（不让强引用变泄漏） |
| F4 | 收窄会同步发 `tools/change` ⇒ 嵌套巡查，N 个 agent 同时加入就是 O(N²) | **已修**：巡查加重入闸门 + "跑完再跑一次"的待办位 |
| F5 | `masked.add()` 在 try 之前、失败也记账 ⇒ **一次瞬时失败永久生效**（正是这一轮修掉的 bug 的形状） | **已修**：幂等判据改成 `installs.has(agent)`，且**只有真的装上东西才记账**（什么都没装上就留给下一次巡查重试） |
| F6 | `registerEscape()` 可能返回 `undefined` 却被当作撤销句柄 push | **已修**（今天不可达，但一行的事） |
| F7 | 文件头声称"看不见的名字走不到守卫"——**是错的**：`guardReason()` 跑在"工具存不存在"之前 | **已修**：探测改用**对象身份**（只有本模块铸出来的探测对象才得到哨兵），注释也改了。这条是评审里最有价值的一条 |
| F8 | guard 档其实也遮蔽了那两段引导，而文档说"schema 与引导的钱照付" | **改文档**（保留行为：调用都被拒了，留着引导只会让模型去试）。`lib/mask.mjs` 头、`scripts/install-preset.mjs`、两份 README 都改了 |
| F9 | 宿主平面安装但没写 `scope: 'global'` ⇒ 守卫落在全局层，而"收窄"会连别的 preset 一起改 | **已修**：用不带 agent 的探测认出"守卫在全局层"（只有全局层的守卫会回答），自动退化成"只管守卫"并记一条点名修法的 warn |
| F10 | 同一个 preset 的两代常驻组合共享哨兵，第二代把第一代的成员认成自己的 ⇒ 重复注册同名段 ⇒ 每个 agent 一条 warn（**无功能损失**，撤销/重进仍然对称） | **接受现状、记在这里**：触发条件是"改组合文件又不重启"，代价只是警告噪音；修它要么把账本提到模块级（跨代/跨测试互相干扰），要么放宽 section 冲突，两个都比问题本身重 |

评审另外点出的一条文档错误已经改掉：`agent/created` 是由 agent 注册表（`dsh-agent`）发出的事件，所以
"宿主没有 `ctx.agents` 时靠监听器那条路"是错的——那种组合里只有 `apply` 阶段的守卫兜底。

**它还抓到一个我们自己没测出来的真回归**：`installs` 记账挪到"装完再记"之后，`restrict()` 同步发出的
`tools/change` 会在账记上之前把嵌套巡查引回来，于是同一个 agent 被装两遍、第二遍的同名段抛错。
`probe-mask`（用真注册表、真 notify）当场把这条报了出来，而 `selftest` 的假世界那时还不会 notify。
现在两头都补上了：`lib/mask.mjs` 用 `installing` 集合立"正在装"的牌子（与 `dsh-tool-subagent` 同形），
假世界也会在注册时同步发 `tools/change`，并有两条断言钉住"不重复安装"与"闸门不许吃掉后续巡查"。

## 3. 设计思路（为什么是现在这样）

### 3.1 插件的定位与取舍

- **返回值只留一行统计**：成功是 `WROTE` + `replace@17 +1/-1`，失败是 `FAIL` + 原因。
  理由：结果会追加进历史并从此每轮重发，而调用方刚发过 `new_text`；回显改动内容是纯浪费。
- **成功不回显路径**：结果与调用一一绑定，`file_path` 就在同轮的参数里；回显等于重复付费。
  （失败原因**允许**出现路径，它要指名文件。）
- **锚点三选一**（`old_text` / `grep` / `lines`）+ `count` 声明期望命中数：
  目的是让"改哪里"能用**索引**表达，而不是把旧文本抄一遍。实测：块重写省 44%、重复块里改一行省 26%。
- **宽松匹配**：精确失败时按"行尾空白 / 行块相似度"回退，并在结果里加一行 `[warn]`。
  这一条对着的是真实失败模式：抄回来的锚点差一个尾随空格 → 原生报 `FS_EDIT_NOT_FOUND`
  → 只能再读一次文件（读结果的 token 是大头）。实测该场景省 79%。
- **字节保真**：保 BOM 与文件自身行尾 —— 这是插件的立身之本，也是上游至今没修的两条（§2.3）。

### 3.2 mask 的设计与它失效的假设（这一轮修的就是它）

当初把门禁挂在 `agent/created` 是有理由的：`tools.restrict()` 只允许从**有作用域的上下文**调用，
而从 preset 的常驻作用域调会被拒（同一层注册的名字不是"可收窄的全局名"），只有 agent 自己的 `ctx`
才行。于是"每个 agent 创建时收窄一次"看起来是最自然的时机。

**失效的假设**是："agent 一定是在 preset 挂好之后才创建的"。
真实 GUI 流程是"先按默认 preset 建 agent，再把用户选的 preset 重新挂上去"（§2.1），
而重新挂载是 relink 而非重建 —— 监听器错过了唯一一次事件。
`probe-mask.mjs` 因为手工投递事件，恰好绕过了这个前提，所以从来没报警（这一轮已经把它改成真注册表）。

**修好之后的形状**是"三个触发点 + 一个归属判据 + 成对撤销"：

| 部件 | 解决什么 | 不解决什么 |
|---|---|---|
| `apply` 阶段的守卫 | 与创建顺序无关，最迟在第一次原生调用时否决；顺手收窄，下一次请求就干净 | 它只保证"调不动"，管不了工具表 |
| `agent/created` | 建档后才加入的 agent 立刻收窄 | 换 preset 的 agent（事件早发完了） |
| `tools/change` 巡查 | 换 preset（以及换出去）那一刻就收窄 / 还原 | 没有 `agents` 注册表的自建组合 |
| 守卫探测归属 | 只认"本层在这个 agent 的作用域链上"，不需要 import `dsh-scope` | 依赖 `guardReason` 的语义（公开方法，dsh-tools 自己也在用） |

代价与边界：多了一个常驻守卫（每次工具调用都会过一遍，非 deny 名字立即返回）、每次 `tools/change`
会枚举一次活 agent（便宜、幂等），以及"撤销"必须成对，否则换出去会把 agent 卡成没有任何写工具（§2.1 第 4 条）。

### 3.3 三条路线的对比

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. 修 mask（**已做完**） | 守卫 + `tools/change` 巡查 + 就近收窄 + 成对撤销 | 代码量最小，保留上游 `read`（含 `read_image`、GUI 卡片、观察事件） | 仍依赖上游事件/限制语义，新版再改还得跟 |
| B. 不挂 `dsh-tool-fs`，自带 `read` | preset 里把那行换掉，自己实现 `read` | 屏蔽问题从根上消失（工具不存在，不是藏起来） | 要接手上游 `read` 的语义面（窗口/截断/footer/错误码/呈现 meta/`read_image`），估约 450 行 |
| C. 换 `str_replace_editor` | preset 里挂 `@deepseek-ai/dsh-tool-str-replace-editor`（一个工具含 `view`/`create`/`str_replace`/`insert`） | 上游现成，一个 schema | 要求 `old_str` EXACT 匹配；走 `ctx.fs`，BOM/行尾两个缺陷一样继承；和本插件差异化全丢 |

A 已经落地并且有四段回归（`repro-mask`）；B 只有在"必须零原生 schema 且不依赖任何 mask 机制"时才值得，
而且要做就得先做 §3.5 的对拍。

### 3.4 跑分工具的方法学（`tools/bench-tokens.mjs`）

- **真栈，不 mock**：真 cordis `Context` + 真 `dsh-tools` / `dsh-system-prompt` / `dsh-fs-local` /
  `dsh-tool-fs` / 本插件，然后 `ctx.tools.execute()` —— 返回的就是会进会话日志的那份结果。
- **两侧都真跑**：每个候选写法都在各自目录里执行，读回文件校验最终内容，**只有真跑通且内容正确的写法才参与取优**。
- **每侧取自己的最优**：原生可选项是插件可选项的子集（插件的 `old_text` 与原生 `old_string` 等价，
  宽松匹配只会让它更短；`lines` / `grep` 是额外两条路），所以这不是拿模型的失误当论点。
- **共享的 `read` 单列**：两侧参数相同的步骤单独计价、不计入 Δ，Δ 只反映工具设计差异。
- **计价器**：`@deepseek-ai/dsh-token-meter` 的 `estimateContent`（`ceil(chars/4)` + 每块 4 token），
  与 GUI 的上下文压力条同一把尺子。
- **边界**（读结论时要记住）：`chars/4` 是启发式；会话聚合用的是文档里写死的一个"典型构成"；
  真实日志里混有本插件**早期版本**回显 diff 的结果（脚本按形状分类，只拿当前形状与原生对照）。

### 3.5 如果将来要走 B 路线：先立对拍

把"重写 read"变成"**可验证的移植**"：写一个 `tools/diff-read.mjs`，同一份语料（普通/空/无尾换行/CRLF/BOM/
超长单行/二进制/不存在/偏移越界/大于流式阈值）× 同一批参数，把上游 `read` 与自研 `read` 的
`execute → render` 输出**逐字节对拍**。它既是"要抄多少"的答案，也是上游升级时的护栏。
顺带一个上游没有的机会：上游 `read` 会把 BOM 吃掉（§2.3），自研版可以顺手把它显示出来，与"字节保真"一致。

## 4. 未完成的工作（按优先级）

### P0 —— 修 mask（**已完成**，留档说明做了什么）

1. 复现：`tools/repro-mask.mjs`（真 `AgentPresets` + 真注册表），修之前 12/19，修之后 23/23（后来补了"换出去""子 agent 加入""宿主里还有别人的守卫"三段）。
2. `lib/mask.mjs` 三条一起上了：`apply` 阶段挂守卫、`agent/created`、`tools/change` 巡查；
   外加**换出去时成对撤销**（原计划里没有，是实现时发现的坑：不撤销会把 agent 卡成没有任何写工具）。
3. 空段遮蔽保留并注明冗余（§2.7）。
4. 回归：`probe-mask` / `repro-mask` / `selftest` / `bench-tokens --assert` 全绿。

**唯一还欠的一步**：在重启后的宿主上跑一次真实验收（§7 开头那三条命令）。

### P1 —— 收尾跑分产物

- `tools/bench-tokens.mjs --md BENCHMARK.md` 生成报告并把结论写进 README 的相应章节。
- `package.json` 的 `scripts` 里接线（如 `bench` / `bench:logs` / `bench:assert`），并让 `npm test` 保持"不带 dsh 也能跑"。
  （`probe:mask` / `repro:mask` 已经接好；这两个不进 `npm test`，因为没有 dsh 包时它们退出码 2。）

### P2 —— 决策项

- ~~`escape` 去留~~：**已决定去掉**（用户选择最省的 700 tok/请求），preset 已重生成，mask 行不再带 config。
  想找回对照通道：`node scripts/install-preset.mjs --mask-native --escape --force`（多 493 tok/请求）。
- 发布：`package.json` 已是 `1.2.0`（registry 上最新是 `1.1.2`）；发布前重跑 `npm test`。
  发布内容包含这一轮的 `lib/mask.mjs`；`tools/` 与 `scripts/` 不在白名单里。

### P3 —— 选做

- B 路线（自带 `read`，§3.3 / §3.5）；或 C 路线（换 `str_replace_editor`）作为对照。

### P4 —— 未决问题

- **许可证是否从 Apache-2.0 改成 MIT**：从结论上说**可以**（版权人是自己，已发布的 `1.0.0`～`1.1.2`
  对已获得者仍按 Apache-2.0 生效，后续版本可改）；但**照搬上游 MIT 代码并不需要先改**（MIT 兼容 Apache-2.0，
  保留上游声明即可）。真要改，动四处：`LICENSE`、`package.json` 的 `license`、两个 README 的 License 段、
  以及 `tools/check-license.mjs` 里针对"零依赖 + Apache-2.0"的断言。

## 5. 交接操作手册

### 5.1 环境与路径

| 变量 / 路径 | 含义 |
|---|---|
| `$env:DSH_HOME` | dsh 的家目录（本机已设置；`sessions/`、`.agent-presets/`、`profiles/` 都在它下面） |
| `<DSH_HOME>/profiles/node_modules/@deepseek-ai` | profile 装的 dsh 包（0.1.5-rc.2），`tools/*` 脚本的默认查找位置 |
| `<DSH_HOME>/.agent-presets/texteditor` | 唯一的用户 preset（生成物，可随时用脚本重生成） |
| `<DSH_HOME>/settings.yaml` | 里面有 `agent-presets.default: texteditor`（默认 preset 是谁，看这里） |
| `<DSH_HOME>/sessions/<工作区>/session-*/session.jsonl.zstd` | 会话日志（分帧 zstd） |
| `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` | 全局 dsh CLI |
| 本仓库根目录 | `lib/`、`preset/`、`scripts/`、`tools/` 的所在；所有命令都在这里跑 |

脚本找 dsh 包的顺序都支持覆盖：`DSH_PACKAGES_ROOT`（`probe-mask` / `repro-mask` / `bench-tokens`）、
`DSH_PRESET_SOURCE` 或 `--from`（`install-preset`）、`DSH_TOOL_FS_ENTRY` / `DSH_TOOLS_ENTRY`（测量脚本）。

### 5.2 常用命令

```powershell
# 闸门与自测（不需要 dsh）
node tools/selftest.mjs
node tools/check-license.mjs

# 需要 dsh 的验证
node tools/probe-mask.mjs                    # 注册表语义；找不到包退出码 2
node tools/repro-mask.mjs                    # 组合时序（真 AgentPresets）；找不到包退出码 2
node tools/gen-schema.mjs                    # 内嵌 schema 是否仍与 DSL 一致
node tools/measure-context.mjs --static --vs-native   # 静态开销 + 原生那一侧的对照（0.1.5-rc.2 上已修好）
node tools/bench-tokens.mjs --assert         # token 对照跑分（可加 --logs 扫真实会话）

# 真实会话：屏蔽到底有没有生效
node tools/audit-session.mjs --tools         # 每个会话的 request/header 工具表 + 判定行

# preset 的生成 / 预览 / 回滚（当前形态：屏蔽、不带 escape）
node scripts/install-preset.mjs --mask-native --dry-run
node scripts/install-preset.mjs --mask-native --force
node scripts/install-preset.mjs --mask-native --escape --force   # 想要 native_edit / native_write 时
#   回滚：删掉 <DSH_HOME>/.agent-presets/texteditor，或给 tool-text-editor 行加 disabled: true
```

preset 是**会话创建时的事实**：改完必须重启 `dsh web`，然后**新建**会话才会生效，
已经开着的会话切不过去。**同理，改了 `lib/mask.mjs` 也必须重启宿主**——运行中的进程握着挂载时
加载的那份模块实例。

### 5.3 怎么读真实会话日志

文件是分帧 zstd（边跑边追加），Node 的 `zstdDecompressSync` 只解第一帧，要按魔数 `28 b5 2f fd` 切帧再拼。
仓库里已经有现成实现：

- `tools/audit-session.mjs` —— 逐调用对账（形状、是否回显路径、是否超上限），带 `decodeFrames()` 可抄；
  **`--tools` 直接给你要看的那件事**（每条 `request/header` 的工具表 + 判定行），不用自己解帧；
- `tools/bench-tokens.mjs` 的 `--logs` 段 —— 同一套切帧 + 按形状分类（当前形状 vs 早期版本）。

关心的两个事件：`request/header`（`data.header.tools[].name` 就是那一轮真实下发的工具表，**判断屏蔽是否生效看它**；
旁边还有 `data.reason`，`initial` 表示第一轮）与 `session` 事件的 `agentPreset` /
`agent-preset/selected` 事件（判断这个会话到底用的是哪个 preset）。

### 5.4 已知坑清单

1. **`agent/created` 只发一次**，且 `announce()` 二次调用会抛 —— 任何"在创建时做一次"的设计都要先问
   "这个 agent 会不会是先创建、后被重新组合的"。`recompose()` 是父级 re-link，不是重建。
2. **`tools.restrict()` 只能在有作用域的上下文调**（`agent.ctx`）；preset 常驻作用域调会被拒
   （preset 的所有行共享同一层，见 §2.1）。
3. **`agent.ctx.tools` 需要作用域是从"声明了 inject 的上下文"铸出来的**，否则抛
   `cannot get property "tools" without inject`，门禁会静默失败（§2.1）。
4. **收窄写在 agent 自己的层上，不会自动随 preset 更换消失**：换出去的 agent 必须被成对撤销，
   否则它在原生组合里一个写工具都没有（§2.1 第 4 条）。
5. **npm 预发布范围**：每验证一条新 rc 线要在 peer 里加一个子句（§2.6）。
6. **`@deepseek-ai/*` 子包的 `latest` dist-tag 是坏的**（指向很老的 `0.0.1-rc.1`），
   装的时候必须带版本号，或直接连 CLI 一起装（`npm i -g @deepseek-ai/dsh@0.1.5-rc.2`）。
7. **自带 preset 的位置随版本搬过家**：≤ 0.1.0-rc.6 在 `@deepseek-ai/dsh/config/agent-presets/`，
   ≥ 0.1.5-rc.2 在 `@deepseek-ai/dsh-agent-presets/presets/`。
8. **沙箱组合要先挂 `sessionProjections`**（§2.8），否则整条链静默不落地。
9. **本仓库行尾约定**：`.gitattributes` 规定全仓库 LF、无 BOM，`check-license` 会断言；
   文档里中英混排要留空格，同一行也不要同时出现 `dsh` 与上游那一份许可证名（会被判成署名错误）。
10. **profile 层安装 = 共存**：宿主平面插不进"移除原生"这回事，那种会话会同时有原生与插件（静态 +542 tok/请求）。
    只有 preset 能真正换掉组合。宿主平面安装**必须写 `scope: 'global'`**；忘了写时本行会自己探测出来并
    退化成"只管守卫"（记一条 warn），因为那一档的"收窄"会连没有本插件的 preset 一起改。
11. **注册会同步 notify**：`restrict()` / `section()` 落地时会同步发 `tools/change`，而门禁自己就在听这个
    事件——所以"先记账还是先注册"的顺序是有后果的（§2.10 那条真回归）。任何"在事件回调里注册东西"的设计
    都要先问一句"这个注册会不会把同一个回调再引回来"。
12. **改了 `lib/mask.mjs` 或 preset，都要重启 `dsh web`**：运行中的进程握着挂载时加载的模块实例与
    当时的 preset 世代（loader 不做模块缓存绕过，`internal.import` 按 URL 命中 Node 的缓存），
    新建会话才会走到新代码。

## 6. 文件地图

```
lib/core.mjs                 编辑内核：BOM/行尾、锚点解析、匹配、备份、台账、原子写、hunk 投影
lib/editor.mjs               插件面：两个工具的 schema、校验、注册、diff 卡片、只读镜像
lib/mask.mjs                 可选行：按 agent 收窄原生 write/edit（守卫 + 两条事件通路 + 成对撤销）
preset/preset.yml            preset 元数据（描述由安装脚本按模式补状态句）
scripts/install-preset.mjs   从本机自带 preset 生成用户 preset（含 --mask-native / --escape）
cordis.patch.yml             profile（宿主平面）安装用的 bundle patch
tools/selftest.mjs           端到端自测（167 项，不需要 dsh；含门禁的三条通路与撤销）
tools/probe-mask.mjs         门禁语义探针（23 项，需要 dsh；真注册表 + 真作用域上下文）
tools/repro-mask.mjs         组合时序复现（23 项，需要 dsh；真 AgentPresets：挂载 / 换 preset / 换出去 / 子 agent / 别人的守卫）
tools/measure-context.mjs    单次调用进入上下文的字节数 + 静态开销
tools/bench-tokens.mjs       token 对照跑分（静态 / 12 个场景 / 会话聚合 / 真实日志）
tools/audit-session.mjs      真实会话日志对账（形状、路径回显、上限；`--tools` 看每轮工具表）
tools/gen-schema.mjs         内嵌 schema 的权威来源与一致性检查
tools/check-license.mjs      许可证 / 依赖 / 行尾 / 文档风格闸门
```

## 7. 交接时的口径（给下一个接手的人）

- 一句话：**"屏蔽原生"这一步已经修好了**（§2.1），四条组合路径都有回归（`repro-mask`）；
  上游 0.1.5-rc.2 提供的 `tools/change` 钩子已经被用上，没有照搬上游代码。
- **还欠一次真实验收**（因为重启宿主得由人来点）：

  ```powershell
  node tools/check-license.mjs                 # 30/30
  node tools/selftest.mjs                      # 167/167
  node tools/probe-mask.mjs; node tools/repro-mask.mjs   # 23/23、23/23
  # 然后：重启 dsh web → 新建一个会话（走 GUI 的"先建后换"路径）→
  node tools/audit-session.mjs --tools
  #   期望：新会话的**第一条** request/header 就已经是 masked，
  #   而不再是"25 条带原生工具 vs 3 条收窄"那个分布（§2.1）。
  #   修复前的基线：88 个会话日志里 25 条 header 同时带原生工具与本插件工具。
  ```

- 判断屏蔽是否生效的标准只有一个：**会话日志里 `request/header` 的工具表**（`--tools` 就是它）。
  脚本全绿不等于线上生效——`probe-mask` 全绿的那一版曾经整整一轮都没生效。
- 结论里的每个数字都标注了来源（哪个脚本、哪个事件、哪个文件行）；改代码前先跑一遍对应脚本，
  用同一把尺子复现，再动手。
