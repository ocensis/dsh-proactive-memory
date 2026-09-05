# dsh-plugin-proactive-memory

一个 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 插件。在**单个任务 episode 内**，一个便宜的
"记忆模型"逐步旁观执行 agent。在执行 agent 每次模型请求之前，插件会

1. 维护一个执行 agent 看不见的私有记忆库 `{status, knowledge[], procedural[]}`；
2. 决定闭嘴，或者在执行 agent 的下一次请求前面塞**一条**简短提醒。

执行 agent 的系统提示、工具、解码全都不动，记忆模型自己的工具也从不注册进宿主的工具运行时。
v0.1 没有跨 episode 持久化。

各个臂与 *Proactive Memory*（arXiv 2607.08716）的消融一一对应，逐条对照见
[`docs/paper-fidelity.md`](docs/paper-fidelity.md)。

> English: [README.md](README.md)

## 为什么值得做

值得便宜地复跑一遍的理由，是论文自己的消融，而不是它的主结果。在它的 τ²-bench micro 平均上：
全库塞上下文 **58.6**、只注入不建库 **60.8**、Mem0 **60.8**、完整记忆 agent **61.2**——
而 always-inject（一条固定提醒，**完全不用记忆模型**）是 **61.5**。
增益来自**打断**本身，不来自**存储**。

所以这里把免费臂做成一等公民（`mode: always`，零额外模型调用），每个消融都只是一个配置字段而不是一个分叉，
每个臂都能把自己的 token 和延迟和 reward 并排报出来。真正的问题是：换一套 harness、换一个执行模型、
换一个比论文便宜得多的记忆模型之后，这个效应还在不在。

上面的数字是论文的、在论文的设置下测的。**本插件目前没有任何 benchmark 结果**，只有离线测试和一次脚本化冒烟。

## 安装

还没发 npm。今天的用法：把它 clone 到要挂它的 profile 旁边，并装它自己的依赖——Node 是从插件的**真实目录**
解析它的裸 import（`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`）的，不是从宿主的 `node_modules`。

```bash
git clone <本仓库> dsh-plugin-proactive-memory
cd dsh-plugin-proactive-memory && npm install
```

然后在 profile 补丁里按相对于补丁文件的路径挂源码：

```yaml
- insert:
    - id: proactive-memory
      name: '../../path/to/dsh-plugin-proactive-memory/src/index.mjs'
      config:
        mode: proactive
        model: { provider: openrouter, model: deepseek/deepseek-v4-flash }
```

必须插在工具策略类插件（比如写前确认闸门）**之后**、驱动 loop 的传输插件**之前**。
进程里出现第二份 `@deepseek-ai/dsh-llm` 没有问题：它的工厂函数返回普通对象，没有任何 `instanceof` 判断。

peerDependencies 是 dsh `0.1.1-rc.2`（`dsh-llm`、`dsh-agent`、`dsh-tools`）和 `@deepseek-ai/cordis ^4.0.1`。

发包之后同样的接线只要一条命令——`package.json` 里声明了 `dsh.bundle.patch`，
随包带的 [`cordis.patch.yml`](cordis.patch.yml) 会被应用到 profile：

```bash
dsh plugin add dsh-plugin-proactive-memory
```

## 实验臂

| `mode` | 记忆模型调用 | 做什么 | 对应论文消融 |
| --- | --- | --- | --- |
| `off` | 0 | 一个监听器都不注册 | 基线 |
| `always` | 0 | 每个被调度到的 model step 之前塞同一条固定提醒（`alwaysText`） | always-inject（61.5） |
| `proactive` | 每个调度点 1 次 | 完整机制：先维护库，再决定 | 完整 agent（61.2） |
| `proactive-nobank` | 每个调度点 1 次 | 只做决定；不建库也不发库 | 只注入不建库（60.8） |
| `bankctx` | 每个调度点 1 次 | 维护库，注入渲染后的整个库而不是精选提醒 | 全库塞上下文（58.6） |

