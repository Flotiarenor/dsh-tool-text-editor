# 结算与交接 —— dsh-tool-text-editor

> 这是**开发交接件**，不是发布件：`package.json` 的 `files` 白名单没有它，它不会进 npm。
> 目的：让下一个接手的人（或下一个会话）不用重读整个对话，就能知道**结论、证据、坑与下一步**。
> 写作约定：路径用变量（`$env:DSH_HOME`、`%APPDATA%`）或相对路径，不写死的机器路径 —— 这条同时受
> `tools/check-license.mjs` 的"无机器专属绝对路径"断言保护。

## 0. 一眼看现状（TL;DR）

| 项目 | 状态 |
|---|---|
| 插件本体 `lib/` | 可用；`edit_text` / `write_text` 语义与返回形状未变 |
| 自测与闸门 | 全绿：`selftest` 136/136、`check-license` 30/30、`probe-mask` 20/20、`bench-tokens --assert` 16/16 |
| 本机 dsh | **0.1.5-rc.2**（CLI 与 profile 同步升级，cordis 4.0.2） |
| preset | `<DSH_HOME>/.agent-presets/` 只剩 `texteditor`，已用新版自带 `standard` 重新生成 |
| **最大的未修 bug** | `lib/mask.mjs` 的屏蔽在 GUI 真实流程里**不生效**（9 个真实会话里 8 个没生效），根因已定位（§2.1） |
| 修复所需的上游钩子 | 已在 0.1.5-rc.2 出现（§2.2），所以**不需要**照搬上游代码 |
| 下一步第一件事 | 给 mask 写"真实组合下必然失败"的复现，再改 `lib/mask.mjs`（§4 P0） |

## 1. 最近一轮做了什么

### 1.1 仓库改动

| 文件 | 改动 | 原因 |
|---|---|---|
| `scripts/install-preset.mjs` | 自带 preset 的路径改成**按布局枚举**（旧 `dsh/config/agent-presets` + 新 `dsh-agent-presets/presets`） | 0.1.5-rc.2 把自带组合搬进了另一个包，旧路径已不存在，重跑脚本必然 FAIL |
| `scripts/install-preset.mjs` | 新增 `--escape` | `lib/mask.mjs` 早就支持 `escape: true`，但安装脚本复现不出来；已装的那份是手改/旧脚本产物，重跑就会丢 |
| `scripts/install-preset.mjs` | 写出的 `preset.yml` 描述按 `--mask-native` / `--escape` 生成 | 旧逻辑无条件拷贝 `preset/preset.yml`，于是开着门禁的 preset 描述里也写着"原生 edit/write 保持不变" |
| `preset/preset.yml` | 去掉结尾那句状态话（改由脚本追加） | 同上 |
| `package.json` | `peerDependencies`：`>=0.1.0-rc.6` → `>=0.1.0-rc.6 \|\| >=0.1.5-rc.2` | 旧写法在 npm 的预发布规则下**匹配不上 0.1.5-rc.2**（§2.6） |
| `README.md` | 解释上面那个 peer 范围为什么是两段 | 免得被当成笔误 |
| `tools/bench-tokens.mjs` | **新增**（约 1500 行） | token 消耗对照跑分，见 §3.4 |

`tools/` 与 `scripts/` 都不在发布白名单里，所以以上改动不影响 npm 包内容。

### 1.2 本机环境改动（不在 git 里）

- 删除 `<DSH_HOME>/.agent-presets/` 下的 `test`、`test1`、`winminmal`（当时图方便随手生成的参考副本，用户要求清掉）。
- 重新生成 `texteditor`：从新版自带 `standard` 注入插件段。**验证方式**：把生成文件里的插件段（从形如 `# ── 字节保真…` 的标题注释起，到 `# ── background jobs` 那段标题之前）剪掉后，与自带 `standard` **逐字节相同** —— 这同时证明 persona 那类挂载失败不会再出现。
- 用户自己完成的：dsh 升到 0.1.5-rc.2；profile 里移除了 `@linxin666/dsh-web-ui-all`（它此前导致了不少问题）。

### 1.3 验证记录（都在 0.1.5-rc.2 上）

```powershell
node tools/selftest.mjs            # 136/136
node tools/check-license.mjs       # 30/30
node tools/probe-mask.mjs          # 20/20（真实 dsh 包）
node tools/bench-tokens.mjs --assert   # 16/16，数字与 0.1.0-rc.6 上完全一致
```

`probe-mask` 全绿**不代表**屏蔽在真实流程里生效：它手工把 `agent/created` 事件递给监听器，
验的是"监听器被调用之后注册表语义对不对"，从来没有验过"这个事件会不会被投递"（§2.1）。

## 2. 关键结论与证据

### 2.1 屏蔽为什么不生效（已定位）

