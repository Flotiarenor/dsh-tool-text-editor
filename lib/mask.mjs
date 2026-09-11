// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * mask.mjs —— dsh 插件行：把宿主的原生 `write` / `edit` 从这个 agent 的可见面里去掉。
 *
 * 为什么需要它：`edit_text` / `write_text` 修好的正是原生 `write` / `edit` 的三个缺陷（丢 UTF-8 BOM、
 * 把 CRLF 拍成 LF、`old_string` 差一个空格就报 FS_EDIT_NOT_FOUND）。但原生的那两个工具**仍然在工具
 * 表里**，于是每次请求都要付两份钱：
 *   * 两个 schema：`write` 728 B + `edit` 1026 B = 1754 B（已装 rc.6 实测，含沙箱升权字段）；
 *   * 两段引导：`tool:write` 220 B + `tool:edit` 388 B = 608 B；
 *   * 而我们自己的引导段还得花字节劝模型别用它们（`lib/editor.mjs` 的 GUIDANCE 有一半在讲这件事）。
 * 合计约 2.4 KB/请求，全部是为了让模型**不去**碰那两个工具。
 *
 * 做法（两个通道，都作用在**每个 agent 自己的作用域**上）：
 *   * `agent.ctx.tools.restrict({ deny })` —— 注册表只有一套可见性解析器，schema 下发、名称查找与
 *     调用派发读的是同一张视图，所以被拒的名字既**不出现在工具表里**，也**调不动**（直呼其名得到
 *     `UNKNOWN_TOOL`）。不是"藏起来但还留着后门"。
 *   * `agent.ctx.systemPrompt.section({ name: 'tool:write', text: '' })` —— 在更近的层注册同名**空段**，
 *     遮蔽 `dsh-tool-fs` 注册的那两段引导（`ScopedLayers.merge` 近者胜，空段在渲染时被丢弃）。
 *
 * 为什么必须挂在 `agent/created` 上：`restrict()` 只能从**带作用域的上下文**调用，而从本插件行自己的
 * 上下文（preset 常驻作用域）调用会被拒绝——同一个层里注册的名字不算"可限制的全局工具"。agent 创建
 * 时拿到的 `agent.ctx` 才是正确的作用域，且作用域路由保证：注册在本行作用域里的监听器只会收到
 * **加入本 preset 的 agent**（含 subagent 子 agent，它们同样父级到同一个常驻键）。
 *
 * 两种模式：
 *   * `mode: 'deny'`（默认）—— 上面那套：看不见，也调不动。省下 2.4 KB/请求。
 *   * `mode: 'guard'` —— 工具**保持可见**，但调用被否决（`agent.ctx.tools.guard`），拒绝原因里指向
 *     `edit_text` / `write_text`。想留一条"原生工具还能被调用、只是被拒"的观察窗时用它：schema 与
 *     引导的钱照付，换来的是原生工具仍然可测、可对比。
 *
 * 三档与两条作用域（`scope`）：
 *   * `scope: 'agent'`（默认，配合 `mode: 'deny'`）：看不见**也**调不动原生工具，省下 2362 B/请求。代价是
 *     屏蔽之后模型没有任何原生路径。
 *   * `scope: 'agent'` + `escape: true`：仍然看不见原生**名字**，但被收窄的工具以 `native_edit` /
 *     `native_write` 回到本 agent 自己的作用域里（见 `registerEscape`）。这是"看不见但能调"唯一可行的
 *     形状——注册表的可见性与可调用性是同一个映射，唯有作用域自己的注册不被限制过滤。
 *   * `scope: 'global'`：挂在宿主平面（profile 层），对**所有** agent 与所有 preset 生效，只做
 *     `mode: 'guard'` 那种"看得见、调不动"；省不下引导那 608 B，换来的是不必"新建会话时选对 preset"。
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
 *   scope: 'agent' | 'global'     默认 agent；global 只做 guard（本模块 export 了 inject，global 档才挂得上）
 *   escape: boolean               默认 false；只对 `deny` + `scope:'agent'` 有意义，见上
 *   deny: string[]                默认 ['write','edit']；只对**本 agent 真的看得见**的名字生效
 *   sections: string[]            默认 ['tool:write','tool:edit']；空段遮蔽的引导段名，[] 关闭
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
 * 只消费宿主服务。**必须声明**：cordis 只往声明了 `inject` 的上下文上提供这些服务，所以缺了它
 * `ctx.tools` 就是 undefined——`mode: 'guard'` 与 `scope: 'global'` 两条路都在 `apply` 里当场注册守卫，
 * 没有声明就等于静默不生效（`ctx.tools.guard` 直接抛，被下面的 try/catch 记成一条 warn）。
 */
export const inject = ['tools', 'systemPrompt']

/**
 * 注册"屏蔽原生 edit/write"的门禁。
 * @param ctx - 插件上下文（preset 常驻作用域）。
 * @param config - preset 行配置（见文件头）。
 */
