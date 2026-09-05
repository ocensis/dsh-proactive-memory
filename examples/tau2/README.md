# Running the arms on τ²-bench

How the `tau2-dsh-exp` harness mounts this plugin, drives the arms, and reports them. The plugin
imports nothing from the harness; the whole seam is one cordis event and one ~15-line sink.

The two repos sit side by side, and the plugin is mounted by relative path, so `npm install` inside
the **plugin** repo is required once (Node resolves its bare imports from its real directory):

```
tau2/
  tau2-dsh-exp/                    the harness (bridge, profiles, run_eval.sh)
  dsh-plugin-proactive-memory/     this repo — cd here and `npm install` once
```

## 1. Mount it

In `home/profiles/tau2-eval/cordis.patch.yml`, inside the `- insert:` list, **after** the
write-confirmation gate and **before** the bridge plugin that drives the loop:

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
        # leave undefined to keep the plugin's own default (schemastery only fills undefined)
        alwaysText: !!js process.env.PM_ALWAYS_TEXT || undefined
        writeTools: !!js (process.env.PM_WRITE_TOOLS || '').split(',').filter(Boolean)
        trace:
          dir: !!js process.env.PM_TRACE_DIR || ''
          console: true

    - id: memory-sink
      name: '../tau2/plugins/memory-sink.mjs'
```

Order matters twice. The gate must come **first**: this plugin's `tools/pre-execute` listener only
observes, and a call the gate denies never executed, so it does not belong in `<recent_writes>` — it
is already a tool result in the transcript. And `PM_MODE` unset or `off` disables the whole row, so the module is never
loaded, the plugin repo need not even exist, and runs that predate it still reproduce byte for byte.

One more harness-side detail, easy to miss and expensive to debug: a gate that looks for the last
*user* message must match on `source.kind === 'user'`, not on `role === 'user'`. The reminder this
plugin splices is a `role: 'user'` message with `source.kind === 'plugin'`; a gate that counts it as
the user's turn will never find the confirmation again and will block every write forever.

The sink is the entire host-side integration:

```js
export const name = 'memory-sink'
export function apply(ctx) {
  ctx.on('proactive-memory/event', e => recordMemory(String(e?.session_id ?? 'unknown'), e))
}
```

Events go into the per-session mailbox, ride along with the `/step` response, and land in
`AssistantMessage.raw_data.memory` on the τ² side, where the report reads them.

## 2. Run an arm

```bash
cd ../dsh-plugin-proactive-memory && npm install && cd -    # once

./run_eval.sh --num-tasks 20 --trials 1 --gate off --memory off       --save-to base_off
./run_eval.sh --num-tasks 20 --trials 1 --gate off --memory always    --save-to mem_always
./run_eval.sh --num-tasks 20 --trials 1 --gate off --memory proactive --save-to mem_proactive
./run_eval.sh --num-tasks 20 --trials 1 --gate off --memory proactive --memory-protocol tools --memory-interval 2
./run_eval.sh --report mem_proactive
```

| flag | default | env it exports | meaning |
| --- | --- | --- | --- |
| `--memory <arm>` | `off` | `PM_MODE` | `off \| always \| proactive \| proactive-nobank \| bankctx`; anything else is rejected by the script. |
| `--memory-model <id>` | `deepseek/deepseek-v4-flash` | `PM_MODEL` | Memory model id. The provider is pinned to `openrouter` via `PM_PROVIDER`. |
| `--memory-protocol <p>` | `text` | `PM_PROTOCOL` | `text` or `tools`. |
| `--memory-interval <n>` | `1` | `PM_EVERY` | Consult every n-th counted step. |
| — | — | `PM_WRITE_TOOLS` | The domain's gate tools, so the gate and the memory plugin share one definition of "a write". `run_eval.sh` computes it with `tau2_env.gate_tools()` for a non-`off` arm unless it is already set in the environment; an explicit empty value means `<recent_writes>` reads `unknown`. |
| — | — | `PM_TRACE_DIR` | Set automatically for a non-`off` arm: `data/memory-trace/<--save-to>`, or a bare timestamp when `--save-to` is omitted. |
| — | — | `PM_ALWAYS_TEXT` | Overrides the fixed reminder of `mode: always`. |

Values in `home/.env` only apply when dsh is started by hand; the script's flags always win.

Start with `--memory always`. It costs nothing on the memory side, and in the paper's own ablation it
matched the curated arm — so it is the honest first question: does the *interruption* do the work, or
the *content*?

## 3. Read the results

`GET /health` reports the live arm (`memory: {mode, provider, model, protocol, every}`), and
`run_eval.py` refuses to start when it disagrees with the flags — a stale dsh still running `off`
would quietly turn an experiment into a duplicate baseline. `memory_manifest.json` is written next to
`results.json` with the exact arm, model, protocol, interval and trace directory, because
`results.json` itself has no record of them.

`report.py` prints an extra block after its usual tables, only when the trajectories actually carry
memory events (so older results print byte-identically):

- `memory arm:` — mode, memory model, protocol, as seen in the events.
- `consults=` — total, per-simulation mean, `errors=`, and consult latency mean / p95. If every
  consult failed, the block says so loudly: that run *is* a baseline, whatever the manifest claims.
- `injects=` — total, per-simulation mean, mean and total injected characters.
- `memory model tokens:` — in / out, total and per-simulation dollars, priced from the same
  OpenRouter table as the executor (auxiliary calls never enter the session log, so these numbers
  come from the plugin's own `consult` events).
- `reward:` — mean reward for simulations with ≥1 injection vs. those with none, with both n's.
- `executor input tokens per simulation` — meaningful only against a same-parameter `--memory off`
  run; the difference is the cost of persistent injections.
- `R1 check:` — printed whenever the trajectories carry `trailing_assistant_messages`, which the
  bridge computes per `/step` segment as the number of assistant messages after that segment's last
  tool result. It is 1 in a healthy run, and the report counts the segments where it exceeded 1.
  Anything above zero means something manufactured an extra model request: the bridge's `summarize()`
  keeps only the last reply, the earlier one never reaches the τ² trajectory, and rewards are moving
  for the wrong reason.

Per-simulation rows carry `mem_mode`, `mem_model`, `mem_protocol`, `mem_consults`, `mem_injects`,
`mem_chars`, `mem_tok_in`, `mem_tok_out`, `mem_errors`, `mem_ms`, `mem_cost`, `trailing_seen` and
`trailing_violations` for any further slicing. The raw events stay in
`AssistantMessage.raw_data.memory`, and every consult's prompt and reply is in
`data/memory-trace/<run>/<session_id>.jsonl`.

## 4. What to report

Reward is not the whole answer, and against a strong executor it may not move at all. Report
alongside it: injections per episode, input-token inflation on the **executor** (the expensive
model), memory-model dollars, and turn latency. Note that the consult happens inside `agent/pre-step`,
before `step/start`, so it does not show up in `ttft_ms` or `gen_ms` — only in `turn_ms` and
first-reply latency.

A free arm that matches a paid one is a result.