**机制**：`lib/mask.mjs` 的全部 deny 动作（`restrict()` + 空段遮蔽引导）只在 `maskAgent()` 里做，
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

**真实会话数据**（同一工作区的 9 个会话）：8 个的 `request/header` 里原生 `write`/`edit` 仍在；
唯一被屏蔽的那个也不是从一开始生效，而是**第 2 次** `request/header`（约 35 分钟后）才变成收窄后的工具表。

**怎么自己复核**：会话日志是分帧 zstd，读法见 §5.3；看 `request/header` 事件里的 `header.tools` 名字集合，
以及 `session` 事件的 `agentPreset` 与 `agent-preset/selected` 事件的时间先后。

### 2.2 新版给了修复钩子（这是"不用照搬上游"的关键）

0.1.5-rc.2 的 `AgentPresets.recompose()` 在重新绑定作用域之后新增：

```js
try { this.ctx.emit('tools/change') } catch (error) { /* 记 warn */ }
```

这正是 GUI 换 preset 的路径。它**不带 agent 参数**，所以修复要自己枚举活 agent，再对每个 `agent.ctx` 收窄。
旧版（0.1.0-rc.6）的 `recompose()` 没有任何 emit，这也是为什么"先升级再修"是更省的那条路。

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
2. 挂上再**运行时收窄**（就是现在的 mask），代价是依赖 `restrict` 的时序 —— 也就是 §2.1 那个坑。

### 2.5 token 账（`node tools/bench-tokens.mjs`）

| 组合 | 静态开销 |
|---|---|
| 原生 `read` + `write` + `edit`（沙箱后端） | **773 tok/请求** |
| 插件 + 屏蔽原生（`guidance: short`，无 `escape`） | **700 tok/请求**（省 73） |
| 插件 + 屏蔽原生 + `escape`（当前 preset） | **1193 tok/请求**（比原生多 420） |
| 原生 + 插件共存（profile 层安装时的形态） | **1315 tok/请求** |

动态账：单次调用省 27～260 tok（看场景），失败重试场景最省（原生要"报错 → 再读一次文件 → 重试"）；
真实会话日志的可比子集里，原生 505.5 tok/次 vs 插件 310.2 tok/次。
一个典型构成的会话总量：原生 60984 vs 插件 51975（含两侧相同的共享 `read`），省 18%。

### 2.6 npm peer 的预发布陷阱（实测）

| range | 0.1.0-rc.6 | 0.1.5-rc.2 | 0.1.5 | 0.2.0 |
|---|---|---|---|---|
| `>=0.1.0-rc.6`（旧写法） | 命中 | **不命中** | 命中 | 命中 |
| `^0.1.0-rc.6` | 命中 | **不命中** | 命中 | 不命中 |
| `*` | 不命中 | 不命中 | 命中 | 命中 |
| `>=0.1.0-rc.6 \|\| >=0.1.5-rc.2`（现写法） | 命中 | 命中 | 命中 | 命中 |

规则：带 prerelease 的版本，只有当 range 里存在**同一 `major.minor.patch` 元组**且自身带 prerelease 的
比较符时才算满足。所以每验证一条新的 rc 线就要加一个子句 —— 上游那些包是靠"每次发版同步抬 peer"绕开的。

### 2.7 新版引导段按可见性求值（mask 的冗余部分）

0.1.5-rc.2 的 `dsh-tool-fs` 把工具引导段写成函数并查可见性：

```js
text: ({ scope }) => ctx.tools.get("write", scope) === void 0 ? "" : "Use the write tool ..."
```

含义：**只要工具被收窄，那段引导就自动不下发**了。所以 mask 里"注册同名空段"那套现在是冗余的
（数字上也验证了：只挂 `read` 的组合，引导从 772 B 掉到 160 B）。

### 2.8 沙箱链新增前置（会打断自建 harness）

0.1.5-rc.2 的 `SandboxPolicyService` 变成 `static inject = ['sessionProjections']`，并且改用
`ctx.sessionProjections.stateOf(session, 'sandboxMode')`。自建组合如果不先挂投影登记表，
策略行不会落地 → 沙箱版 fs 的 `inject: ['sandboxPolicy']` 解析不了 → `ctx.fs` 根本不存在
（症状是后面某个 `createScope(host)` 报 "Cannot read properties of undefined"）。
`tools/bench-tokens.mjs` 里已修好并留了注释。

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

### 3.2 mask 的设计与它失效的假设

当初把门禁挂在 `agent/created` 是有理由的：`tools.restrict()` 只允许从**有作用域的上下文**调用，
而从 preset 的常驻作用域调会被拒（同一层注册的名字不是"可收窄的全局名"），只有 agent 自己的 `ctx`
才行。于是"每个 agent 创建时收窄一次"看起来是最自然的时机。

