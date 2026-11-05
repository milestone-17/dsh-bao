# dsh-bao · DSH 宝

A TRAE-宝-style personal assistant for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), packaged as one installable plugin bundle.

**TRAE 宝做了什么？** 它长期跟着你的工作：跨项目理解你的任务、记住你的偏好、定时向你汇报、把需要你判断的事带回给你。`dsh-bao` 把同样的体验带进 DSH —— 但完全基于 Harness 的公开插件 API，不碰私有实现：

| 能力 | 说明 |
| --- | --- |
| 🧠 长期记忆 | `bao_remember` / `bao_recall` / `bao_forget` 三个工具 + 每次请求自动注入的「主人的长期记忆」上下文，跨会话记住你的偏好、项目事实与决策 |
| 💬 专属助理预设 | 安装即上架「DSH 宝」Agent 预设（会话新建处可选）：调度层人设——自己答问、记事、查状态，重活派 subagent；面板一键「和宝聊聊」直接开局 |
| ☕ 每日简报 | 每天固定本地时间（默认 09:00），把「活跃定时任务 + 最近推进的会话」汇总成一条桌面通知（默认可配） |
| 🔔 助手主动通知 | `bao_notify` 工具：模型可以以助理身份弹系统通知（定时汇总、需要你决策时） |
| 📊 状态速览 | `bao_status` 工具：模型一句话回答「最近在忙什么 / 有哪些提醒待办」 |
| 🗂 侧边栏面板 | 新增「DSH 宝」面板：长期记忆、定时任务、最近会话、简报开关一目了然，30 秒自动刷新 |

## 工作原理

- **记忆存储**：`$DSH_HOME/bao/memory.json`，原子写（临时文件 + rename），进程内写链串行化，零依赖、跨会话持久。
- **记忆注入**：注册为 system-prompt 的动态 runtime context（`interpolate: false`），每次模型请求前重新求值——刚记下的笔记下一步就生效；选用 context 而非 section，是为了与 `complete: true` 的预设人设共存（complete section 会替换全部 section，但 context 永远渲染）。
- **助理预设**：bundle 同时声明 `@deepseek-ai/dsh-agent-preset` 行（id `aibao`），插件清单对齐官方 `standard` 预设，人设来自 `dsh-persona`。

## 安装

**桌面端 / Web（推荐，插件市场命令）**

```bash
dsh plugin --profile <name> add dsh-bao
```

**从插件市场索引安装（Discover 页）**

本仓库自带一份 [插件市场索引](./market-index.json)（官方 format 1）。在 DSH 的插件市场索引设置里添加：

```
https://raw.githubusercontent.com/milestone-17/dsh-bao/master/market-index.json
```

之后 Discover 页即可搜索「DSH 宝」并一键安装（安装走 GitHub，pin 到发布 commit）。

**从源码（本目录）安装**

在 DSH 会话里让助理执行 `plugin_manager` 的 `install_bundle`，`target` 填这个目录的绝对路径；或在 Plugins 设置页选择本地目录安装。

**手动挂载（不用 bundle 通道）**

把下面一行加进你的 profile `cordis.patch.yml`：

```yaml
- insert:
    - id: aibao
      name: 'dsh-bao'
      config:
        digestTime: '09:30'
```

## 配置

配置写在插件行（Loader patch）的 `config` 里，升级不会丢：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后工具、路由、简报全部不注册 |
| `digestEnabled` | `true` | 每日简报开关 |
| `digestTime` | `"09:00"` | 简报触发的本地时间，`HH:mm`（进程时区） |
| `notifyTool` | `true` | 是否注册 `bao_notify` 工具 |
| `statusTool` | `true` | 是否注册 `bao_status` 工具 |
| `memoryTools` | `true` | 是否注册 `bao_remember` / `bao_recall` / `bao_forget` 记忆工具 |
| `memoryInject` | `true` | 是否把长期记忆作为运行时上下文注入每次请求 |
| `memoryInjectLimit` | `30` | 注入上下文里最多引用几条笔记 |
| `memoryNoteMaxChars` | `200` | 注入时单条笔记的最大字符数 |
| `sessionWindowCount` | `5` | 速览里最多列出几个最近会话 |
| `sessionWindowMs` | `93600000` | 「最近」的时间窗（毫秒），默认 26 小时 |
| `maxLineLength` | `90` | 单行摘要的最大字符数 |
| `sound` | `true` | 系统通知是否带声音 |
| `appUserModelId` | `"com.deepseek.dsh"` | Windows toast 的应用身份 |
| `routePath` | `"/bao/api"` | 面板数据路由前缀（loopback 围栏内） |

## 通知通道

按顺序尝试，第一个成功者生效：

1. **Electron 原生通知** —— Desktop 壳内运行时，带应用自身身份与图标；
2. **Windows 原生 toast**（`toast.ps1`，WinRT API，经 Windows PowerShell 5.1）—— 纯 Node Host（`dsh` CLI、远程 worker）也可用；
3. 都不可用时静默返回 `"none"`，绝不影响会话。

macOS / Linux 目前走 Electron 通道；纯 Node Host 上暂无额外通道（欢迎 PR）。

## 面板数据路由

`GET/POST /bao/api/overview` 返回速览 JSON。路由带与官方插件一致的信任围栏：仅 loopback（`localhost`/`[::1]`/`127/8`）或 `trustedHosts` 命中的 Host、拒绝 `cross-site` 请求、Origin 必须是监听器自身。路由**只读**：读 `schedule` 服务的目录与 `sessionTitle` 的会话行，不写任何状态，也不激活会话。

## 与内置能力的分工

DSH 本身已有 `schedule_create`（定时提醒投递到原会话）、`notify_user`、goals、subagents 等原语。`dsh-bao` 不替代它们，而是把「定时 + 通知 + 状态」组合成产品化的助理层：

- 内置 `schedule_*` 投递到会话 inbox；`dsh-bao` 读同一份目录做**人看的**简报与速览；
- 内置 `notify_user` 是会话内工具；`bao_notify` 面向「助理主动汇报」的语义，通道实现相同；
- 面板把散落的定时任务与最近会话聚合成一屏。

## 开发

无构建步骤、零运行时依赖：Host 半边是纯 ESM（`index.js` + `memory.js` + `delivery.js` + `toast.ps1`），Client 半边是单个 `client.js`（`window.__ModuleLoader__.load` 工厂，React 来自浏览器模块表）。语法检查：

```bash
node --check index.js && node --check memory.js && node --check delivery.js && node --check client.js
```

## License

[MIT](./LICENSE)
