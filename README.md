# dsh-plugin-proactive-memory

A [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin. Inside **one task episode**, a cheap
"memory model" watches the executor agent step by step. Before each of the executor's model requests
the plugin

1. maintains a private bank `{status, knowledge[], procedural[]}` the executor never sees, and
2. decides to stay silent or to splice **one** short reminder in front of the executor's next request.

The executor's system prompt, tools and decoding are untouched, and the memory model's own tools are
never registered with the host's tool runtime. There is no cross-episode persistence in v0.1.

The arms mirror the ablations of *Proactive Memory* (arXiv 2607.08716) — clause by clause in
[`docs/paper-fidelity.md`](docs/paper-fidelity.md).

> 中文见 [README.zh.md](README.zh.md)。

## Why

The paper's own ablation, not its headline, is what makes this worth replicating cheaply. On its
τ²-bench micro average: bank-in-context **58.6**, inject-only **60.8**, Mem0 **60.8**, the full
memory agent **61.2** — and always-inject, one fixed reminder with **no memory model at all**,
**61.5**. The gain comes from the *interruption*, not from the *storage*.

So the free arm is first-class here (`mode: always`, zero extra model calls), every ablation is one
config field rather than a fork, and each arm can report its own tokens and latency next to its
reward. The open question is whether the effect survives a memory model far cheaper than the
paper's, on a different harness and a different executor.

Those are the paper's numbers, from the paper's setup. **This plugin has no benchmark results yet** —
only offline tests and a scripted smoke run.

## Install

Not published to npm yet. Today: clone it beside the profile that will mount it, and install its own
dependencies — Node resolves a plugin's bare imports (`@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery`)
from the plugin's **real** directory, not from the host's `node_modules`.

```bash
git clone <this repo> dsh-plugin-proactive-memory
cd dsh-plugin-proactive-memory && npm install
```

Then mount the source by a path relative to the profile patch file:

```yaml
- insert:
    - id: proactive-memory
      name: '../../path/to/dsh-plugin-proactive-memory/src/index.mjs'
      config:
        mode: proactive
        model: { provider: openrouter, model: deepseek/deepseek-v4-flash }
```

Insert it **after** any tool-policy plugin (a write-confirmation gate) and **before** the transport
plugin that drives the loop. A second copy of `@deepseek-ai/dsh-llm` in the process is harmless: its
factories return plain objects and nothing uses `instanceof`.

Peer dependencies are dsh `0.1.1-rc.2` (`dsh-llm`, `dsh-agent`, `dsh-tools`) and `@deepseek-ai/cordis ^4.0.1`.

Once published, the same wiring is one command — `package.json` declares `dsh.bundle.patch`, so the
bundled [`cordis.patch.yml`](cordis.patch.yml) is applied to the profile:

```bash
dsh plugin add dsh-plugin-proactive-memory
```

## Arms

| `mode` | memory-model calls | what it does | paper ablation |
| --- | --- | --- | --- |
| `off` | 0 | registers no listeners at all | baseline |
| `always` | 0 | one fixed reminder (`alwaysText`) on every scheduled step | always-inject (61.5) |
| `proactive` | 1 / scheduled step | full mechanism: maintain the bank, then decide | full agent (61.2) |
| `proactive-nobank` | 1 / scheduled step | decide only; no bank is built or sent | inject-only (60.8) |
| `bankctx` | 1 / scheduled step | maintain the bank, inject the rendered bank instead of a note | bank-in-context (58.6) |

`always` costs nothing on the memory side and in the paper it matched the curated arm. Run it before
paying for anything else. `bankctx` injects the bank only when it has **changed** since the last
injection — otherwise every step would repeat the same block verbatim.

Budget and dedupe (`intervention.maxPerEpisode`, `intervention.dedupeJaccard`) are deliberately
**not** applied to `always`: repeating one line every step is what that arm is.

## Configuration

Every field is optional. An unknown `mode` or `protocol` throws at load — a typo in an experiment arm
must be loud — while every out-of-range number is clamped rather than thrown.

| key | default | meaning |
| --- | --- | --- |
| `mode` | `off` | `off \| always \| proactive \| proactive-nobank \| bankctx` — the arm. `off` registers nothing at all. |
| `model.provider` | `''` | Provider of the memory model. If either this or `model.model` is empty, the plugin falls back to the executor's `agentDefaultModel` and warns **loudly**, once: a silent fallback would merge two arms into one. |
| `model.model` | `''` | Memory model id. |
| `model.temperature` | `0` | Clamped to 0–2. |
| `model.maxTokens` | `512` | Clamped to 16–8192. A `max-tokens` finish counts as a failure, not a stop (see below). |
| `model.timeoutMs` | `20000` | Per-consult deadline, clamped to 500–300000. On timeout the step proceeds unchanged. |
| `protocol` | `text` | `text` (one round-trip, tag grammar) or `tools` (four real tool schemas). |
| `schedule.firstStep` | `true` | Consult on the first counted pre-step of the episode. |
| `schedule.everySteps` | `1` | Consult every n-th counted pre-step after that. Clamped to 1–1000. |
| `schedule.maxCallsPerEpisode` | `40` | Hard cap on memory-model calls per episode (model-calling arms only). Clamped to 0–10000. |
| `window.messages` | `8` | Transcript tail shown to the memory model — the paper's k=8. Clamped to 1–200. |
| `window.toolResultChars` | `800` | Middle-truncation budget for each message text and tool result. |
| `window.argChars` | `400` | Middle-truncation budget for tool-call arguments. |
| `bank.maxKnowledge` | `12` | Cap on `knowledge` entries; over the cap the oldest is dropped and reported. |
| `bank.maxProcedural` | `12` | Same for `procedural`. |
| `bank.maxEditsPerCall` | `6` | Edits accepted per consult; the rest are dropped and reported as malformed. |
| `intervention.maxChars` | `400` | The note is clipped at a word boundary to this length before framing. Clamped to 20–20000. |
| `intervention.maxPerEpisode` | `12` | Injections per episode. Not applied to `always`. |
| `intervention.dedupeJaccard` | `0.8` | A note whose normalized-token Jaccard against any earlier note of this episode reaches this is suppressed. Not applied to `always`. |
| `alwaysText` | a generic three-check reminder | The fixed reminder used by `mode: always`. Domain-free on purpose. |
| `locale` | `en` | Picks `prompts/memory.<locale>.md` (`en` or `zh`). |
| `promptFile` | `''` | Absolute path overriding the bundled prompt. |
| `writeTools` | `[]` | Tool names that count as "about to write": the last one seen is reported to the next consult as `<about_to_act>`. Empty means the memory model reads `unknown`. |
| `trace.dir` | `''` | Directory for the per-consult JSONL trace. Empty disables it. |
| `trace.console` | `true` | One console line per inject / skip / error. |

## Protocols

`protocol: text` (default) — one round-trip. The memory model reports bank edits as tags and ends
with its decision:

```
<memory_update_status>one sentence</memory_update_status>
<memory_save_knowledge id="k1">fact</memory_save_knowledge>
<memory_save_procedural id="p1">rule, phrased as an instruction</memory_save_procedural>
<memory_delete id="k2"/>
<no_intervention/>              …or…
<context_for_action>one concrete thing to do or check before acting</context_for_action>
```

The parser is forgiving about prose and casing around the tags and strict about the payload: a
malformed edit is dropped and reported, never guessed. The **last** of `<no_intervention/>` /
`<context_for_action>` wins, so a model that reasons out loud before committing still lands where it
meant to. Reusing an id overwrites that entry in place.

`protocol: tools` — the paper's shape: four real tool schemas (`memory_update_status`,
`memory_save_knowledge`, `memory_save_procedural`, `memory_delete`) offered to the memory model, up
to 4 rounds, with tool results synthesized locally. Nothing is dispatched, `ctx.tools` is never
touched, and the executor's tool table is unchanged. It costs several round-trips per executor step;
it exists to show, once, that the cheap protocol loses nothing. A text-only reply is still parsed for
tags, so both dialects are accepted.

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
spliced right after the last claimed message, so it still precedes a trailing runtime-context message
the loop appended.