**失效的假设**是："agent 一定是在 preset 挂好之后才创建的"。
真实 GUI 流程是"先按默认 preset 建 agent，再把用户选的 preset 重新挂上去"（§2.1），
而重新挂载是 relink 而非重建 —— 监听器错过了唯一一次事件。
`probe-mask.mjs` 因为手工投递事件，恰好绕过了这个前提，所以从来没报警。

### 3.3 三条路线的对比

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. 修 mask | 用 `tools/change` + 首次执行兜底，从 `exec.agent.ctx` 补 `restrict` | 代码量最小，保留上游 `read`（含 `read_image`、GUI 卡片、观察事件） | 仍依赖上游事件/限制语义，新版再改还得跟 |
| B. 不挂 `dsh-tool-fs`，自带 `read` | preset 里把那行换掉，自己实现 `read` | 屏蔽问题从根上消失（工具不存在，不是藏起来） | 要接手上游 `read` 的语义面（窗口/截断/footer/错误码/呈现 meta/`read_image`），估约 450 行 |
| C. 换 `str_replace_editor` | preset 里挂 `@deepseek-ai/dsh-tool-str-replace-editor`（一个工具含 `view`/`create`/`str_replace`/`insert`） | 上游现成，一个 schema | 要求 `old_str` EXACT 匹配；走 `ctx.fs`，BOM/行尾两个缺陷一样继承；和本插件差异化全丢 |

**当前建议仍是 A**，因为 0.1.5-rc.2 已经把 A 缺的那个钩子补上了（§2.2）；
B 只有在"必须零原生 schema 且不依赖任何 mask 机制"时才值得，而且要做就得先做 §3.5 的对拍。

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

### P0 —— 修 mask（下一件事）

1. **先写复现**：用真实组合驱动（`AgentPresets.mount` / `recompose` + 真实 agents 注册表），
   断言"创建路径"和"换 preset 路径"都应收窄工具表。今天必然是**失败**的 —— 这就是修复的验收标准。
   （`probe-mask.mjs` 的手工投递不算证据，别再走那条路。）
2. **改 `lib/mask.mjs`**，建议三条一起上：
   - `deny` 档**同时**注册 `tools.guard(...)`（`apply` 阶段就挂，与 agent 创建顺序无关）→ 保证**调不动**；
   - 监听 `tools/change`（0.1.5-rc.2 的 recompose 会发）→ 枚举活 agent，对每个 `agent.ctx` 补 `restrict` → 工具表真的收窄；
   - 首次被守卫拦到时，用 `exec.agent.ctx` 就近补一次 `restrict`，让**下一次请求**就干净。
3. 顺带删掉已冗余的空段遮蔽（§2.7），或者保留但注明冗余。
4. 回归：`probe-mask` + `bench-tokens --assert` + 一个新会话的真实工具表。

### P1 —— 收尾跑分产物

- `tools/bench-tokens.mjs --md BENCHMARK.md` 生成报告并把结论写进 README 的相应章节。
- `package.json` 的 `scripts` 里接线（如 `bench` / `bench:logs` / `bench:assert`），并让 `npm test` 保持"不带 dsh 也能跑"。

### P2 —— 决策项

- `escape` 去留：当前 preset 是 `escape: true`（多 493 tok/请求，换来 `native_edit` / `native_write` 可对照）。
  重跑 `node scripts/install-preset.mjs --mask-native --force` 即可去掉。
- 发布：`package.json` 已是 `1.2.0`（registry 上最新是 `1.1.2`）；发布前重跑 `npm test`。

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
| `<DSH_HOME>/sessions/<工作区>/session-*/session.jsonl.zstd` | 会话日志（分帧 zstd） |
| `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` | 全局 dsh CLI |
| 本仓库根目录 | `lib/`、`preset/`、`scripts/`、`tools/` 的所在；所有命令都在这里跑 |

脚本找 dsh 包的顺序都支持覆盖：`DSH_PACKAGES_ROOT`（`probe-mask` / `bench-tokens`）、
`DSH_PRESET_SOURCE` 或 `--from`（`install-preset`）、`DSH_TOOL_FS_ENTRY` / `DSH_TOOLS_ENTRY`（测量脚本）。

### 5.2 常用命令

```powershell
# 闸门与自测（不需要 dsh）
node tools/selftest.mjs
node tools/check-license.mjs

# 需要 dsh 的验证
node tools/probe-mask.mjs                    # 真实注册表语义；找不到包退出码 2
node tools/gen-schema.mjs                    # 内嵌 schema 是否仍与 DSL 一致
node tools/measure-context.mjs --static --vs-native
node tools/bench-tokens.mjs --assert         # token 对照跑分（可加 --logs 扫真实会话）

# preset 的生成 / 预览 / 回滚
node scripts/install-preset.mjs --mask-native --escape --dry-run
node scripts/install-preset.mjs --mask-native --escape --force
#   回滚：删掉 <DSH_HOME>/.agent-presets/texteditor，或给 tool-text-editor 行加 disabled: true
```

