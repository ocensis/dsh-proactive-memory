# Fidelity to *Proactive Memory* (arXiv 2607.08716)

Placeholder — the full clause-by-clause table lands with v0.1's first results. What is settled today:

## Kept

- **Episode-scoped memory agent.** A separate model watches one task, is consulted at the first step
  and then on a schedule, and sees the task, the last k=8 messages, and its own bank.
- **The bank's three parts.** `status` (one sentence), `knowledge` (facts costly to re-derive),
  `procedural` (a domain rule broken or about to be broken, phrased as an instruction).
- **The four bank operations**, as real tool schemas under `protocol: tools`:
  `memory_update_status`, `memory_save_knowledge`, `memory_save_procedural`, `memory_delete`.
- **Two phases.** Maintain the bank, then choose `<no_intervention/>` or one `<context_for_action>`.
- **The executor is untouched.** Same system prompt, same tools, same decoding. The memory tools are
  never registered with the host's tool runtime.
- **No cross-episode persistence.**
- **The ablations, as first-class arms.** `always`, `proactive-nobank` and `bankctx` are the paper's
  always-inject, inject-only and bank-in-context; they are configuration, not forks.

## Deviated, and why

| Deviation | Why |
| --- | --- |
| The reminder persists in the executor's context for the rest of the episode. | dsh logs a spliced pre-step message as a `user/message`, and `agent/request` cannot mutate messages — a request must be a pure function of the session log. Mitigated by `maxChars`, `maxPerEpisode`, Jaccard dedupe and `<already_told_the_agent>`; the residual token cost is measured rather than hidden. |
| `protocol: text` is the default (one round-trip, tag grammar) rather than tool calls. | Four tool round-trips per executor step is the dominant cost of the mechanism. `protocol: tools` reproduces the paper exactly and exists to show, once, that the cheap protocol does not lose anything. |
| The memory model is prompted, not trained. | Same as the paper. Noted because the calibration of a cheap model is the main risk: over-interruption is why `maxPerEpisode` and dedupe exist. |
| A different harness, a different executor, a cheaper memory model. | The point of the replication. The paper used a strong memory model; the question here is whether the effect survives a ~30x cheaper one — and whether the free `always` arm already captures it. |

## The claim worth defending

The paper's own ablation says the gain comes from the *interruption*, not the *bank*: always-inject
scored as well as the curated agent, and bank-in-context scored worse than both. This plugin is built
so that claim can be tested rather than assumed — every arm is one config field, the free arm is
first-class, and each arm reports its own dollars and latency next to its reward.