`always` 在记忆侧零成本，而论文里它与精选注入打平，先跑它，再考虑花钱的臂。
`bankctx` 只在库相对上次注入**变过**时才注入——否则每一步都会原样重复同一块内容。

预算和去重（`intervention.maxPerEpisode`、`intervention.dedupeJaccard`）故意**不**作用于 `always`：
每一步重复同一句话正是那个臂本身。

## 配置

所有字段可省略。`mode` 或 `protocol` 写错会直接抛错——实验臂打错字必须炸得响亮；
数字越界一律 clamp，不抛错。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `off` | `off \| always \| proactive \| proactive-nobank \| bankctx`，即实验臂。`off` 什么都不注册。 |
| `model.provider` | `''` | 记忆模型的 provider。它和 `model.model` 只要有一个为空，就回退到执行 agent 的 `agentDefaultModel`，并**大声**警告一次：静默回退会把两个臂混成一个。 |
| `model.model` | `''` | 记忆模型 id。 |
| `model.temperature` | `0` | clamp 到 0–2。 |
| `model.maxTokens` | `512` | clamp 到 16–8192。`max-tokens` 结束算失败，不算正常停止（见下）。 |
| `model.timeoutMs` | `20000` | 单次 consult 的截止时间，clamp 到 500–300000。超时则这一步原样放行。 |
| `protocol` | `text` | `text`（一次往返的标签协议）或 `tools`（四个真实工具 schema）。 |
| `schedule.firstStep` | `true` | 在 episode 的第一个计数 pre-step 上 consult。 |
| `schedule.everySteps` | `1` | 之后每 n 个计数 pre-step consult 一次。clamp 到 1–1000。一个计数 pre-step 就是一次 model step，turn 中间那些也算。 |
| `schedule.maxCallsPerEpisode` | `40` | 每个 episode 的记忆模型调用硬上限（只对要调模型的臂生效）。clamp 到 0–10000。 |
| `window.messages` | `8` | 给记忆模型看的转录尾部条数，即论文的 k=8。clamp 到 1–200。 |
| `window.toolResultChars` | `800` | 每条消息文本 / 工具结果的中间截断预算。 |
| `window.argChars` | `400` | 工具调用参数的中间截断预算。 |
| `bank.maxKnowledge` | `12` | `knowledge` 条数上限；超了丢最旧的一条并汇报。 |
| `bank.maxProcedural` | `12` | `procedural` 同上。 |
| `bank.maxEditsPerCall` | `6` | 每次 consult 接受的编辑条数，多出来的丢弃并记为畸形。 |
| `intervention.maxChars` | `400` | 注入前把提醒按词边界裁到这个长度。clamp 到 20–20000。 |
| `intervention.maxPerEpisode` | `12` | 每个 episode 的注入次数上限。不作用于 `always`。 |
| `intervention.dedupeJaccard` | `0.8` | 与本 episode 任一条旧提醒的归一化 token Jaccard 达到这个值就压掉。不作用于 `always`。 |
| `alwaysText` | 一段通用的三问提醒 | `mode: always` 用的固定提醒，故意不带任何领域信息。 |
| `locale` | `en` | 决定用 `prompts/memory.<locale>.md`（`en` 或 `zh`）。 |
| `promptFile` | `''` | 绝对路径，覆盖内置提示词。 |
| `writeTools` | `[]` | 哪些工具名算写操作。上一次 consult 以来看到的全部会作为 `<recent_writes>` 报给下一次 consult；它们都已经执行完了。留空时记忆模型看到的是 `unknown` 而不是 `(none)`。 |
| `trace.dir` | `''` | 每次 consult 的 JSONL 落盘目录，留空则关闭。 |
| `trace.console` | `true` | 每次 inject / skip / error 打一行控制台日志。 |

## 两种协议