preset 是**会话创建时的事实**：改完必须重启 `dsh web`，然后**新建**会话才会生效，
已经开着的会话切不过去。

### 5.3 怎么读真实会话日志

文件是分帧 zstd（边跑边追加），Node 的 `zstdDecompressSync` 只解第一帧，要按魔数 `28 b5 2f fd` 切帧再拼。
仓库里已经有现成实现：

- `tools/audit-session.mjs` —— 逐调用对账（形状、是否回显路径、是否超上限），带 `decodeFrames()` 可抄；
- `tools/bench-tokens.mjs` 的 `--logs` 段 —— 同一套切帧 + 按形状分类（当前形状 vs 早期版本）。

关心的两个事件：`request/header`（`data.header.tools[].name` 就是那一轮真实下发的工具表，**判断屏蔽是否生效看它**）
与 `session` 事件的 `agentPreset` / `agent-preset/selected` 事件（判断这个会话到底用的是哪个 preset）。

### 5.4 已知坑清单

1. **`agent/created` 只发一次**，且 `announce()` 二次调用会抛 —— 任何"在创建时做一次"的设计都要先问
   "这个 agent 会不会是先创建、后被重新组合的"。
2. **`tools.restrict()` 只能在有作用域的上下文调**（`agent.ctx`）；preset 常驻作用域调会被拒。
3. **npm 预发布范围**：每验证一条新 rc 线要在 peer 里加一个子句（§2.6）。
4. **`@deepseek-ai/*` 子包的 `latest` dist-tag 是坏的**（指向很老的 `0.0.1-rc.1`），
   装的时候必须带版本号，或直接连 CLI 一起装（`npm i -g @deepseek-ai/dsh@0.1.5-rc.2`）。
5. **自带 preset 的位置随版本搬过家**：≤ 0.1.0-rc.6 在 `@deepseek-ai/dsh/config/agent-presets/`，
   ≥ 0.1.5-rc.2 在 `@deepseek-ai/dsh-agent-presets/presets/`。
6. **沙箱组合要先挂 `sessionProjections`**（§2.8），否则整条链静默不落地。
7. **本仓库行尾约定**：`.gitattributes` 规定全仓库 LF、无 BOM，`check-license` 会断言；
   文档里中英混排要留空格，同一行也不要同时出现 `dsh` 与上游那一份许可证名（会被判成署名错误）。
8. **profile 层安装 = 共存**：宿主平面插不进"移除原生"这回事，那种会话会同时有原生与插件（静态 +542 tok/请求）。
   只有 preset 能真正换掉组合。

## 6. 文件地图

```
lib/core.mjs                 编辑内核：BOM/行尾、锚点解析、匹配、备份、台账、原子写、hunk 投影
lib/editor.mjs               插件面：两个工具的 schema、校验、注册、diff 卡片、只读镜像
lib/mask.mjs                 可选行：按 agent 收窄原生 write/edit（**当前有 bug，见 §2.1 / §4 P0**）
preset/preset.yml            preset 元数据（描述由安装脚本按模式补状态句）
scripts/install-preset.mjs   从本机自带 preset 生成用户 preset（含 --mask-native / --escape）
cordis.patch.yml             profile（宿主平面）安装用的 bundle patch
tools/selftest.mjs           端到端自测（136 项，不需要 dsh）
tools/probe-mask.mjs         门禁语义探针（20 项，需要 dsh；注意它手工投递事件）
tools/measure-context.mjs    单次调用进入上下文的字节数 + 静态开销
tools/bench-tokens.mjs       token 对照跑分（静态 / 12 个场景 / 会话聚合 / 真实日志）
tools/audit-session.mjs      真实会话日志对账（形状、路径回显、上限）
tools/gen-schema.mjs         内嵌 schema 的权威来源与一致性检查
tools/check-license.mjs      许可证 / 依赖 / 行尾 / 文档风格闸门
```

## 7. 交接时的口径（给下一个接手的人）

- 一句话：**插件本身没坏，坏的是"屏蔽原生"这一步**；上游 0.1.5-rc.2 已经补上了修复所需的钩子，
  所以优先修 mask，而不是照搬上游代码。
- 不要相信 `probe-mask` 的全绿就以为屏蔽生效了 —— 判断标准只有一个：**新会话的 `request/header` 工具表**。
- 结论里的每个数字都标注了来源（哪个脚本、哪个事件、哪个文件行）；改代码前先跑一遍对应脚本，
  用同一把尺子复现，再动手。
