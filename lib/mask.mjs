// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * mask.mjs —— dsh 插件行：把宿主的原生 `write` / `edit` 从这个 agent 的可见面里去掉。
 *
 * 为什么需要它：`edit_text` / `write_text` 修好的正是原生 `write` / `edit` 的三个缺陷（丢 UTF-8 BOM、
 * 把 CRLF 拍成 LF、`old_string` 差一个空格就报 FS_EDIT_NOT_FOUND）。但原生的那两个工具**仍然在工具
 * 表里**，于是每次请求都要付两份钱：
 *   * 两个 schema：`write` 728 B + `edit` 1026 B = 1754 B（`node tools/measure-context.mjs --vs-native` 实测）；
 *   * 两段引导：`tool:write` 220 B + `tool:edit` 388 B = 608 B；
 *   * 而我们自己的引导段还得花字节劝模型别用它们（`lib/editor.mjs` 的 GUIDANCE 有一半在讲这件事）。
 * 合计 2362 B/请求，全部是为了让模型**不去**碰那两个工具。
 *
 * 做法（三个通道，都作用在**每个 agent 自己的作用域**上）：
 *   * `tools.guard(...)` —— 调用被否决（`apply` 阶段就挂，见下）；
 *   * `agent.ctx.tools.restrict({ deny })` —— 注册表只有一套可见性解析器（`view(scope).visible`），
 *     schema 下发、名称查找与调用派发读的是同一张视图，所以被收窄的名字既**不出现在工具表里**，
 *     也**调不动**（直呼其名得到 `UNKNOWN_TOOL`）。不是"藏起来但还留着后门"。
 *   * `agent.ctx.systemPrompt.section({ name: 'tool:write', text: '' })` —— 在更近的层注册同名**空段**，
 *     遮蔽 `dsh-tool-fs` 注册的那两段引导（`ScopedLayers.merge` 近者胜，空段在渲染时被丢弃）。
 *
 * ## 为什么不能只在 `agent/created` 里做（这是本文件的历史坑）
 *
 * `restrict()` 只能从**带作用域的上下文**调用，而本行自己的上下文就是 preset 的常驻作用域——原生工具
 * 注册在**同一个层**里，"同一层注册的名字不算可收窄的全局名"，所以从本行调用必然抛错；只有 agent 自己
 * 的 `agent.ctx` 才行。于是最早的实现把收窄挂在 `agent/created` 上，前提是"agent 一定是在 preset 挂好
 * 之后才创建的"。**这个前提在 GUI 里不成立**：真实流程是"先按默认 preset 建 agent，再把用户选的 preset
 * 重新挂上去"，而 `AgentPresets.recompose()` 做的是**父级 re-link，不是重建 agent**（`bindScopeParent`
 * 的 rebind），`agent/created` 早就在旧组合下发完了，新挂上来的监听器永远收不到东西。实测：同一台机器
 * 88 个会话日志的 128 条 `request/header` 里，**25 条同时带着原生工具与本插件工具**（bug 现场），
 * 只有 3 条是收窄的（`node tools/audit-session.mjs --tools`）。
 *
 * 所以现在有三条通路，任何一条先到就先收窄：
 *   1. **`apply` 阶段就挂守卫**（挂在本行的作用域层上，与 agent 创建顺序无关）：被守卫拦到时顺手用
 *      `exec.agent.ctx` 补一次收窄，让**下一次请求**的工具表就是干净的。守卫是"最迟防线"，不是主路径。
 *   2. **`agent/created`**：建档时就加入本 preset 的 agent（含 subagent）立即收窄。注意这个事件是
 *      **agent 注册表**（`ctx.agents`）发的：宿主没有注册表的自建组合里它根本不会出现，那种情况下
 *      守卫那条路是唯一的兜底。
 *   3. **`tools/change`**：0.1.5-rc.2 的 `recompose()` 在重新绑定作用域之后会发它；此时枚举
 *      `ctx.agents.list()`，把**属于本组合**的 agent 收窄。这就是 GUI 换 preset 的那条路。
 *
 * ## 归属判据（"这个 agent 是不是加入了我这个常驻组合"）
 *
 * 不能靠 `dsh-scope` 的 `scopeOf` / `scopeChainOf`：本包"零依赖、只用 node: 内建"是
 * `tools/check-license.mjs` 的硬断言，而那个包只有 `@deepseek-ai/dsh-scope` 导出。等价的判据在
 * `dsh-tools` 自己的作用域解析里：`tools.guardReason(exec)` 会遍历 `chainLayers(exec.agent)`，也就是
 * **这个 agent 的作用域链上每一层**——本行的守卫只挂在本行的层上，所以"守卫被调用"当且仅当"本层在链上"。
 *
 * 探测的判据是**对象身份**，不是名字：只有本模块自己铸出来的那几个 exec 对象才会得到哨兵回复。这一点
 * 是必须的——`guardReason()` 在 `prepareExecution` 里跑在"工具存不存在"之前，**看不见的名字一样会走到
 * 守卫**（未注册的名字要到派发阶段才变成 `UNKNOWN_TOOL`），所以"起个没人用的名字"并不足以保证没人在
 * 真实调用里拿到哨兵。真实派发每次都会铸一个新的 exec 对象，因此它永远不可能等于我们的探测对象。
 *
 * 判据是三态：`member` / `outsider` / `unknown`。**只有明确答复才是答复**——
 *   * 别人的守卫先答了（`guardReason` 先看全局层，再按作用域链从远到近取第一个非空答复）⇒ `unknown`；
 *   * 判据本身不可用（守卫没挂上、这个 dsh 没有 `guardReason`、查询抛错）⇒ `unknown`，并记一条 warn。
 * 巡查只在 `outsider` 上撤销收窄：把"不知道"当成"不是我的人"会**静默放开**一个本来有效的屏蔽，
 * 那比不收窄更糟。代价是"换出去还原"这条也跟着降级（§离开组合也要还原），所以判据不可用时必须有日志。
 *
 * `guardReason` 不是 `dsh-tools` 公开接口的一部分（`dsh-tool-cordis` 列出的 ToolRuntime 表面是
 * register / restrict / guard / get / schemas / executionMode / execute / presentAs，没有它），
 * 它是实现方法、且被运行时自己用（`prepareExecution`）。所以这里按"可能消失"对待：消失就降级成
 * 只靠事件收窄，并且**大声说出来**（warn），而不是悄悄少做一半。
 *
 * ## 离开组合也要还原
 *
 * agent 换到别的 preset 时，本行在它作用域上注册的东西（`restrict` / 空段 / 逃生口）必须一起撤销：
 * 否则那个 agent 在新 preset 里既没有原生名字、也没有本插件的名字，等于**没有任何写工具**。所以每次
 * 巡查对"不再是本组合成员"的 agent 调一次 `unmaskAgent()`——这与 `dsh-tool-subagent` 的
 * `reconcileComposedAgents()`（成员 install、非成员 remove）是同一个形状。
 *
 * 同一条道理的另一半：这些注册挂在 **agent 的 fiber** 上，所以**本行自己被卸载**（HMR 重载、
 * 给 preset 行加 `disabled: true`）时它们不会跟着走。于是本行还注册了一个卸载钩子：行卸载时把手上
 * 所有 agent 的注册一并撤销——否则那一行撤了、屏蔽却留着，而已经没有任何实例能再把它撤掉。
 *
 * 两种模式：
 *   * `mode: 'deny'`（默认）—— 上面那套：看不见，也调不动。省下 2362 B/请求。
 *   * `mode: 'guard'` —— 工具**保持可见**，但调用被否决，拒绝原因里指向 `edit_text` / `write_text`。
 *     想留一条"原生工具还能被调用、只是被拒"的观察窗时用它：**schema 的钱照付**（两张表照旧下发），
 *     而那两段引导仍被空段遮蔽（调用都被拒了，留着引导只会让模型去试）。
 *
 * 两条作用域（`scope`）：
 *   * `scope: 'agent'`（默认，配合 `mode: 'deny'`）：看不见**也**调不动原生工具，省下 2362 B/请求。
 *     代价是屏蔽之后模型没有任何原生路径（另有逃生口，见下）。
 *   * `scope: 'agent'` + `escape: true`：仍然看不见原生**名字**，但被收窄的工具以 `native_edit` /
 *     `native_write` 回到本 agent 自己的作用域里（见 `registerEscape`）。这是"看不见但能调"唯一可行的
 *     形状——注册表的可见性与可调用性是同一个映射，唯有作用域自己的注册不被限制过滤。
 *   * `scope: 'global'`：挂在宿主平面（profile 层），对**所有** agent 与所有 preset 生效，**只做
 *     `mode: 'guard'` 那种"看得见、调不动"**（这一档不做收窄：本行没有"自己的组合"可收窄，而按 agent
 *     逐层收窄会连别的 preset 一起改）。省不下引导那 608 B，换来的是不必"新建会话时选对 preset"。
 *     宿主平面安装却忘了写 `scope: 'global'` 时，本行探测得出"守卫落在全局层"并自动退化成这一档，
 *     同时记一条 warn（比"悄悄把每个 agent 都收窄"安全：那会连没有本插件的 preset 一起改）。
 *
 * 有意为之的取舍：
 *   * **不是权限边界**。dsh 文档把 `restrict()` 定义为 live visibility composition：原生工具仍然注册在
 *     注册表里（GUI 的插件/工具清单可能照旧列出它们），shell 命令也一样能写文件。它保证的是"模型眼里
 *     只剩字节工具"，不是"文件受保护"。
 *   * **`scope: 'agent'` 只影响加入本行的 agent**。没有 preset 归属的 agent、以及其它 preset 的 agent
 *     不受影响——这正好留出对照组（例如另一个 preset 的新会话里原生工具照旧可用）。
 *   * 名字写死在默认表里而不是硬编码在流程里：`tool-fs` 改名/拆包时改 `config` 即可。
 *
 * 配置（本插件没有 Config schema，preset 行的 `config:` 字段原样透传）：
 *   mode: 'deny' | 'guard'        默认 deny
 *   scope: 'agent' | 'global'     默认 agent；global 只做 guard
 *   escape: boolean               默认 false；只对 `deny` + `scope:'agent'` 有意义，见上
 *   deny: string[]                默认 ['write','edit']；只对**本 agent 真的看得见**的名字生效
 *   sections: string[]            默认 ['tool:write','tool:edit']；空段遮蔽的引导段名，[] 关闭
 *
 * `sections` 现在是**冗余的保险**：0.1.5-rc.2 起 `dsh-tool-fs` 把引导段写成
 * `({ scope }) => ctx.tools.get('write', scope) === void 0 ? '' : '…'`，工具一旦被收窄，那段引导自己
 * 就不会下发（实测：只挂 `read` 的组合，引导从 772 B 掉到 160 B）。保留它是因为别的写工具行未必这么写，
 * 而空段本身不花 token。
 */

