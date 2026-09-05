# dsh-proactive-memory

给 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) agent 加"episode 内主动记忆"的插件，参考
[Proactive Memory（arXiv 2607.08716）](https://arxiv.org/abs/2607.08716)。一个便宜的记忆模型逐步旁观执行
agent，在每个模型步之前决定要不要往执行模型的上下文里塞一条简短提醒。执行 agent 的系统提示、工具、解码都不动。

> English: [README.md](README.md)

## 架构

```
用户消息 ──► dsh turn 循环
              │  每个模型步（turn 开头，以及每次工具结果回来之后）：
              ├─ agent/pre-step ──► proactive-memory
              │                      1. 输入   = 日志里最近 8 条消息（加上这一步刚 claim 到的）
              │                                 + 这一集的关键工具调用和写操作，不受窗口限制
              │                      2. 咨询   = 记忆模型（ctx.llm.stream，例如 deepseek-v4-flash）
              │                           系统提示里带着领域 <policy>，那是它唯一的规则来源
              │                           阶段 1：改自己的私有库 {status, knowledge[], procedural[]}
              │                           阶段 2：<no_intervention/> 或 <context_for_action>提醒</context_for_action>
              │                      3. 在请求前 splice 一条 <system-reminder> 用户消息
              │                           （或者什么都不做；任何失败 ⇒ 这一步原样进行）
              ├─ 执行模型请求
              ├─ tools/pre-execute ──► proactive-memory 只观察写调用（从不 deny）
              ├─ tools/result ─────► proactive-memory 记下每个 keyTools 调用和它的结果
              └─ 工具结果 ──► 下一步
            agent/disposed ──► 记忆库丢弃（没有跨 episode 状态）
            proactive-memory/event ──► 宿主收集 consult / inject / skip / error
```

全部工作由 `agent/pre-step` 上的一个监听器完成；记忆库放在按 `agent.id` 分开的 `Map` 里。两条硬规则，
带 dsh 循环行号的论证见 [docs/reference.md](docs/reference.md)：不用 `agent.inject()`、不往本来不会跑的
步里 splice（R1）；不 append 自定义会话事件、不注册系统提示分段（R2）。

`mode` 就是实验臂，对应论文的消融：

| `mode` | 记忆模型调用 | 做什么 |
| --- | --- | --- |
| `off` | 0 | 什么都不注册 |
| `always` | 0 | 每个调度步前塞同一条固定提醒（论文的 always-inject） |
| `proactive` | 每个调度步 1 次 | 维护记忆库，再决定要不要打断 |
| `proactive-nobank` | 每个调度步 1 次 | 只做打断决策，不建库 |
| `bankctx` | 每个调度步 1 次 | 维护记忆库，库有变化时把整个库渲染进去 |

源码布局：`src/index.mjs`（监听器，唯一有状态的模块）、`config.mjs`、`window.mjs`、`bank.mjs`、
`memory-agent.mjs`（辅助调用）、`protocol-text.mjs` / `protocol-tools.mjs`（解析器）、`inject.mjs`
（清洗、包装、去重）、`events.mjs`、`trace.mjs`；`prompts/memory.{en,zh}.md` 是系统提示。

## 运行

```bash
git clone https://github.com/ocensis/dsh-proactive-memory.git
cd dsh-proactive-memory && npm install   # 要有自己的 node_modules：Node 从插件的真实目录解析它的 import
npm test       # 86 个离线单测，不用 key
npm run demo   # 一段脚本化的 episode：咨询、库编辑、注入的提醒、事件
```

在 dsh profile 里按相对于 patch 文件的路径挂载，放在工具策略类插件（比如写前确认闸门）之后、驱动循环的插件之前：

```yaml
- insert:
    - id: proactive-memory
      name: '../../path/to/dsh-proactive-memory/src/index.mjs'
      config:
        mode: proactive
        model: { provider: openrouter, model: deepseek/deepseek-v4-flash }
        policyFile: /abs/path/to/policy.md                                   # 记忆模型唯一的规则来源
        keyTools: [find_user_id_by_email, find_user_id_by_name_zip]          # 结果要跨窗口一直留着的调用
        writeTools: [cancel_pending_order, exchange_delivered_order_items]   # 哪些工具算"写"
        trace: { dir: ./memory-trace }                                       # 每次咨询一行 JSONL
```

`model` 留空会回退到执行模型的默认模型，并大声警告。发到 npm 之后可以直接
`dsh plugin add dsh-proactive-memory`，套用随包的 [`cordis.patch.yml`](cordis.patch.yml)。

τ²-bench 上完整的 harness 接入（参数、臂、报表列）见 [examples/tau2/README.md](examples/tau2/README.md)；
配置表、协议、事件契约、trace 格式见 [docs/reference.md](docs/reference.md)；和论文逐条对照见
[docs/paper-fidelity.md](docs/paper-fidelity.md)。

还没有 benchmark 结果：目前只有离线测试、demo 和 τ²-bench harness 上的几次 smoke。

MIT，见 [LICENSE](LICENSE)。
