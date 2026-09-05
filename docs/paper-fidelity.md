# Fidelity to *Proactive Memory* (arXiv 2607.08716)

Item by item: what the paper does, what this plugin does, whether they match, and why when they do
not. Everything here describes **v0.1**, which has been tested offline but not yet run as an
experiment — there are no results of ours to report.

Reference implementation: `github.com/yifannnwu/proactive-memory-agent`
(`src/memory_agent/memory/memory_agent.py` — `PHASE1_SYSTEM`, `PHASE2_SYSTEM`, the four tool schemas).

## The mechanism

| # | Paper mechanism | This plugin | Same? | Why |
| --- | --- | --- | --- | --- |
| 1 | A separate memory model watches one task episode; it never talks to the user and never calls the executor's tools. | Same: `ctx.llm.stream` on its own route, no tool of the executor is ever invoked, nothing is spoken to the user. | Same | The core claim under test. |
| 2 | Consulted at the first step and then at every step. | Same by default; `schedule.firstStep`, `schedule.everySteps` and `schedule.maxCallsPerEpisode` make the cadence an axis. | Same (defaults) | The interval is itself an ablation worth having, and the cap keeps a runaway episode from spending unboundedly. |
| 3 | Sees the task, the last k=8 messages, and its own bank. | Same: `<task>`, `<transcript window="8">`, `<memory_bank>`, with the transcript JSON-framed and tool results middle-truncated to 800 chars. | Same, different framing | Transcript text can contain anything; JSON is a delimiter it cannot break out of. Truncation bounds the cost of the auxiliary call. |
| 4 | Bank `B = (status, knowledge, procedural)`. | Same three parts, same meanings: one-sentence status, facts costly to re-derive, one domain rule broken or about to be broken (phrased as an instruction). | Same | — |
| 5 | Four bank operations: `memory_update_status`, `memory_save_knowledge`, `memory_save_procedural`, `memory_delete`. | Same four, with the same semantics (reusing an id overwrites in place; delete removes by id). | Same | — |
| 6 | The operations are issued as real tool calls. | `protocol: tools` does exactly that (4 schemas, up to 4 rounds, results synthesized locally). The **default** is `protocol: text`: one round-trip, the same four operations as `<memory_*>` tags. | Different default | Several round-trips per executor step is the dominant cost of the mechanism. The paper's shape stays available to check, once, that the cheap protocol loses nothing. |
| 7 | Two phases per consult: maintain the bank, then decide whether to interrupt. | Same two phases, in one system prompt whose regions are kept or dropped per arm (`<!-- bank -->`, `<!-- tags -->`, `<!-- intervene -->`). | Same | One prompt file per locale means every arm diffs against the same text. |
| 8 | Phase 2 emits `<no_intervention/>` or one `<context_for_action>` note. | Same grammar. The last decision tag in the reply wins; an empty note is treated as no intervention. | Same | A model that reasons out loud before committing should land where it meant to, not where it thought aloud. |
| 9 | The note is injected as **temporary context** for the executor's next call only. | The note is spliced into the executor's next request as a `user/message` — dsh logs it, so it stays in context for the rest of the episode. | **Different** | dsh has no ephemeral path: a spliced pre-step message is logged (`dsh-agent-loop:554`), and `agent/request` cannot mutate messages because a request must be a pure function of the session log. Mitigated by `intervention.maxChars` / `maxPerEpisode` / Jaccard dedupe and by replaying past notes to the memory model as `<already_told_the_agent>`; the residual input-token inflation and prompt-cache invalidation are costs to measure, not to hide. |
| 10 | The executor is untouched: same system prompt, same tools, same decoding. | Same. The memory tools never reach `ctx.tools`; the plugin registers no system-prompt section and appends nothing to the session log (rule R2). | Same | Any change to the executor would confound the arm. |
| 11 | No cross-episode persistence. | Same, and stronger: the bank lives in a `Map` keyed by `String(agent.id)`, dropped on `agent/disposed`, never on disk, never module-level. | Same | Module-level state would let concurrent sessions in one process bleed into each other. |
| 12 | The memory model is prompted, not trained. | Same. | Same | — |
| 13 | Memory model: a strong frontier model. Executor: a strong frontier model. | Both are configuration. The intended run points the memory arm at a model roughly an order of magnitude cheaper, on a different harness and executor. | **Different** | That substitution is the question this replication asks. It is also the main risk: a cheap model's calibration is what `maxPerEpisode` and dedupe defend against. |