/** 默认要屏蔽的原生工具名，以及它们的引导段名。 */
const DEFAULT_DENY = ['write', 'edit']
const DEFAULT_SECTIONS = ['tool:write', 'tool:edit']
/** 遮蔽用的段顺序：与 `dsh-tool-fs` 注册时一致（按名字合并，顺序只影响可读性）。 */
const SECTION_ORDER = { 'tool:write': 101, 'tool:edit': 102 }
/** `mode: 'guard'` 时的拒绝原因：模型可见，只在真的被拒时产生，因此可以写清"改用哪个"。 */
const REFUSAL =
  '拒绝：原生 edit/write 会丢 UTF-8 BOM 并把 CRLF 拍成 LF。改用 edit_text 做局部替换、'
  + 'write_text 新建或整篇覆盖。'
/** `escape: true` 时逃生口的名字前缀：`edit` → `native_edit`。 */
const ESCAPE_PREFIX = 'native_'
/**
 * 归属探测用的假工具名与哨兵回复。
 *
 * 名字只是给人看的标签，**判据是对象身份**（见文件头）：守卫只回答本模块铸出来的探测对象，
 * 所以即便有人真的注册了一个同名工具，它的调用也拿不到哨兵。
 */
const PROBE_NAME = 'dsh-text-editor-mask-probe'
const PROBE_REPLY = 'dsh-text-editor-mask-probe:member'