`protocol: text`（默认）—— 一次往返。记忆模型用标签汇报库编辑，并以决定收尾：

```
<memory_update_status>一句话</memory_update_status>
<memory_save_knowledge id="k1">事实</memory_save_knowledge>
<memory_save_procedural id="p1">规则，写成祈使句</memory_save_procedural>
<memory_delete id="k2"/>
<no_intervention/>              ……或者……
<context_for_action>动手前要做或要核对的一件具体的事</context_for_action>
```

解析器对标签周围的散文和大小写很宽容，对正文很严格：畸形的编辑一律丢弃并汇报，绝不猜。
`<no_intervention/>` / `<context_for_action>` 以**最后出现**的那个为准，所以模型先出声思考再下结论也能落在它想去的地方。
复用同一个 id 就是就地覆盖那一条。

`protocol: tools` —— 论文的形态：给记忆模型四个真实工具 schema（`memory_update_status`、
`memory_save_knowledge`、`memory_save_procedural`、`memory_delete`），最多 4 轮，工具结果在本地合成。
什么都不会被真正派发，`ctx.tools` 从不被碰，执行 agent 的工具表不变。
它每个执行步要多花几次往返，存在的意义是跑一次证明便宜协议不掉分。
这个协议下的纯文本回复仍然会按标签解析，两种方言都收。

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

它带 `source: { kind: 'plugin', plugin: 'proactive-memory', form: 'recall' }`，
splice 在最后一条 claimed 消息之后，因此仍然排在 loop 追加的 runtime-context 消息之前。
turn 中间的 step 没有任何 claimed 消息，于是它落在下标 0 —— 一样排在那条 runtime-context 之前。

## 两条硬规则

**R1 —— 绝不用 `agent.inject()`，也绝不往一个本来不会跑的 step 里 splice。** 提醒放在每一次
model step 之前，但绝不制造出一次 model step。`agent.inject()` 把消息排进 `inbox.nextStep`，而
loop 只在 `turnEnds && nextStep.length === 0` 时才跳出 step 循环（`dsh-agent-loop:571`），于是本该
结束的 turn 又多一次模型请求，一个用户 turn 出现两条 assistant 消息。凡是"decision 为空即结束
turn"的位置，splice 都有同样的风险：`phase.step === 0` 时（`dsh-agent-loop:542-545`），以及
`turnEnds` 已经置位之后（`:541`）。所以只要 `decision.kind === 'reject'`，或者 claimed 列表为空
而这一步又不是 turn 中间的 step，本插件一律**原样返回**。

**turn 中间的 step**（`step > 1`，因为上一条回复调了工具才走到这里）才是那个安全、而且以前被漏掉
的情形：`step()` 已经把工具结果直接写进 session（`:685`）并返回 `null`，所以 `turnEnds` 是 `null`，
不管 pre-step 返回什么这一步都会跑；那里 claimed 列表是空的，`decision.messages` 里至多只有一条
runtime-context 消息。往里 splice 不会多出任何一次本来不存在的请求，提醒会在 `step/start` 处接在
工具结果后面落进日志 —— 正是 dsh 自己那条 runtime-context 消息所在的位置。插件靠 session 日志区分
两者：turn 中间 ⇔ 日志最后一条是工具结果（`role: 'user'`、`source.kind: 'tool'`）。v0.1 只看
claimed 列表是否为空，于是每个 turn 第一步之后的所有 step 都被静默丢掉了：变成一个用户 turn 一次
consult，而不是一次模型请求一次。

宿主仍然可以离线核这条规则：每个用户 turn 永远恰好一条 assistant 消息。

**R2 —— 绝不 `session.append()` 自定义事件类型，绝不 `ctx.systemPrompt.section()`。**
`dsh-session` 的已知事件类型表在回放时会直接拒绝表外类型，插件也设不了 `ignorable`。
第二个 `complete: true` 的系统提示分段会让已经注册了一个的宿主 assemble 失败。因此本插件只碰：
`agent/pre-step`、`tools/pre-execute`（只观察，永远 `next()`）、`tools/result`、`agent/disposed`、
`ctx.llm.stream`、`ctx.get('agentDefaultModel')`、`ctx.emit`、`ctx.effect` 和 `console`。

