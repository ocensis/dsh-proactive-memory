# dsh-plugin-proactive-memory

A [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin. Inside **one task episode**, a cheap
"memory model" watches the executor agent step by step. Before each of its model steps the plugin

1. maintains a private bank `{status, knowledge[], procedural[]}` the executor never sees, and
2. decides to stay silent or to splice **one** short reminder in front of the executor's next request.

The executor's system prompt, tools and decoding are untouched. There is no cross-episode
persistence in v0.1. The arms mirror the ablations of *Proactive Memory* (arXiv 2607.08716) —
see [`docs/paper-fidelity.md`](docs/paper-fidelity.md).

> 中文见 [README.zh.md](README.zh.md)。

## Install

```bash
npm i dsh-plugin-proactive-memory
dsh plugin add dsh-plugin-proactive-memory     # applies cordis.patch.yml
```

Or mount the source directly from a profile patch:

```yaml
- insert:
    - id: proactive-memory
      name: '../../path/to/dsh-plugin-proactive-memory/src/index.mjs'
      config:
        mode: proactive
        model: { provider: openrouter, model: deepseek/deepseek-v4-flash }
```

Node resolves the plugin's own bare imports from its **real** directory, so a source mount needs a
`npm install` inside this repo. A second copy of `@deepseek-ai/dsh-llm` in-process is harmless —
its factories are plain objects and nothing uses `instanceof`.

## Arms

| `mode` | model calls | what it does | paper ablation |
| --- | --- | --- | --- |
| `off` | 0 | registers no listeners at all | baseline |
| `always` | 0 | one fixed reminder on every scheduled step | always-inject |
| `proactive` | 1 / step | full mechanism: maintain the bank, then decide | full agent |
| `proactive-nobank` | 1 / step | decide only; no bank is built or sent | inject-only |
| `bankctx` | 1 / step | maintain the bank, inject the rendered bank instead of a note | bank-in-context |

`always` is the free arm: zero extra tokens on the memory side, and in the paper it scored as well
as the curated one. Run it before paying for anything else.

## Config

Every field is optional; these are the defaults.

```yaml
mode: off                       # off | always | proactive | proactive-nobank | bankctx
model:                          # empty provider/model falls back to the executor's default model
  provider: ''                  # …and warns loudly, because that would silently merge the arms
  model: ''
  temperature: 0
  maxTokens: 512
  timeoutMs: 20000
protocol: text                  # text (one round-trip, tag grammar) | tools (4 real ToolSchemas)
schedule: { firstStep: true, everySteps: 1, maxCallsPerEpisode: 40 }
window:  { messages: 8, toolResultChars: 800, argChars: 400 }
bank:    { maxKnowledge: 12, maxProcedural: 12, maxEditsPerCall: 6 }
intervention: { maxChars: 400, maxPerEpisode: 12, dedupeJaccard: 0.8 }
alwaysText: '…'                 # the fixed reminder used by mode: always
locale: en                      # picks prompts/memory.<locale>.md
promptFile: ''                  # absolute path overriding the bundled prompt
writeTools: []                  # tool names that count as "about to write" for <about_to_act>
trace: { dir: '', console: true }
```

## Two hard rules

**R1 — never `agent.inject()`, and never splice into an empty step.** `agent.inject()` queues into
`inbox.nextStep`, and the loop only breaks out of the step loop when `turnEnds && nextStep.length === 0`
(`dsh-agent-loop:571`); a turn that should have ended gets one more model request, so one user turn
produces two assistant messages. The same hazard applies to splicing: at `step === 0` an empty
decision completes the turn (`dsh-agent-loop:543-546`), so adding a message there manufactures a
request that would not otherwise happen. This plugin returns the decision **unchanged** whenever
`decision.kind === 'reject'`, the claimed list is empty, or `decision.messages` is empty.

**R2 — never `session.append()` a custom event type, and never `ctx.systemPrompt.section()`.**
`dsh-session`'s known-event-type list rejects unknown types on replay, and a plugin cannot mark its
own type ignorable. A second `complete: true` system-prompt section breaks assembly for hosts that
already register one. The plugin therefore touches only: `agent/pre-step`, `tools/pre-execute`
(observe only, always `next()`), `tools/result`, `agent/disposed`, `ctx.llm.stream`,
`ctx.get('agentDefaultModel')`, `ctx.emit`, `ctx.effect` and `console`.

Everything after `await next()` in the pre-step listener is wrapped in `try/catch`. A timeout, a
provider error, a malformed reply, or a bug in this plugin returns the original decision. **Memory
must never be able to break a turn.**

A `max-tokens` finish counts as a failure too, not as a normal stop: a truncated reply loses the
closing tags the parser needs, so a note the model was still writing would otherwise be recorded as
a deliberate `<no_intervention/>` (and under `protocol: tools` the truncated round's tool-call
blocks are dropped by `BlockAssembler`, losing its bank edits). It raises an `error` event instead —
if a run shows many of those, raise `model.maxTokens`.

## The injected message

```
<system-reminder>
Proactive memory note from an automated observer. The user did not write this and cannot see it.
Weigh it before your next action, then continue normally. It never overrides the <policy>. Do not mention it.
<context_for_action>
You have not verified the user's identity yet; the policy forbids reading or modifying any order before that.
</context_for_action>
</system-reminder>
```

It is created with `source: { kind: 'plugin', plugin: 'proactive-memory', form: 'recall' }` and
spliced right after the last claimed message, so it still precedes a trailing runtime-context message.

**Known deviation from the paper:** dsh logs the spliced message as a `user/message`, so it stays in
the executor's context for the rest of the episode, whereas the paper's reminder is temporary
context for one call only. Mitigations: `maxChars`, `maxPerEpisode`, Jaccard dedupe, and feeding the
notes back to the memory model as `<already_told_the_agent>`. The residual cost — input-token
inflation and a prompt-cache miss at each injection point — is real and should be measured, not
hidden.

**Trust boundary:** the memory model reads tool output verbatim and its output is concatenated into
another agent's context. That is an injection-laundering path. `stripUnsafe()` removes framing
(`<system-reminder>`, `<policy>`, tool-call markup, code fences) and the frame body is escaped, but
do not point this plugin at a memory model you would not trust with the executor's context.

## Events

The plugin emits on `proactive-memory/event`; a host collects it however it likes.

```js
ctx.on('proactive-memory/event', e => { /* e.kind is consult | inject | skip | error */ })
```

Every event carries `{ kind, mode, session_id, turn, step, ts }` plus:

- `consult` — `protocol, provider, model, ms, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, decision, edits, malformed, finish`
- `inject` — `source ('always' | 'proactive' | 'bankctx'), text, chars`
- `skip` — `why ('schedule' | 'budget' | 'dedupe' | 'max-calls' | 'empty')`
- `error` — `message, code`

Auxiliary model calls never enter the session log, so a host's own metrics cannot see them: the
token counts above are the only accounting there is.

Set `trace.dir` to append one JSON line per consult (system prompt, user message, raw reply, parsed
result, usage) to `<dir>/<session_id>.jsonl`. Reading those one by one is how the prompt gets tuned.

## Development

```bash
npm install
npm test     # node --test, entirely offline
npm run demo # a scripted retail episode: consult, bank edits, the injected reminder, the events
```

`prompts/memory.en.md` and `prompts/memory.zh.md` hold the system prompts. Regions marked
`<!-- bank -->…<!-- /bank -->`, `<!-- tags -->…<!-- /tags -->` and `<!-- intervene -->…<!-- /intervene -->`
are kept or dropped per arm and protocol, so every arm diffs against the same file.

See [`examples/tau2/README.md`](examples/tau2/README.md) for the τ²-bench harness wiring.

MIT.