export function apply(ctx, config) {
  const settings = config === undefined || config === null ? {} : config
  const mode = settings.mode === 'guard' ? 'guard' : 'deny'
  /** `agent`（默认）作用在加入本行的 agent 上；`global` 只做全局守卫（见文件头与 guardEveryAgent）。 */
  const scope = settings.scope === 'global' ? 'global' : 'agent'
  /** 逃生口只在 deny 档有意义：guard 档里原生名字本来就能调，只是被守卫否决。 */
  const escape = settings.escape === true && mode === 'deny'
  const deny = Array.isArray(settings.deny) ? settings.deny.filter((name) => typeof name === 'string' && name !== '') : DEFAULT_DENY
  const sections = Array.isArray(settings.sections)
    ? settings.sections.filter((name) => typeof name === 'string' && name !== '')
    : DEFAULT_SECTIONS
  /** 每个 agent 只处理一次：`agent/created` 理论上只发一次，重名注册会抛（同层重复）。 */
  const masked = new WeakSet()
  /** 全局档的守卫只注册一次（第一个 agent 创建时），见 maskAgent。 */
  let guardRegistered = false

  /**
   * 把一个 agent 的可见面收窄。
   *
   * 全程 try/catch：这个监听器在 `agent/created` 的同步派发里跑，抛出只会被注册表记一条 warn，而
   * 屏蔽**没做成**这件事必须留下痕迹——所以失败时记日志，绝不让它把 agent 创建本身带崩。
   * @param agent - 刚注册的 agent（其 `ctx` 是它自己的作用域）。
   */
  function maskAgent(agent) {
    if (agent === null || typeof agent !== 'object' || masked.has(agent)) return
    masked.add(agent)
    // 全局档：守卫只注册一次，而且就在**第一个 agent 创建时**——那一刻 `agent.ctx.tools` 一定是真实的
    // 服务对象（不是 `apply` 阶段那个可能还没拿到服务的裸 ctx）。从 agent 作用域上下文注册的守卫挂在
    // 宿主**全局**层上（`layers.effect` 对没有自己层的上下文返回 global），所以它覆盖之后创建的每一个
    // agent、每一个 preset，也包括没有 preset 归属的 agent。
    if (scope === 'global' && !guardRegistered) {
      guardRegistered = true
      guardEveryAgent(agent.ctx.tools)
      return
    }
    try {
      const tools = agent.ctx.tools
      // 只点名本 agent 真的看得见的工具：preset 没挂 tool-fs 时，restrict() 会因为"未知名字"抛错。
      const present = deny.filter((name) => tools.get(name, agent) !== undefined)
      // 逃生口要在 `restrict()` **之前**抓引用：限制一上身，`get(name, agent)` 就变回 undefined（它读的是
      // 同一张受限视图），之后再抓只能拿到空。
      const escapes = escape ? present.map((name) => [name, tools.get(name, agent)]) : []
      if (mode === 'deny' && present.length > 0) tools.restrict({ deny: present })
      // guard 档：工具保持可见，调用被否决。判据与全局档同一条——按 `exec.agent` 现算，理由见 guardEveryAgent。
      if (mode === 'guard') tools.guard((exec) => (tools.get(exec.name, exec.agent) !== undefined && deny.includes(exec.name) ? REFUSAL : undefined))
      for (const [name, definition] of escapes) registerEscape(agent, name, definition)
    } catch (error) {
      ctx.logger?.warn?.(`tool-native-edit-mask: ${mode} 失败：${error && error.message ? error.message : String(error)}`)
    }
    for (const name of sections) {
      try {
        agent.ctx.systemPrompt.section({ name, order: SECTION_ORDER[name] ?? 199, text: '' })
      } catch (error) {
        ctx.logger?.warn?.(`tool-native-edit-mask: 遮蔽 ${name} 失败：${error && error.message ? error.message : String(error)}`)
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
   * 它是**显式**逃生口而非第二个默认入口：模型只有从工具描述里知道它存在，描述里写明"仅当用户明确要求
   * 用原生工具时才调用"。
   *
   * @param agent - 已收窄的 agent（其 `ctx` 是自己的作用域）。
   * @param original - 被收窄掉的原生工具名。
   * @param target - 收窄**之前**抓到的工具定义（限制生效后 `get` 就查不到了）。
   */
  function registerEscape(agent, original, target) {
    if (target === undefined) return
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
    agent.ctx.tools.register({
      name: `${ESCAPE_PREFIX}${original}`,
      description: `Special case only: run the built-in \`${original}\`, whose text handling is NOT byte-faithful `
        + `(it drops a UTF-8 BOM and flattens CRLF). Call it ONLY when the user explicitly asks for the built-in `
        + `\`${original}\`; for every other change use edit_text / write_text.`,
      parameters,
      output,
      async execute(args, exec) {
        return await target.execute(args, exec)
      },
    })
  }

  /**
   * `scope: 'global'` 用的全局守卫。工具保持可见、调用被否决：空段遮蔽在 scoped 层会被 `dsh-tool-fs`
   * 那两段反遮蔽（见文件头），所以这一档不注册段，也就省不下那 608 B 引导——换来的是对所有 agent 与
   * 所有 preset 都生效的门禁，不需要"新建会话时选对 preset"。
   *
   * 可见性判据必须在**调用发生时**按 `exec.agent` 现算：`tools.get` 是带作用域链的查询，而 `deny` 的
   * 名字由宿主全局注册（profile 层的 tool-fs 行）提供，于是"本 agent 看不见但全局看得见"是常态——按
   * 注册时的某个 agent 算，就会把兄弟 agent（或另一个 preset 的 agent）的原生工具一并拒掉。
   *
   * @param tools - 真实的服务对象（从 `agent.ctx.tools` 取，见 maskAgent 里的调用点）。
   */
  function guardEveryAgent(tools) {
    if (deny.length === 0) return
    try {
      // 逐名判断：`deny` 里**任一**名字可见就拒，会把 `edit_text` 这类无关工具一起拒掉（探针抓到过）。
      tools.guard((exec) => (deny.includes(exec.name) && tools.get(exec.name, exec.agent) !== undefined ? REFUSAL : undefined))
    } catch (error) {
      ctx.logger?.warn?.(`tool-native-edit-mask: 全局 guard 注册失败：${error && error.message ? error.message : String(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => maskAgent(agent))
}