## The ablations

Paper micro-average, quoted for orientation (its setup, not ours): bank-in-context **58.6**,
inject-only **60.8**, Mem0 **60.8**, full memory agent **61.2**, always-inject **61.5**.

| Paper ablation | Arm | Same? | Notes |
| --- | --- | --- | --- |
| Full memory agent | `mode: proactive` | Same | Bank + per-step decision. |
| Always-inject (a fixed reminder, no memory model) | `mode: always` | Same | Zero memory-model calls; `alwaysText` is deliberately domain-free. Budget and dedupe are bypassed, since repeating one line every step *is* the arm. |
| Inject-only (no bank) | `mode: proactive-nobank` | Same | The `<!-- bank -->` prompt region is dropped and no `<memory_bank>` is sent, so the model has nothing to maintain and nothing to read. |
| Bank-in-context (whole bank into the executor's context) | `mode: bankctx` | Close | The bank is rendered without ids and injected **only when it changed** since the last injection. Otherwise every step would repeat an identical block, which the persistence in row 9 would make far more expensive here than in the paper. |
| No memory | `mode: off` | Same | Registers no listeners at all, so the arm costs nothing and cannot perturb a run. |

## Additions the paper does not have

Each exists because this runs in a real harness on someone's budget rather than in the paper's
setting; none of them changes the mechanism under test.

| Addition | Why |
| --- | --- |
| Fail-open everywhere: timeout, provider error, malformed reply, or a bug in the plugin returns the executor's decision unchanged and raises an `error` event. | Memory must never be able to break a turn. An experiment that crashes the executor measures the plugin's bugs, not the mechanism. |
| A `max-tokens` finish is treated as a failure, not a stop. | A truncated reply loses the closing tags, so a note the model was still writing would be recorded as a deliberate `<no_intervention/>`; under `protocol: tools` the truncated round's tool-call blocks are dropped outright, silently losing that round's bank edits. |
| Bank caps (`maxKnowledge`, `maxProcedural`, drop-oldest) and `maxEditsPerCall`. | An unbounded bank inflates every later consult, and a cheap model writes more entries than a strong one. Every drop and every rejected edit is reported as `malformed` so the cost is visible. |
| Injection budget, Jaccard dedupe, and `<already_told_the_agent>`. | Direct mitigations of row 9's persistence, and of a cheap model's tendency to over-interrupt. |
| `stripUnsafe()` + frame-body escaping + "a note that strips to nothing is dropped". | The memory model reads tool output verbatim and its note lands in another agent's context — an injection-laundering path. Mechanical defense, not a sanitizer (see the README's trust boundary). |
| `<recent_writes>`: the `writeTools` calls observed on `tools/pre-execute` since the previous consult, reported with their arguments. | A write that just ran is where a follow-up is worth the most, and its arguments are the one signal the truncated transcript window may no longer carry. The section is honest about its timing: there is no hook that sees a write *before* it executes, so it never claims to. Empty by default (`writeTools: []`), in which case the model reads `unknown`. |
| One event stream (`proactive-memory/event`) with per-consult tokens, latency and decisions, plus an optional JSONL trace of every prompt and reply. | Auxiliary calls never enter the session log, so a host's own metrics cannot see them: without this the arm has no cost accounting at all, and the prompt cannot be tuned. |
| Rule R1 (never `agent.inject()`, never splice into a step that would not otherwise run) with an offline check: exactly one assistant message per user turn. | Manufacturing an extra model request would move reward for a reason that has nothing to do with memory. The rule is a ceiling, not a schedule: mid-turn steps, which the loop runs regardless, do carry a reminder. |

## The claim worth defending

The paper's own ablation says the gain comes from the *interruption*, not the *bank*: always-inject
scored as well as the curated agent, and bank-in-context scored worse than both. This plugin is
built so that claim can be tested rather than assumed — every arm is one config field, the free arm
is first-class, and each arm reports its own dollars and latency next to its reward. A null result
where the free arm matches a paid one is still a result.
