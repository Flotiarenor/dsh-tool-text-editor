# dsh-tool-text-editor

中文 | [English](README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）的模型工具插件，提供两个**字节保真**的
文本编辑工具：`edit_text` 与 `write_text`。

它解决原生工具在 Windows 上的两个真实缺陷：

| 场景（文件为 UTF-8 **BOM + CRLF**） | 原生 `edit`                  | 原生 `write`                       | 本插件            |
| ---------------------------------------- | ----------------------------- | ----------------------------------- | ----------------- |
| 改一行                                   | CRLF 保住 / **BOM 丢失** | —                                  | BOM + CRLF 都保住 |
| 整篇覆盖                                 | —                            | **BOM 丢失 + CRLF 被拍成 LF** | BOM + CRLF 都保住 |

原因：`@deepseek-ai/dsh-fs-local` 全文没有 BOM 处理（Node 的 `TextDecoder` 默认吞掉前导 BOM
字节），而 `writeText` 不按原文件风格还原行尾。

除保真之外还带来：**统一 diff**（默认 dry-run 可预览）、**落盘前自动备份**、**编辑台账**、
**`grep`/`lines` 锚点**（不必手抄旧文本）、**歧义拒写**与**"最接近候选"**提示。

## 实现与依赖

实现是**进程内 Node**（`lib/core.mjs`）：只用 `node:` 内置模块，不启动任何子进程，无构建步骤、
无第三方依赖。

| 依赖 | 说明                                                                           |
| ---- | ------------------------------------------------------------------------------ |
| Node | **唯一的依赖**，不启动解释器、不加外部运行时、每次调用没有进程启动开销。 |

本包自己不安装任何依赖。唯一一条 `peerDependencies`（`@deepseek-ai/dsh-tools`）是**宿主契约**
（"需要这个版本以上的 dsh"），由 dsh 安装目录里的那份满足，不会跟着插件被装进用户环境。

## 安装

### 方式一：preset（推荐，作用域干净）

只让"选了这个 preset 的会话"看到这两个工具，其它项目/会话的工具表保持干净。**在本仓库根目录**执行：

```powershell
node scripts/install-preset.mjs
# 可选：--id <preset-id>（默认 texteditor）/ --base <自带 preset>（默认 standard）
#       / --force / --dry-run / --from <agent.cordis.yml 路径>
```

安装器读的是**你自己那份 dsh 自带的 preset 组合**（`config/agent-presets/standard/agent.cordis.yml`；
用 `--base` 换一份自带的，或用 `--from` / `DSH_PRESET_SOURCE` 指向任意组合），把指向本仓库
`lib/editor.mjs` 的 `tool-text-editor` 那一行插进去，再写到 `<DSH_HOME>\.agent-presets\texteditor\`
（`DSH_HOME` 默认是 `~/.dsh`）。**然后重启 `dsh web`，新建会话时选 preset `texteditor`。**

本仓库**不包含** dsh 自带组合的任何拷贝，所以 preset 跟着你装的 dsh 版本走 —— 升级 dsh 后加
`--force` 重跑一次即可跟上。

> preset 是会话**创建期**事实：已经在跑的会话换不了 preset。

### 方式二：装进 profile（所有会话可用）

`dsh plugin add` 支持多种来源，这里**每一种都能用**：本包是预构建的零依赖 ESM，没有
`prepare`/`build` 步骤，所以既不需要用户授权构建，也不会在安装时执行任何构建脚本。

| 来源           | 命令                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| 本地 checkout  | `dsh plugin --profile web add link:<本仓库的绝对路径>`                    |
| npm（发布后）  | `dsh plugin --profile web add @flotiarenor/dsh-tool-text-editor`            |
| 打包的 tarball | 先 `pnpm pack`，再 `dsh plugin --profile web add ./<它打印的文件名>.tgz` |
| git 仓库       | `dsh plugin --profile web add github:<owner>/dsh-tool-text-editor`        |

不必启动就能先确认层进没进去：

```powershell
dsh --profile web --dump-config   # 应当能看到 "# == @flotiarenor/dsh-tool-text-editor" 这一段
```

`edit_text` / `write_text` 不与原生工具重名，插进宿主组合不会冲突。代价是这两个工具（以及那段
提示词引导）出现在**每一个**会话里。卸载：`dsh plugin --profile web remove @flotiarenor/dsh-tool-text-editor`。

两种方式可以同时存在：preset 层的注册在同名时遮蔽宿主层的，定义相同、行为一致。

## 工具契约

### `edit_text` —— 局部替换

| 参数          | 必填 | 说明                                                                     |
| ------------- | ---- | ------------------------------------------------------------------------ |
| `file_path` | ✅   | 目标文件；相对路径按**会话工作区**解析。                           |
| `new_text`  | ✅   | 替换/插入的内容。                                                        |
| `old_text`  | -    | 字面量锚点（从 `read` 拷来即可）。                                      |
| `grep`      | -    | 正则锚点：命中的那一行/行块作为锚点（含行尾换行）。                      |
| `lines`     | -    | 行号锚点，如 `"263:270"` 或 `"120"`。                                 |
| `mode`      | -    | `replace`（默认）/ `after` / `before` / `append` / `prepend`。 |
| `count`     | -    | 要求**恰好** N 处命中并全部替换（不符则拒绝写盘）。                |
| `nth`       | -    | 只替换第 k 处（1-based）。                                               |
| `strict`    | -    | 禁用宽松匹配（只接受精确匹配）。                                         |
| `dry_run`   | -    | 只出 diff，不落盘。                                                      |
| `note`      | -    | 一句话理由，写进编辑台账。                                               |

`old_text` / `grep` / `lines` **必须恰好给一个**；`append`/`prepend` 不给锚点，`after`/`before`
只能配 `grep`/`lines`。多给少给都会在**动文件之前**被拒绝。`count` 与 `nth` 互斥。

### `write_text` —— 整文件新建/覆盖

`file_path` + `content`；目标不存在时自动新建（不用额外开关），覆盖时先备份。新建文件的行尾跟随
同目录**多数派**（同扩展名优先），默认不写 BOM。

两者**默认真的落盘**（与原生 `edit`/`write` 一致）；要预览就传 `dry_run: true`，返回文本里始终带 diff。

## 它不做什么

- **写盘不经过 `ctx.fs`**：绕过 fs 观察策略（先读后写 / 版本新鲜度）、沙箱与 `sandbox_permissions`
  审批升权、Windows DACL 保留。
- **`lines` / `before <行号>` 是盲锚点**：行号错了**不会报错**，会改在别的地方。优先 `old_text` / `grep`。
- **同目标串行只覆盖本进程**：并行工具调用之间不会互相覆盖（进程内按目标排队 + 原子写），但另一个
  dsh 实例或你手边的编辑器同时改同一文件时，仍可能互相覆盖；本插件也不检测外部改动。
- 拒绝二进制（含 NUL）与非法 UTF-8 文件；`.git/`、`.dsh/` 内部与工作区之外的路径一律拒写。

## 配置

本插件没有 Config schema：preset 行的 `config:` 字段原样透传。

| 键               | 默认              | 含义                                             |
| ---------------- | ----------------- | ------------------------------------------------ |
| `backup`       | `true`          | 落盘前把原内容复制到 `artifactsDir/backups`     |
| `ledger`       | `true`          | 往 `artifactsDir/edits.log` 追加一条 JSONL 记录 |
| `artifactsDir` | `<工作区>/.dsh` | 备份与台账所在目录                               |
| `newFileBom`   | `false`         | 新建文件时是否写 UTF-8 BOM                       |
| `context`      | `3`             | unified diff 的上下文行数                        |
| `root`         | `process.cwd()` | 没有 agent 会话时的回退工作区                    |

环境变量 `DSH_TEXT_EDITOR_EOL`（`lf` \| `crlf`）可覆盖**新建**文件的行尾推断。

## 自测与门禁

```powershell
# 在本仓库根目录执行
node tools/selftest.mjs        # Windows + Node 24 参考结果 75/75
node tools/check-license.mjs   # 许可证 / 依赖 / 纯 Node 门禁
node tools/gen-schema.mjs      # 内嵌 schema 是否仍与作者 DSL 一致
```

`tools/selftest.mjs` 覆盖：BOM/行尾保真、`dry_run`、四种锚点、`count`、歧义拒写、用法错误、
二进制/非法 UTF-8、护栏（`.dsh/`、工作区之外）、多数派行尾、多 hunk、末尾换行差异、并发写不撕裂；
**外加一层插件层断言** —— 用假 ctx 驱动 `apply()`，断言工具注册、引导段身份、每个返回值都满足
`OUTPUT_SCHEMA`、`render()` 文本、以及 config 透传（`root` / `backup` / `ledger` / `newFileBom`）。

`tools/gen-schema.mjs` 需要一份装有 `@deepseek-ai/dsh-tools` 的 dsh：它会在 dsh profile 的
`node_modules` 与 npm 全局目录下自动找，也可以用 `DSH_TOOLS_ENTRY` 显式指定；找不到入口时退出码 2。

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

备份与台账用固定的命名与字段：每次编辑一个文件放在 `.dsh/backups/` 下，名为
`<绝对路径扁平化>@<时间戳>`；`.dsh/edits.log` 每行一个 JSON 对象（`time`、`id`、`tool`、`file`、
`abspath`、`action`、`kinds`、`line_start`、`line_end`、`added`、`removed`、`bom`、`eol`、
`backup`、`summary`）。

## 发布清单

1. 移除 `package.json` 的 `private: true`（`publishConfig.access: public` 已经写好 —— scoped 包默认不是公开的）；
2. 让 `engines.node` 与 `@deepseek-ai/dsh-tools` 的 peer 区间都跟上你要支持的 dsh 版本 —— 那条 peer 区间
   才是插件清单与市场类工具读取的"兼容性声明"；
3. 先 `pnpm pack` 看一眼 tarball：`files` 白名单应产出 `LICENSE` + `lib` + `preset` + `cordis.patch.yml` + 两份 README，不多不少；
4. 在工作区干净的状态下显式指定官方源发布：`pnpm publish --registry https://registry.npmjs.org`；
   `prepublishOnly` 会先跑许可证门禁与自测。像 npmmirror 这样的镜像**不能**接收发布；
5. 给 `package.json` 里的版本打 tag（`v<version>`）。

## License

**Apache-2.0**，见 [LICENSE](LICENSE)。Copyright 2026 Flotiarenor。本包**零运行时依赖**，因此自身不承担
任何第三方许可证义务。三点说明：

- `lib/editor.mjs` 内嵌的 JSON Schema 是 `@deepseek-ai/dsh-tools`（MIT，Copyright (c) 2026 DeepSeek）
  转换器的**生成产物**（由 `tools/gen-schema.mjs` 离线生成）。
- preset 组合**不在本包里**：`scripts/install-preset.mjs` 在安装时读取使用者自己那份 dsh 自带的组合。
- 源文件都带 `SPDX-License-Identifier` 头，许可证**逐文件机器可读**。
