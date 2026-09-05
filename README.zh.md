# dsh-plugin-proactive-memory

一个 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 插件。在**单个任务 episode 内**，一个便宜的
"记忆模型"逐步旁观执行 agent。在它每次模型调用之前，插件会

1. 维护一个执行 agent 看不到的私有记忆库 `{status, knowledge[], procedural[]}`；
2. 决定闭嘴，或者在执行 agent 的下一次请求前面塞**一条**简短提醒。

执行 agent 的系统提示、工具、解码全都不动。v0.1 没有跨 episode 持久化。各个臂与
*Proactive Memory*（arXiv 2607.08716）的消融一一对应，见 [`docs/paper-fidelity.md`](docs/paper-fidelity.md)。

> English: [README.md](README.md)

## 安装

```bash
npm i dsh-plugin-proactive-memory
dsh plugin add dsh-plugin-proactive-memory     # 会应用 cordis.patch.yml
```

或者在 profile 补丁里按相对路径直接挂源码：

```yaml
- insert:
    - id: proactive-memory
      name: '../../path/to/dsh-plugin-proactive-memory/src/index.mjs'
      config:
        mode: proactive
        model: { provider: openrouter, model: deepseek/deepseek-v4-flash }
```

Node 是按插件的**真实目录**解析它自己的裸包 import 的，所以挂源码时必须先在本仓库里跑一次
`npm install`。进程里出现第二份 `@deepseek-ai/dsh-llm` 没有问题：它的工厂函数返回普通对象，
没有任何 `instanceof` 判断。

## 实验臂

| `mode` | 模型调用 | 做什么 | 对应论文消融 |
| --- | --- | --- | --- |
| `off` | 0 | 一个监听器都不注册 | 基线 |
| `always` | 0 | 每个调度点塞同一条固定提醒 | always-inject |
| `proactive` | 每步 1 次 | 完整机制：先建库，再决定 | 完整 agent |
| `proactive-nobank` | 每步 1 次 | 只决定；不建库也不发库 | 只注入不建库 |
| `bankctx` | 每步 1 次 | 建库，注入渲染后的库而不是精选提醒 | 全库塞上下文 |

`always` 是免费臂：记忆侧零额外 token，而论文里它与精选注入打平。先跑它，再考虑花钱的臂。

## 配置

所有字段都可省略，下面是默认值。

```yaml
mode: off                       # off | always | proactive | proactive-nobank | bankctx
model:                          # provider/model 留空会回退到执行 agent 的默认模型
  provider: ''                  # ……并且大声警告，因为静默共用执行模型会让两个臂混成一个
  model: ''
  temperature: 0
  maxTokens: 512
  timeoutMs: 20000
protocol: text                  # text（一次往返，标签语法）| tools（四个真实 ToolSchema）
schedule: { firstStep: true, everySteps: 1, maxCallsPerEpisode: 40 }
window:  { messages: 8, toolResultChars: 800, argChars: 400 }
bank:    { maxKnowledge: 12, maxProcedural: 12, maxEditsPerCall: 6 }
intervention: { maxChars: 400, maxPerEpisode: 12, dedupeJaccard: 0.8 }
alwaysText: '…'                 # mode: always 用的那条固定提醒
locale: en                      # 决定用 prompts/memory.<locale>.md
promptFile: ''                  # 绝对路径，覆盖内置提示词
writeTools: []                  # 哪些工具名算"即将写"，喂给 <about_to_act>
trace: { dir: '', console: true }
```

## 两条硬规则

**R1 —— 绝不用 `agent.inject()`，也绝不往空 step 里 splice。** `agent.inject()` 把消息排进
`inbox.nextStep`，而 loop 只在 `turnEnds && nextStep.length === 0` 时才跳出 step 循环
（`dsh-agent-loop:571`），于是本该结束的 turn 又多一次模型请求，一个用户 turn 出现两条 assistant
消息。splice 有同样的风险：`step === 0` 且 decision 为空时 loop 直接结束 turn
（`dsh-agent-loop:543-546`），往那里塞消息等于凭空造出一次请求。所以只要
`decision.kind === 'reject'`、claimed 列表为空、或 `decision.messages` 为空，本插件一律**原样返回**。