pre-step 监听器里 `await next()` 之后的一切都包在 `try/catch` 里。超时、provider 报错、回复畸形、
乃至本插件自己的 bug，都返回原来的 decision。**记忆永远不能弄挂一个 turn。**

`max-tokens` 也算失败，不算正常结束：回复被截断就丢了解析要用的闭合标签，模型正写到一半的建议
会被当成它主动选择了 `<no_intervention/>`（`protocol: tools` 下更糟，截断那轮的 tool-call 块会被
`BlockAssembler` 直接丢掉，那轮的改库也就没了）。所以它走 `error` 事件；一跑里这种错很多，
就把 `model.maxTokens` 调大。

## 事件（宿主契约）

插件只在 `proactive-memory/event` 上发事件，别的什么都不发；宿主自己决定怎么收。
监听器抛错也弄不挂一个 turn。

```js
ctx.on('proactive-memory/event', e => { /* e.kind 是 consult | inject | skip | error */ })
```

每条事件都带 `{ kind, mode, ts, session_id, turn, step }`，另外：

| kind | 字段 | 什么时候发 |
| --- | --- | --- |
| `consult` | `protocol, provider, model, ms, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, decision（'intervene' \| 'no_intervention'）, edits（实际生效条数）, malformed（条数）, finish` | 每次记忆模型调用一条。`always` 不调模型，因此从不发这个。 |
| `inject` | `source（'always' \| 'proactive' \| 'bankctx'）, text（整条框好的消息）, chars` | 每次 splice 提醒一条。 |
| `skip` | `why（'schedule' \| 'max-calls' \| 'budget' \| 'dedupe' \| 'empty'）` | 这一步因为某个值得计数的原因没注入。模型自己选择不打断**不算** skip，那是 `consult` 事件的 `decision`。 |
| `error` | `message, code（错误名，或 'listener'）` | consult 失败，或插件自己出 bug；这一步原样放行。 |

同一步内的顺序：先 `consult`（如果有），然后最多一条 `inject` / `skip`。
`session_id` 是 `String(agent.id)`，也正是 episode 之间隔离的键——状态按 agent 存，绝不放模块级，
所以一个进程里并发的多个会话不会串。

辅助模型调用不进会话日志，宿主自己的 metric 看不见它们：上面这些 token 计数就是唯一的账，
用宿主给执行模型算钱的同一份价格表算它。

插件退出时打一行：
`[proactive-memory:<mode>] stats {"consults":…,"injects":…,"skips":…,"errors":…,"guards":…}`。
`guards` 是被 R1 原样放行、一个事件都不发的 pre-step 数，绝大多数是每个 turn 的最后一步 —— 那一步本来就不会跑。

## 轨迹格式

把 `trace.dir` 设成一个目录，每次 consult 会往 `<dir>/<session_id>.jsonl` 追加一行 JSON。
按文件串行写、发完不等；任何失败都被吞掉，因为落轨迹绝不能搭上一个 turn。

```jsonc
{ "turn": 3, "step": 1,
  "system": "……这个臂用的确切系统提示……",
  "user":   "<task>…</task>\n\n<memory_bank>…</memory_bank>\n\n<already_told_the_agent>…</already_told_the_agent>\n\n<transcript step=\"1\" window=\"8\">[…]</transcript>\n\n<recent_writes>…</recent_writes>",
  "reply":  "……回复的原始文本……",
  "parsed": { "decision": "intervene", "note": "…", "edits": 2, "malformed": [] },
  "usage":  { "inputTokens": 1420, "outputTokens": 96 }, "ms": 812, "injected": true }
```

