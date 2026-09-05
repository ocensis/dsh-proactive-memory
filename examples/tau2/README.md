# Running the arms on τ²-bench

This is how the `tau2-dsh-exp` harness mounts the plugin. The plugin itself imports nothing from the
harness; the whole seam is one cordis event and one ~25-line sink.

## 1. Mount it

The plugin repo sits next to the harness repo and is mounted by relative path, so `npm install`
inside **this** repo is required once (Node resolves the plugin's bare imports from its real
directory).

`home/profiles/tau2-eval/cordis.patch.yml`, after the write-confirmation gate and before the
transport plugin that drives the loop:

```yaml
- id: proactive-memory
  name: '../../../../dsh-plugin-proactive-memory/src/index.mjs'
  disabled: !!js (process.env.PM_MODE ?? 'off') === 'off'
  config:
    mode: !!js process.env.PM_MODE || 'off'
    model:
      provider: !!js process.env.PM_PROVIDER || 'openrouter'
      model: !!js process.env.PM_MODEL || 'deepseek/deepseek-v4-flash'
      temperature: 0
      maxTokens: 512
      timeoutMs: 20000
    protocol: !!js process.env.PM_PROTOCOL || 'text'
    schedule:
      firstStep: true
      everySteps: !!js Number(process.env.PM_EVERY ?? 1)
      maxCallsPerEpisode: 40
    writeTools: !!js (process.env.PM_WRITE_TOOLS || '').split(',').filter(Boolean)
    trace: { dir: !!js process.env.PM_TRACE_DIR || '', console: true }

- id: memory-sink
  name: '../tau2/plugins/memory-sink.mjs'
```

Order matters twice. The gate must come **first**: our `tools/pre-execute` listener only observes,
and a call the gate denies should not be recorded as "about to act" — it is already a tool result in
the transcript. And `PM_MODE` unset or `off` disables the whole row, so the module is never even
loaded and runs that predate this plugin still reproduce.

The sink is the entire host-side integration:

```js
export const name = 'memory-sink'
export function apply(ctx) {
  ctx.on('proactive-memory/event', e => recordMemory(String(e.session_id), e))
}
```

## 2. Run an arm

```bash
./run_eval.sh --num-tasks 20 --trials 1 --gate off --memory off      --save-to base_off
./run_eval.sh --num-tasks 20 --trials 1 --gate off --memory always   --save-to mem_always
./run_eval.sh --num-tasks 20 --trials 1 --gate off --memory proactive --save-to mem_proactive
./run_eval.sh --num-tasks 20 --trials 1 --gate off --memory proactive --memory-protocol tools --memory-interval 2
```

| flag | env it exports | meaning |
| --- | --- | --- |
| `--memory <arm>` | `PM_MODE` | `off \| always \| proactive \| proactive-nobank \| bankctx` |
| `--memory-model <id>` | `PM_MODEL` | memory model id; provider is fixed to `openrouter` via `PM_PROVIDER` |
| `--memory-protocol <p>` | `PM_PROTOCOL` | `text` (default) or `tools` |
| `--memory-interval <n>` | `PM_EVERY` | consult every n-th counted step |
| — | `PM_WRITE_TOOLS` | comma-separated tool names for `<about_to_act>`; empty means it reads `unknown` |
| — | `PM_TRACE_DIR` | per-consult JSONL, set automatically for a non-`off` arm |

Start with `--memory always`. It costs nothing on the memory side, and in the paper's own ablation it
matched the curated arm — so it is the honest first question: does the *interruption* do the work,
or the *content*?

## 3. Read the results

`/health` reports the live arm, and the runner refuses to start against a bridge whose arm does not
match the flags — a stale dsh silently running `off` would quietly turn an experiment into a
duplicate baseline.

Per-simulation columns derived from the events: `mem_consults`, `mem_injects`, `mem_chars`,
`mem_tok_in`, `mem_tok_out`, `mem_cost`, plus mean reward split by *was interrupted at least once*
vs *never interrupted*. `memory_manifest.json` is written next to `results.json` with the exact arm.

The offline check for rule R1: exactly one assistant message per user turn. The report counts turns
where more than one appeared. It should always be zero — if it is not, something is injecting into an
empty step and rewards are moving for the wrong reason.

## 4. What to report

Reward is not the whole answer, and on a strong executor it may not move at all. Report alongside it:
injections per episode, input-token inflation on the **executor** (the expensive model), memory-model
dollars, and turn latency. A free arm that matches a paid one is a result.
