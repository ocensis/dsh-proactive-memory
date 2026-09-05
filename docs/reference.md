# Reference

Everything the short [README](../README.md) leaves out: the full configuration table, the two
protocols, the exact injected message, the two hard rules and why they hold against the dsh loop,
the event contract for hosts, the trace format, the trust boundary and the known deviations from the
paper. The paper mapping itself is in [paper-fidelity.md](paper-fidelity.md); a worked harness
integration is in [../examples/tau2/README.md](../examples/tau2/README.md).

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
| `schedule.firstStep` | `true` | Consult on the first counted pre-step of the episode — step 1 of turn 1. |
| `schedule.everySteps` | `1` | Consult every n-th counted pre-step after that. Clamped to 1–1000. One counted pre-step is one model step, mid-turn steps included. |
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
| `writeTools` | `[]` | Tool names that count as a write. Every one seen since the previous consult is reported to the next one as `<recent_writes>`; they have already executed. Empty means the memory model reads `unknown` rather than `(none)`. |
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
the loop appended. On a mid-turn step nothing was claimed, so it lands at index 0 — still in front of
that runtime-context message.

## Two hard rules

**R1 — never `agent.inject()`, and never splice into a step that would not otherwise run.** The
reminder goes in before every model step; it never creates one. `agent.inject()` queues into
`inbox.nextStep`, and the loop only breaks out of the step loop when `turnEnds && nextStep.length === 0`
(`dsh-agent-loop:571`); a turn that should have ended gets one more model request, so one user turn
produces two assistant messages. Splicing carries the same hazard wherever an *empty decision* is
what ends the turn — at `phase.step === 0` (`dsh-agent-loop:542-545`) and after `turnEnds` is set
(`:541`). So the question at a pre-step is never "is this step real" but "would this step run if I
returned the decision untouched".

The plugin returns the decision **unchanged**, with no event and no consult, in exactly three cases:

| guarded case | why |
| --- | --- |
| `decision.kind === 'reject'` | the loop is not entering a step at all. |
| step 1 of a turn whose decision is empty (nothing claimed from the inbox, or an earlier pre-step listener emptied the batch) | `:542-545` completes the turn without a request; a spliced message would manufacture one. |
| any pre-step reached after the turn already ended — the previous reply had no tool calls, or hit max-tokens | it is only reached because `inbox.nextStep` was non-empty (steering, inject), and `:541` breaks on an empty decision; a splice resurrects a finished turn into a second assistant message. |

The last two are counted as `guards` in the teardown line, never as `skip` events: they are the
normal shape of a turn, not an anomaly. The trailing guarded pre-step of every turn is the bulk of
that count.

Everything else is spliced, and that includes the case v0.1 got wrong. A **mid-turn** step —
`step > 1`, reached because the previous reply made tool calls — is safe: `step()` logs those tool
results straight into the session (`:685`) and returns `null`, so `turnEnds` is `null` and neither
`:541` nor `:542-545` can fire; the loop runs this step whatever the pre-step returns. The claimed
list is empty there and `decision.messages` holds at most a runtime-context message, so guarding on
"claimed is empty" alone — as v0.1 did — silently dropped every step after the first of each turn:
one consult per *user turn* instead of one per *model request*, with no event to show for it.
Splicing there adds no request that would not happen anyway, and the reminder is logged at
`step/start` right after the tool results, the position dsh's own runtime-context message takes.

The plugin tells the two apart by the session log: mid-turn ⇔ its last message is a tool result
(`role: 'user'`, `source.kind: 'tool'`). After a completed turn the last message is the assistant
reply — no tool-call blocks, or blocks that max-tokens cut before any result could follow — which is
not a tool-result message either way, so the test correctly says "not mid-turn".

A host can still check the rule offline: exactly one assistant message per user turn, always.

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
`[proactive-memory:<mode>] stats {"consults":…,"injects":…,"skips":…,"errors":…,"guards":…}`.
`guards` counts the pre-steps rule R1 returned untouched with no event at all (the last two rows of
its table) — mostly the trailing pre-step of each turn, a step that would not have run. Roughly one
per user turn is healthy; `consults + skips` climbing by one per *model request* is the cadence.

## Trace format

Set `trace.dir` to append one JSON line per consult to `<dir>/<session_id>.jsonl`. Writes are chained
per file and fire-and-forget; any failure is swallowed, because tracing must not cost a turn.

```jsonc
{ "turn": 3, "step": 1,
  "system": "…the exact system prompt for this arm…",
  "user":   "<task>…</task>\n\n<memory_bank>…</memory_bank>\n\n<already_told_the_agent>…</already_told_the_agent>\n\n<transcript step=\"1\" window=\"8\">[…]</transcript>\n\n<recent_writes>…</recent_writes>",
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