`injected` 是过完预算、去重和剥标签之后的最终结论——`decision: "intervene"` 且 `injected: false`
的那一行，正是一条被压掉的提醒。只有要调模型的臂才会写轨迹（`always` 从不 consult）。
逐条读它们是调提示词唯一靠谱的办法；里面有原样的转录片段，所以这个目录要当用户数据看待。

## 信任边界

记忆模型逐字读工具输出，它的输出又拼进另一个 agent 的上下文，这是一条注入洗白路径。
`stripUnsafe()` 会剥掉执行 agent 会当成结构来读的框架标记（`<system-reminder>`、`<policy>`、
`<instructions>`、工具调用与工具结果标记、插件自己的 `<memory_*>` / `<context_for_action>` 标签、
代码围栏）；剩下的正文按 `intervention.maxChars` 裁短，并照 dsh 转义指令框正文的方式转义；
剥完什么都不剩的提醒直接丢弃，不注入。

这是机械防护，不是净化器。benchmark 里转录是可信数据；真到对抗环境，就要把提醒当成不可信内容，
也不要把这个插件指向一个你不敢让它写执行 agent 上下文的记忆模型。

## 与论文的已知偏差

逐条对照表在 [`docs/paper-fidelity.md`](docs/paper-fidelity.md)，其中要紧的四条：

- **提醒是持久的。** dsh 会把 splice 进 pre-step 的消息作为 `user/message` 落日志，它在整个 episode
  里都留在执行 agent 的上下文里；论文里那是只给一次调用看的临时上下文。`agent/request` 不能改消息
  ——请求内容必须是会话日志的纯函数——所以没有临时通道。缓解手段：`maxChars`、`maxPerEpisode`、
  Jaccard 去重，以及把说过的提醒作为 `<already_told_the_agent>` 喂回记忆模型。
  剩下的代价——执行模型上的输入 token 膨胀，以及从每个注入点起的 prompt cache 失效——是真实的，
  应该进结果表，而不是当脚注。
- **默认是 `protocol: text`**，一次往返，而不是论文的工具调用。每个执行步多几次工具往返是这套机制
  最大的成本项。`protocol: tools` 复刻论文形态，存在的意义是跑一次核对便宜协议不掉分。
- **没有跨 episode 的库。** 与论文一致（它的机制本来就在 episode 内）；而且 v0.1 根本不落盘——
  库存在一个按 `agent.id` 建键的 `Map` 里，`agent/disposed` 时丢弃。
- **是提示出来的，不是训练出来的** —— 与论文一致。之所以要重申，是因为这里最大的风险恰恰是**便宜**
  记忆模型的校准：过度打断正是 `maxPerEpisode` 和去重存在的理由。

## 开发

```bash
npm install
npm test     # node --test，64 个用例，完全离线：不用 key，不用 dsh 运行时
npm run demo # 一个脚本化的 retail episode，一个 claimed step 加一个 turn 中间的 step：
             # consult、库编辑、注入的提醒、事件
```

系统提示在 `prompts/memory.en.md` 和 `prompts/memory.zh.md`。用
`<!-- bank -->…<!-- /bank -->`、`<!-- tags -->…<!-- /tags -->`、`<!-- intervene -->…<!-- /intervene -->`
标出来的区块会按臂和协议保留或删掉，这样每个臂都对着同一份文件 diff。

模块划分：`src/index.mjs`（监听器，也是唯一有状态的模块）、`config.mjs`（schema 与 clamp）、
`window.mjs`（记忆模型能看见什么）、`bank.mjs`、`memory-agent.mjs`（辅助调用）、
`protocol-text.mjs` / `protocol-tools.mjs`（解析器）、`inject.mjs`（剥标签、加框、去重）、
`events.mjs`、`trace.mjs`。

τ²-bench 上的完整接线（挂载、臂、参数、报表该有哪些列）见
[`examples/tau2/README.md`](examples/tau2/README.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
