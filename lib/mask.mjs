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
 * 有意为之的取舍：
 *   * **不是权限边界**。dsh 文档把 `restrict()` 定义为 live visibility composition：原生工具仍然注册在
 *     注册表里（GUI 的插件/工具清单可能照旧列出它们），shell 命令也一样能写文件。它保证的是"模型眼里
 *     只剩字节工具"，不是"文件受保护"。
 *   * **只影响加入本行的 agent**。没有 preset 归属的 agent、以及其它 preset 的 agent 不受影响——这正好
 *     留出对照组（例如另一个 preset 的新会话里原生工具照旧可用）。
 *   * 名字写死在默认表里而不是硬编码在流程里：`tool-fs` 改名/拆包时改 `config` 即可。
 *
 * 配置（本插件没有 Config schema，preset 行的 `config:` 字段原样透传）：
 *   mode: 'deny' | 'guard'        默认 deny
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

/**
 * 注册"屏蔽原生 edit/write"的门禁。
 * @param ctx - 插件上下文（preset 常驻作用域）。
 * @param config - preset 行配置（见文件头）。
 */
export function apply(ctx, config) {
  const settings = config === undefined || config === null ? {} : config
  const mode = settings.mode === 'guard' ? 'guard' : 'deny'
  const deny = Array.isArray(settings.deny) ? settings.deny.filter((name) => typeof name === 'string' && name !== '') : DEFAULT_DENY
  const sections = Array.isArray(settings.sections)
    ? settings.sections.filter((name) => typeof name === 'string' && name !== '')
    : DEFAULT_SECTIONS
  /** 每个 agent 只处理一次：`agent/created` 理论上只发一次，重名注册会抛（同层重复）。 */
  const masked = new WeakSet()

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
    try {
      const tools = agent.ctx.tools
      // 只点名本 agent 真的看得见的工具：preset 没挂 tool-fs 时，restrict() 会因为"未知名字"抛错。
      const present = deny.filter((name) => tools.get(name, agent) !== undefined)
      if (mode === 'deny') {
        if (present.length > 0) tools.restrict({ deny: present })
      } else if (present.length > 0) {
        tools.guard((exec) => (present.includes(exec.name) ? REFUSAL : undefined))
      }
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

  ctx.on('agent/created', ({ agent }) => maskAgent(agent))
}