**R2 —— 绝不 `session.append()` 自定义事件类型，绝不 `ctx.systemPrompt.section()`。**
`dsh-session` 的已知事件类型表在回放时会直接拒绝表外类型，插件也设不了 `ignorable`。
第二个 `complete: true` 的系统提示分段会让已经注册了一个的宿主 assemble 失败。因此本插件只碰：
`agent/pre-step`、`tools/pre-execute`（只观察，永远 `next()`）、`tools/result`、`agent/disposed`、
`ctx.llm.stream`、`ctx.get('agentDefaultModel')`、`ctx.emit`、`ctx.effect` 和 `console`。

pre-step 监听器里 `await next()` 之后的一切都包在 `try/catch` 里。超时、provider 报错、回复畸形、
乃至本插件自己的 bug，都返回原来的 decision。**记忆永远不能弄挂一个 turn。**

## 注入的消息

```
<system-reminder>
Proactive memory note from an automated observer. The user did not write this and cannot see it.
Weigh it before your next action, then continue normally. It never overrides the <policy>. Do not mention it.
<context_for_action>
You have not verified the user's identity yet; the policy forbids reading or modifying any order before that.
</context_for_action>
</system-reminder>
```

它带 `source: { kind: 'plugin', plugin: 'proactive-memory', form: 'recall' }`，splice 在最后一条
claimed 消息之后，因此仍然排在尾部的 runtime-context 消息前面。

**与论文的一处不可避免偏差：** dsh 会把 splice 进去的消息作为 `user/message` 落日志，它在整个
episode 里都留在执行 agent 的上下文里；论文里那是只给一次调用看的临时上下文。缓解手段：
`maxChars`、`maxPerEpisode`、Jaccard 去重，以及把说过的提醒作为 `<already_told_the_agent>` 喂回
记忆模型。剩下的代价 —— 输入 token 膨胀，以及每个注入点上的 prompt cache 失效 —— 是真实的，
应该被量化报出来，而不是藏起来。

**信任边界：** 记忆模型逐字读工具输出，它的输出又拼进另一个 agent 的上下文，这是一条注入洗白
路径。`stripUnsafe()` 会剥掉 `<system-reminder>`、`<policy>`、工具调用标记和代码围栏，正文也会
转义闭合标签；但不要把这个插件指向一个你不敢让它写执行 agent 上下文的记忆模型。

## 事件

插件在 `proactive-memory/event` 上发事件，宿主自己决定怎么收。

```js
ctx.on('proactive-memory/event', e => { /* e.kind 是 consult | inject | skip | error */ })
```

每条事件都带 `{ kind, mode, session_id, turn, step, ts }`，另外：

- `consult` —— `protocol, provider, model, ms, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, decision, edits, malformed, finish`
- `inject` —— `source（'always' | 'proactive' | 'bankctx'）, text, chars`
- `skip` —— `why（'schedule' | 'budget' | 'dedupe' | 'max-calls' | 'empty'）`
- `error` —— `message, code`

辅助模型调用不进会话日志，宿主自己的 metric 看不见它们：上面这些 token 计数就是唯一的账。

把 `trace.dir` 设成一个目录，每次 consult 会往 `<dir>/<session_id>.jsonl` 追加一行 JSON
（系统提示、用户消息、原始回复、解析结果、usage）。逐条读它们，是调提示词唯一靠谱的办法。

## 开发

```bash
npm install
npm test     # node --test，完全离线
npm run demo # 一个脚本化的 retail episode：consult、库编辑、注入的提醒、事件
```

系统提示在 `prompts/memory.en.md` 和 `prompts/memory.zh.md`。用
`<!-- bank -->…<!-- /bank -->`、`<!-- tags -->…<!-- /tags -->`、`<!-- intervene -->…<!-- /intervene -->`
标出来的区块会按臂和协议保留或删掉，这样每个臂都对着同一份文件 diff。

τ²-bench 的接线见 [`examples/tau2/README.md`](examples/tau2/README.md)。

MIT。