/**
 * 只消费宿主服务。**必须声明**：cordis 只往声明了 `inject` 的上下文上提供这些服务，所以缺了它
 * `ctx.tools` 就是 undefined——守卫在 `apply` 阶段就注册、收窄要读工具表，两者都依赖这个服务。
 * `agents` 不在这里：它是**可选**的（没有 agent 注册表的组合里就没有 `agent/created`，那时守卫
 * 那条路兜底），所以用 `ctx.get('agents')` 现取而不是声明依赖。
 */
export const inject = ['tools', 'systemPrompt']

/**
 * 注册"屏蔽原生 edit/write"的门禁。
 * @param ctx - 插件上下文（preset 常驻作用域，宿主平面安装时是全局上下文）。
 * @param config - preset 行配置（见文件头）。
 */
export function apply(ctx, config) {
  const settings = config === undefined || config === null ? {} : config
  const mode = settings.mode === 'guard' ? 'guard' : 'deny'
  /** 配置里声明的作用域：`global` 档只做守卫（见文件头）。 */
  const globalScope = settings.scope === 'global'
  /** 逃生口只在 deny 档有意义：guard 档里原生名字本来就能调，只是被守卫否决。 */
  const escape = settings.escape === true && mode === 'deny' && !globalScope
  const deny = Array.isArray(settings.deny) ? settings.deny.filter((name) => typeof name === 'string' && name !== '') : DEFAULT_DENY
  const sections = Array.isArray(settings.sections)
    ? settings.sections.filter((name) => typeof name === 'string' && name !== '')
    : DEFAULT_SECTIONS

  /** 本行作用域上的服务对象：读工具表（`get(name, scope)`）与探测作用域链都走它，不依赖调用方。 */
  const tools = ctx.tools
  /** 守卫是否真的挂上了：没挂上时"归属判据"无从谈起，巡查只能按 `'unknown'` 处理。 */
  let guardArmed = false
  /**
   * 每个 agent 的撤销句柄（`restrict` / 空段 / 逃生口）。
   *
   * 用 Map 而不是 WeakMap：本行卸载时要能枚举出"手上还有谁"，好把注册一并撤销（见文件头）。
   * 强引用不会变成泄漏——agent 被销毁时 `agent/disposed` 会把条目摘掉，而 agent 自己的作用域
   * 消亡本就会让这些注册一起消散。
   */
  const installs = new Map()
  /** 正在安装的 agent：注册动作同步发 `tools/change`，嵌套巡查会为同一个 agent 再进来（见 maskAgent）。 */
  const installing = new WeakSet()
  /** 只报一次的诊断（判据不可用时必须说话，但不能每次巡查都说）。 */
  const reported = new Set()
  /** 巡查的重入闸门：收窄会同步发 `tools/change`，不拦就会一层层嵌下去。 */
  let sweeping = false
  let sweepingAgain = false

  /** 记一条警告：`ctx.logger` 在最小组合里可能不存在。 */
  function warn(message) {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // 日志失败不该反过来影响门禁本身。
    }
  }

  /** 同一件事只报一次。 */
  function warnOnce(key, message) {
    if (reported.has(key)) return
    reported.add(key)
    warn(message)
  }

  /**
   * 铸一个探测对象，并登记它的身份。
   *
   * 登记是必需的：`guardReason()` 会对**任何**名字调用守卫（看不见的名字也要到派发阶段才变成
   * `UNKNOWN_TOOL`），所以判据只能是"这个 exec 是不是我铸的"。对象本身很轻，登记在 WeakSet 上，
   * 用完即可回收。
   * @param agent - 要问"本层在不在你的作用域链上"的 agent；省略则只问"守卫在不在全局层"。
   * @returns 探测用的 exec 对象。
   */
  const probes = new WeakSet()
  function probeExec(agent) {
    const exec = agent === undefined ? { name: PROBE_NAME } : { name: PROBE_NAME, agent }
    probes.add(exec)
    return exec
  }

  /**
   * 把一个 agent 的可见面收窄，并留下撤销句柄。
   *
   * 幂等判据是 `installs` 有没有这个 agent；**只有真的注册成功才记账**——失败（哪怕只是一次瞬时
   * 失败）时留下空账会让它永久不被重试，而"屏蔽没做成"正是这一轮修掉的那个 bug 的形状。
   *
   * 全程 try/catch：这条路径可能跑在 `agent/created` 的同步派发里，也可能跑在工具调用的守卫阶段，
   * 抛出只会把 agent 创建或那次调用带崩——所以失败时记日志，绝不让它外溢。
   * @param agent - 已加入本组合的 agent（其 `ctx` 是它自己的作用域）。
   */
  function maskAgent(agent) {
    if (!narrowing || agent === null || typeof agent !== 'object' || installs.has(agent)) return
    /**
     * 必须再立一块"正在装"的牌子：注册动作本身会**同步**发 `tools/change`（`restrict()` 会 notify），
     * 而这时账还没记上（要等全部注册成功才记，见下），嵌套巡查于是会为同一个 agent 再进来一次，
     * 把同一套注册装两遍——第二遍的 `systemPrompt.section()` 会因为同名而抛。
     * 形状与 `dsh-tool-subagent` 的 `installing` 集合一致。
     */
    if (installing.has(agent)) return
    installing.add(agent)
    try {
      const disposers = []
      try {
        // 收窄只能经 `agent.ctx`：同一层注册的名字不是"可收窄的全局名"（见文件头）。
        const agentTools = agent.ctx.tools
        // 只点名本 agent 真的看得见的工具：preset 没挂 tool-fs 时，restrict() 会因为"未知名字"抛错。
        const present = deny.filter((name) => agentTools.get(name, agent) !== undefined)
        // 逃生口要在 `restrict()` **之前**抓引用：限制一上身，`get(name, agent)` 就变回 undefined（它读的是
        // 同一张受限视图），之后再抓只能拿到空。
        const escapes = escape ? present.map((name) => [name, agentTools.get(name, agent)]) : []
        if (mode === 'deny' && present.length > 0) disposers.push(agentTools.restrict({ deny: present }))
        for (const [name, definition] of escapes) {
          const disposer = registerEscape(agent, name, definition)
          if (disposer !== undefined) disposers.push(disposer)
        }
      } catch (error) {
        warn(`tool-native-edit-mask: ${mode} 失败（agent ${agentId(agent)}）：${errorText(error)}`)
      }
      for (const name of sections) {
        try {
          disposers.push(agent.ctx.systemPrompt.section({ name, order: SECTION_ORDER[name] ?? 199, text: '' }))
        } catch (error) {
          warn(`tool-native-edit-mask: 遮蔽 ${name} 失败（agent ${agentId(agent)}）：${errorText(error)}`)
        }
      }
      // 什么都没注册上就不记账：下一次巡查会再试一遍（否则一次瞬时失败就是永久失败）。
      if (disposers.length > 0) installs.set(agent, disposers)
    } finally {
      installing.delete(agent)
    }
  }

  /**
   * 撤销本行在一个 agent 作用域上注册的东西（`restrict` / 空段 / 逃生口）。
   *
   * 为什么必须做：收窄是注册在 **agent 自己的层**上的，它不随 preset 的更换自动消失。agent 换到别的
   * preset 之后如果留着这条限制，新 preset 的原生工具会被旧 preset 的门禁继续挡掉，而本插件的工具又
   * 已经随旧组合一起消失——那个会话就一个写工具都不剩了。
   * @param agent - 巡查判定为"已离开本组合"的 agent。
   */
  function unmaskAgent(agent) {
    if (agent === null || typeof agent !== 'object') return
    const disposers = installs.get(agent)
    if (disposers === undefined) return
    // 先摘账再撤销：撤销会发 `tools/change`，嵌套巡查必须看到一个已经处理完的状态。
    installs.delete(agent)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        warn(`tool-native-edit-mask: 撤销失败：${errorText(error)}`)
      }
    }
  }

  /**
   * 门禁谓词，也是归属探测器。
   *
   * 可见性判据必须在**调用发生时**按 `exec.agent` 现算：`tools.get` 是带作用域链的查询，而 `deny` 的
   * 名字由组合里另一行注册，于是"本 agent 看不见但别处看得见"是常态——按注册时的某个 agent 算，就会把
   * 兄弟 agent（或另一个 preset 的 agent）的原生工具一并拒掉（探针抓到过）。
   * @param exec - 待执行的调用描述（至少含 `name` 与 `agent`）。
   * @returns 拒绝原因，或 undefined 表示放行。
   */
  function guard(exec) {
    if (exec === null || typeof exec !== 'object') return undefined
    if (probes.has(exec)) return PROBE_REPLY
    if (!deny.includes(exec.name)) return undefined
    const agent = exec.agent
    if (agent === undefined || agent === null) return undefined
    let visible = false
    try {
      visible = tools.get(exec.name, agent) !== undefined
    } catch {
      return undefined
    }
    if (!visible) return undefined
    // 顺手收窄：守卫能拦到，说明本层就在这个 agent 的作用域链上（见下面 membership 的说明）。
    // 于是下一次请求的工具表就是干净的，模型也不必先撞一次墙。
    maskAgent(agent)
    return REFUSAL
  }

  /**
   * 判据：这个 agent 是否加入了本行所在的常驻组合。
   *
   * 用探测对象调 `tools.guardReason()`：它会遍历 `chainLayers(exec.agent)`——**本行作用域层只在链上时才
   * 会走到本行的守卫**，所以"拿到哨兵"就是"本层在链上"。这条判据只依赖 `dsh-tools`，不需要
   * `@deepseek-ai/dsh-scope`（本包零依赖，见文件头）。
   *
   * 三态而不是布尔，两个理由：
   *   * `guardReason` 先看**全局层**、再按作用域链从远到近取第一个非空答复——别人的守卫完全可能先答
   *     （连"我是全局的、谁都拒"这种都有）。拿到"别人答的"不等于"不是我的人"，所以是 `unknown`；
   *   * 判据本身不可用时同样必须是 `unknown`：把"不知道"当成"outsider"会让巡查**撤掉**一个本来有效的
   *     收窄，那比不收窄更糟。
   * @param agent - 候选 agent。
   * @returns `'member'` / `'outsider'` / `'unknown'`。
   */
  function membership(agent) {
    if (!guardArmed || agent === null || typeof agent !== 'object') return 'unknown'
    if (typeof tools.guardReason !== 'function') {
      warnOnce(
        'guardReason',
        'tool-native-edit-mask: 这个 dsh 的 tools 服务没有 guardReason()，无法判断 agent 是否属于本组合：'
        + '只保留建档/守卫两条通路，换 preset 与换出去的还原不再生效（把 @deepseek-ai/dsh-tools 升到带它的版本即可）',
      )
      return 'unknown'
    }
    try {
      const reply = tools.guardReason(probeExec(agent))
      if (reply === PROBE_REPLY) return 'member'
      return reply === undefined ? 'outsider' : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * 巡查所有活 agent：属于本组合的收窄，离开本组合的还原，判据不可用的不动它。
   *
   * 触发点：`tools/change`（`recompose()` 重绑作用域之后会发；本行自己的收窄/撤销也会发）与
   * `apply` 末尾各一次。**必须防重入**：收窄会同步发 `tools/change`，不拦就会一层层嵌下去
   * （N 个 agent 同时加入就是 O(N²) 次作用域链遍历）；这里用一个"跑完再跑一次"的闸门收口。
   */
  function sweep() {
    if (!narrowing) return
    if (sweeping) {
      sweepingAgain = true
      return
    }
    /**
     * 注册表是**可选**的：宿主没有 agent 注册表（自建组合、最小 harness）时，它也不会发
     * `agent/created`，那种组合里只有守卫那条路（见文件头）。
     * `ctx.get` 本身也做存在性判断，好让最小测试用的壳上下文不至于把挂载带崩。
     */
    if (typeof ctx.get !== 'function') return
    const registry = ctx.get('agents')
    if (registry === undefined || typeof registry.list !== 'function') return
    sweeping = true
    try {
      for (const agent of registry.list()) {
        const state = membership(agent)
        if (state === 'member') maskAgent(agent)
        else if (state === 'outsider') unmaskAgent(agent)
      }
    } finally {
      sweeping = false
      if (sweepingAgain) {
        sweepingAgain = false
        sweep()
      }
    }
  }

  /**
   * `escape: true`：把被收窄掉的原生工具，以**另一个名字**注册进 agent 自己的作用域。
   *
   * 为什么只能这样：注册表的可见性与可调用性是**同一个** `view(scope).visible` 映射——schema 下发、
   * `get()` 查找、`createExecution` 的放行判断读的都是它。所以"看不见但调得动"在 API 里没有开关，
   * 唯有 `view()` 显式排除的那一类例外可以绕过限制：**作用域自己的注册**（`own.tools` 那一段在限制
   * 过滤器之外）。于是逃生口是一对新名字（`native_edit` / `native_write`），而不是让原生名字复活。
   *
   * 它保留原生工具的一切：参数 schema 逐个照搬（调用方无需改写参数名），转发给同一个 `execute`，而那
   * 个 execute 自带 `sandbox_permissions` 升权解析与 `ctx.waterfall('fs/write-intent' | 'fs/edit-intent')`
   * 前置策略（先读后写、版本新鲜度）——所以这不是绕过宿主策略，只是换了个模型看得见的名字。
   *
   * 它是**静默**逃生口：描述只陈述"跑的是哪个原生工具、它有什么代价"，**不写**使用条件。什么时候用它由
   * 调用方（用户）判断并在对话里说，而不是由提示词告诉模型——把"仅当用户明确要求时"写进描述，等于让模型
   * 每次都为"我该不该用这个"分神，逃生口"默认不走"的意义也就被抵消了。
   *
   * @param agent - 已收窄的 agent（其 `ctx` 是自己的作用域）。
   * @param original - 被收窄掉的原生工具名。
   * @param target - 收窄**之前**抓到的工具定义（限制生效后 `get` 就查不到了）。
   * @returns 注册的撤销句柄，或 undefined（拿不到原生定义时没有逃生口可注册）。
   */
  function registerEscape(agent, original, target) {
    if (target === undefined) return undefined
    const parameters = target.parameters === undefined || target.parameters === null
      ? { type: 'object', properties: {} }
      : structuredClone(target.parameters)
    // `output` 是注册表的硬性要求（`{ schema, render, presentationMeta? }`），而这里必须给出**自己**的一份：
    // schema 与 render 逐字照搬原生，模型看到的返回文本因此与走原生工具时一致。
    const nativeOutput = target.output ?? {}
    const output = {
      schema: structuredClone(nativeOutput.schema ?? { type: 'object', properties: {} }),
      render: typeof nativeOutput.render === 'function' ? nativeOutput.render : () => [{ type: 'text', text: `${original} ran` }],
      ...typeof nativeOutput.presentationMeta === 'function'
        ? { presentationMeta: (args, value) => nativeOutput.presentationMeta(args, value) }
        : {},
    }
    return agent.ctx.tools.register({
      name: `${ESCAPE_PREFIX}${original}`,
      description: `Run the built-in \`${original}\`. Its text handling is not byte-faithful: it drops a UTF-8 `
        + `BOM and flattens CRLF.`,
      parameters,
      output,
      async execute(args, exec) {
        return await target.execute(args, exec)
      },
    })
  }

  // 通路 1：`apply` 阶段就挂守卫。**与 agent 创建顺序无关**——这是"最迟防线"：recompose 之后第一次
  // 原生调用一定会被它拦下，并顺手把这个 agent 收窄。agent 档挂在本行层上（只有本组合的 agent 走到它），
  // 全局档挂在宿主层上（所有 agent 都走到它，所以只看 `exec.agent` 现算的可见性）。
  // `guard()` 自身不 notify（`dsh-tools` 里就是这么定的），所以这里不会引发 `tools/change` 回环。
  try {
    ctx.tools.guard(guard)
    guardArmed = true
  } catch (error) {
    warn(`tool-native-edit-mask: guard 注册失败：${errorText(error)}`)
  }

  /**
   * 本行到底该不该"收窄"。
   *
   * 宿主平面安装而配置里没写 `scope: 'global'` 时，本行的上下文没有作用域，守卫会落到**全局层**上
   * ——那一层的收窄会连没有本插件的 preset 一起改（把那些会话的写工具全拿走）。用无 agent 的探测问一句
   * 就知道了：只有全局层上的守卫会回答（`guardReason` 先看全局层，且没有 agent 时到此为止）。
   */
  let narrowing = !globalScope
  if (!globalScope && guardArmed) {
    try {
      if (tools.guardReason(probeExec(undefined)) === PROBE_REPLY) {
        narrowing = false
        warnOnce(
          'unscoped',
          'tool-native-edit-mask: 本行挂在宿主平面上（没有作用域），守卫落在全局层：只做否决、不做收窄。'
          + '如果这正是你的意图，给这一行加 `scope: global` 让配置与行为一致',
        )
      }
    } catch {
      // 探测不了就按配置走（`scope` 的默认值）。
    }
  }

  // 通路 2：建档时就加入本 preset 的 agent（含 subagent，它们同样父级到同一个常驻键）——
  // 作用域路由保证注册在本行层上的监听器只收到**加入本组合**的 agent 的事件。
  // 通路 3：换 preset。`recompose()` 重绑作用域之后会发 `tools/change`，此时 agent 的作用域链已经指向
  // 本组合，巡查就能认出它、把它收窄；反过来，被移出本组合的 agent 也会在这一刻被还原。
  if (narrowing) {
    ctx.on('agent/created', ({ agent }) => maskAgent(agent))
    ctx.on('tools/change', sweep)
    // agent 销毁时忘掉它：注册随它的作用域一起消散，账本留着只会是强引用。
    ctx.on('agent/disposed', ({ agent }) => installs.delete(agent))
    // 挂载时就巡查一次：`apply` 之前就可能已经有 agent 绑到了这个常驻组合（`ensureStanding()` 复用挂载，
    // 后加入的 agent 走 `agent/created`；remount 出来的新一代组合则要靠这一次巡查）。
    sweep()
    // 本行自己卸载（HMR 重载、行被 disabled）时，把手上所有 agent 的注册一并撤销：那些注册挂在
    // **agent 的 fiber** 上，不随本行消失；留着就成了一层没有主人的屏蔽，之后再没人能撤掉它。
    try {
      ctx.effect(() => () => {
        for (const agent of [...installs.keys()]) unmaskAgent(agent)
      }, 'tool-native-edit-mask.unload()')
    } catch (error) {
      warn(`tool-native-edit-mask: 卸载钩子注册失败：${errorText(error)}`)
    }
  }
}

/**
 * 把未知的抛出物渲染成一句日志。
 * @param error - 捕获到的值。
 * @returns 一句可读文本。
 */
function errorText(error) {
  return error && error.message ? String(error.message) : String(error)
}

/**
 * agent 的 id：门禁的失败日志必须指明是**哪个** agent，否则一条 warn 只能让人猜。
 * @param agent - 任意 agent 形状的值。
 * @returns id，或一句占位。
 */
function agentId(agent) {
  const id = agent === null || typeof agent !== 'object' ? undefined : agent.id
  return typeof id === 'string' && id !== '' ? id : '(unknown)'
}