## Two hard rules

**R1 — never `agent.inject()`, and never splice into an empty step.** `agent.inject()` queues into
`inbox.nextStep`, and the loop only breaks out of the step loop when `turnEnds && nextStep.length === 0`
(`dsh-agent-loop:571`); a turn that should have ended gets one more model request, so one user turn
produces two assistant messages. The same hazard applies to splicing: at `step === 0` an empty
decision completes the turn (`dsh-agent-loop:543-546`), so adding a message there manufactures a
request that would not otherwise happen. This plugin returns the decision **unchanged** whenever
`decision.kind === 'reject'`, the claimed list is empty, or `decision.messages` is empty. A host can
check the rule offline: exactly one assistant message per user turn, always.

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
closing tags the parser needs, so a note the model was still writing would otherwise be recorded as a
deliberate `<no_intervention/>` (and under `protocol: tools` the truncated round's tool-call blocks
are dropped by `BlockAssembler`, losing its bank edits). It raises an `error` event instead — if a run
shows many of those, raise `model.maxTokens`.

## Events (the host contract)

The plugin emits on `proactive-memory/event` and nothing else; a host collects it however it likes. A
listener that throws cannot break a turn.

```js
ctx.on('proactive-memory/event', e => { /* e.kind is consult | inject | skip | error */ })
```

Every event carries `{ kind, mode, ts, session_id, turn, step }` plus:

| kind | fields | when |
| --- | --- | --- |
| `consult` | `protocol, provider, model, ms, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, decision ('intervene' \| 'no_intervention'), edits (applied), malformed (count), finish` | one per memory-model call. Never emitted by `always`, which makes none. |
| `inject` | `source ('always' \| 'proactive' \| 'bankctx'), text (the whole framed message), chars` | one per spliced reminder. |
| `skip` | `why ('schedule' \| 'max-calls' \| 'budget' \| 'dedupe' \| 'empty')` | a step where nothing was injected for a reason worth counting. A plain no-intervention is *not* a skip: it is the `consult` event's `decision`. |
| `error` | `message, code (the error name, or 'listener')` | a failed consult, or a bug in the plugin; the step proceeded unchanged. |

