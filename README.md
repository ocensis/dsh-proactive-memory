# dsh-proactive-memory

A [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that adds within-episode *proactive
memory* to an agent, after [Proactive Memory (arXiv 2607.08716)](https://arxiv.org/abs/2607.08716).
A cheap memory model watches the executor agent step by step; before each model step it may splice
one short reminder into the executor's context. The executor's prompt, tools and decoding are untouched.

> 中文见 [README.zh.md](README.zh.md)。

## Architecture

```
user message ──► dsh turn loop
                   │  for every model step (turn start, and after each tool result):
                   ├─ agent/pre-step ──► proactive-memory
                   │                      1. inputs  = last 8 logged messages (+ what this step claimed)
                   │                                   + this episode's key tool calls and writes, window or not
                   │                      2. consult = memory model (ctx.llm.stream, e.g. deepseek-v4-flash)
                   │                           system prompt: the domain <policy>, its only source of rules
                   │                           phase 1: edit its private bank {status, knowledge[], procedural[]}
                   │                           phase 2: <no_intervention/> | <context_for_action>note</context_for_action>
                   │                      3. splice one <system-reminder> user message before the request
                   │                           (or nothing; any failure ⇒ the step proceeds unchanged)
                   ├─ model request (executor)
                   ├─ tools/pre-execute ──► proactive-memory observes write calls (never denies)
                   ├─ tools/result ─────► proactive-memory keeps each keyTools call with its result
                   └─ tool results ──► next step
                 agent/disposed ──► bank dropped (no cross-episode state)
                 proactive-memory/event ──► host collects consults / injects / skips / errors
```

One listener on `agent/pre-step` does all the work; the bank lives in a `Map` keyed by `agent.id`.
Two rules keep it honest, with the loop line numbers in [docs/reference.md](docs/reference.md):
never `agent.inject()` or splice into a step the loop would not run anyway (R1), and never append
custom session events or system-prompt sections (R2).

The `mode` field is the experiment arm, mirroring the paper's ablations:

| `mode` | memory-model calls | what it does |
| --- | --- | --- |
| `off` | 0 | registers nothing |
| `always` | 0 | one fixed reminder before every scheduled step (the paper's always-inject) |
| `proactive` | 1 per scheduled step | maintain the bank, then decide whether to interrupt |
| `proactive-nobank` | 1 per scheduled step | decide only, no bank |
| `bankctx` | 1 per scheduled step | maintain the bank, inject the rendered bank when it changes |

Source layout: `src/index.mjs` (listeners, the only stateful module), `config.mjs`, `window.mjs`,
`bank.mjs`, `memory-agent.mjs` (the auxiliary call), `protocol-text.mjs` / `protocol-tools.mjs`
(parsers), `inject.mjs` (stripping, framing, dedupe), `events.mjs`, `trace.mjs`;
`prompts/memory.{en,zh}.md` are the system prompts.

## Run

```bash
git clone https://github.com/ocensis/dsh-proactive-memory.git
cd dsh-proactive-memory && npm install   # its own node_modules: Node resolves the plugin's imports from here
npm test       # 86 offline tests, no API key
npm run demo   # a scripted episode: consults, bank edits, the injected reminder, events
```

Mount it in a dsh profile by a path relative to the patch file, after any tool-policy plugin and
before the plugin that drives the loop:

```yaml
- insert:
    - id: proactive-memory
      name: '../../path/to/dsh-proactive-memory/src/index.mjs'
      config:
        mode: proactive
        model: { provider: openrouter, model: deepseek/deepseek-v4-flash }
        policyFile: /abs/path/to/policy.md                                   # the ONLY source of rules the memory model gets
        keyTools: [find_user_id_by_email, find_user_id_by_name_zip]          # calls whose result outlives the window
        writeTools: [cancel_pending_order, exchange_delivered_order_items]   # what counts as a write
        trace: { dir: ./memory-trace }                                       # one JSONL line per consult
```

Leave `model` empty and the plugin falls back to the executor's default model with a loud warning.
Once published, `dsh plugin add dsh-proactive-memory` applies the bundled
[`cordis.patch.yml`](cordis.patch.yml) instead.

A complete harness integration on τ²-bench (flags, arms, report columns) is in
[examples/tau2/README.md](examples/tau2/README.md); the configuration table, protocols, event
contract and trace format are in [docs/reference.md](docs/reference.md); the clause-by-clause
mapping to the paper is in [docs/paper-fidelity.md](docs/paper-fidelity.md).

No benchmark results yet: offline tests, the demo and smoke episodes on a τ²-bench harness so far.

MIT — see [LICENSE](LICENSE).