Ordering within one step: `consult` first (if any), then at most one of `inject` / `skip`.
`session_id` is `String(agent.id)`, which is also how episodes are kept apart — state is per-agent,
never module-level, so concurrent sessions in one process cannot bleed into each other.

Auxiliary model calls never enter the session log, so a host's own metrics cannot see them: the token
counts above are the only accounting there is. Price them with the same table the host uses for the
executor.

On teardown the plugin logs one line:
`[proactive-memory:<mode>] stats {"consults":…,"injects":…,"skips":…,"errors":…}`.

## Trace format

Set `trace.dir` to append one JSON line per consult to `<dir>/<session_id>.jsonl`. Writes are chained
per file and fire-and-forget; any failure is swallowed, because tracing must not cost a turn.

```jsonc
{ "turn": 3, "step": 1,
  "system": "…the exact system prompt for this arm…",
  "user":   "<task>…</task>\n\n<memory_bank>…</memory_bank>\n\n<already_told_the_agent>…</already_told_the_agent>\n\n<transcript step=\"1\" window=\"8\">[…]</transcript>\n\n<about_to_act>…</about_to_act>",
  "reply":  "…the raw text of the reply…",
  "parsed": { "decision": "intervene", "note": "…", "edits": 2, "malformed": [] },
  "usage":  { "inputTokens": 1420, "outputTokens": 96 }, "ms": 812, "injected": true }
```

`injected` is the final verdict, after budget, dedupe and stripping — a line with
`decision: "intervene"` and `injected: false` is exactly a suppressed note. Only model-calling arms
write traces (`always` never consults). Reading these one by one is how the prompt gets tuned; they
contain verbatim transcript excerpts, so treat the directory as user data.

## Trust boundary

The memory model reads tool output verbatim and its output is concatenated into another agent's
context. That is an injection-laundering path. `stripUnsafe()` removes framing the executor would
read as structure (`<system-reminder>`, `<policy>`, `<instructions>`, tool-call and tool-result
markup, the plugin's own `<memory_*>` / `<context_for_action>` tags, code fences); what survives is
clipped to `intervention.maxChars` and escaped the way dsh escapes an instruction-frame body; a note
that strips to nothing is dropped instead of injected.

That is mechanical defense, not a sanitizer. In a benchmark the transcript is trusted data; in an
adversarial deployment treat the note as untrusted, and do not point this plugin at a memory model
you would not trust with the executor's context.

## Known deviations from the paper

The clause-by-clause table is in [`docs/paper-fidelity.md`](docs/paper-fidelity.md); the four that
matter:

- **The reminder persists.** dsh logs a spliced pre-step message as a `user/message`, so it stays in
  the executor's context for the rest of the episode, whereas the paper's reminder is temporary
  context for one call. `agent/request` cannot mutate messages — a request must be a pure function of
  the session log — so there is no ephemeral path. Mitigated by `maxChars`, `maxPerEpisode`, Jaccard
  dedupe, and by feeding the notes back to the memory model as `<already_told_the_agent>`. The
  residual cost — input-token inflation on the executor and a prompt-cache miss from each injection
  point onward — is real, and belongs in the results table rather than in a footnote.
- **`protocol: text` is the default**, one round-trip instead of the paper's tool calls. Several tool
  round-trips per executor step is the dominant cost of the mechanism. `protocol: tools` reproduces
  the paper's shape and exists to check, once, that the cheap protocol loses nothing.
- **No cross-episode bank.** Same as the paper, whose mechanism is within-episode; and v0.1 stores
  nothing at all — the bank lives in a `Map` keyed by `agent.id` and is dropped on `agent/disposed`.
- **Prompted, not trained** — same as the paper. Worth restating because the calibration of a *cheap*
  memory model is the main risk here: over-interruption is why `maxPerEpisode` and dedupe exist.

## Development

```bash
npm install
npm test     # node --test, 60 tests, entirely offline: no API key, no dsh runtime
npm run demo # a scripted retail episode: the consult, the bank edits, the injected reminder, the events
```

`prompts/memory.en.md` and `prompts/memory.zh.md` hold the system prompts. Regions marked
`<!-- bank -->…<!-- /bank -->`, `<!-- tags -->…<!-- /tags -->` and `<!-- intervene -->…<!-- /intervene -->`
are kept or dropped per arm and protocol, so every arm diffs against the same file.

Layout: `src/index.mjs` (the listeners, and the only stateful module), `config.mjs` (schema and
clamping), `window.mjs` (what the memory model is allowed to see), `bank.mjs`, `memory-agent.mjs`
(the auxiliary call), `protocol-text.mjs` / `protocol-tools.mjs` (the parsers), `inject.mjs`
(stripping, framing, dedupe), `events.mjs`, `trace.mjs`.

See [`examples/tau2/README.md`](examples/tau2/README.md) for a worked harness integration on
τ²-bench: the mount, the arms, the flags, and the columns a report should carry.

## License

MIT — see [LICENSE](LICENSE).
