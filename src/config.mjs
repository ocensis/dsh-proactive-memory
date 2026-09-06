// Config schema (schemastery, so `dsh plugin add` and the settings panel can render it)
// plus resolveConfig(): validate, fill defaults, and clamp numbers into sane ranges.
import z from '@deepseek-ai/schemastery'

/** Experiment arms. They map 1:1 onto the ablations of arXiv 2607.08716 (see docs/paper-fidelity.md). */
export const MODES = ['off', 'always', 'proactive', 'proactive-nobank', 'bankctx']
/** How the memory model reports its bank edits: one text round-trip, or real tool calls. */
export const PROTOCOLS = ['text', 'tools']
export const LOCALES = ['en', 'zh']

/** Fixed reminder used by `mode: always` — generic on purpose, it must not encode any domain. */
export const DEFAULT_ALWAYS_TEXT =
  'Before your next action, check three things against the policy: (1) have you completed every ' +
  'required verification step for this user, (2) if the next action modifies data, has the user ' +
  'explicitly confirmed the exact details, (3) are you stating only facts that tool results have ' +
  'shown you. If a check fails, fix that first.'

export const Config = z.object({
  mode: z.union(MODES).default('off').description('off | always | proactive | proactive-nobank | bankctx'),
  model: z.object({
    provider: z.string().default('').description('empty falls back to the executor default model (loudly)'),
    model: z.string().default(''),
    temperature: z.number().default(0),
    maxTokens: z.number().default(512),
    reasoningEffort: z.string().default('').description('reasoning effort id passed to ctx.llm.stream (e.g. low); empty sends none — a thinking model then thinks at its default and can eat maxTokens'),
    timeoutMs: z.number().default(20000),
  }),
  protocol: z.union(PROTOCOLS).default('text'),
  schedule: z.object({
    firstStep: z.boolean().default(true),
    everySteps: z.number().default(1),
    maxCallsPerEpisode: z.number().default(40),
  }),
  window: z.object({
    messages: z.number().default(8),
    // 4000, not the pilot's 800: a retail `get_product_details` result is 2.0k chars median and 3.4k
    // at the tail, so 800 cut the middle out of every variant list — and the memory model read the
    // gap as an absence, telling the agent an item "is not" a variant of a product it IS a variant
    // of. Tool results have to arrive whole; arguments do not, so `argChars` stays at 400.
    toolResultChars: z.number().default(4000),
    argChars: z.number().default(400),
  }),
  bank: z.object({
    maxKnowledge: z.number().default(12),
    maxProcedural: z.number().default(12),
    maxEditsPerCall: z.number().default(6),
  }),
  intervention: z.object({
    maxChars: z.number().default(700),
    maxPerEpisode: z.number().default(12),
    dedupeJaccard: z.number().default(0.8),
  }),
  // `bankctx` injects the whole rendered bank, not a one-line note, so it cannot share the note
  // budget: at 400 chars the render was cut mid-entry and the rules — the last section — never
  // arrived at all. Its own budget, and rules first (see renderBank).
  bankctx: z.object({
    maxChars: z.number().default(1500).description('clip budget for the rendered bank in mode: bankctx'),
  }),
  alwaysText: z.string().default(DEFAULT_ALWAYS_TEXT),
  locale: z.union(LOCALES).default('en'),
  promptFile: z.string().default('').description('absolute path overriding prompts/memory.<locale>.md'),
  policyFile: z.string().default('').description('absolute path to the domain policy; rendered into the memory model system prompt'),
  writeTools: z.array(z.string()).default([]).description('tool names that count as "about to write"'),
  keyTools: z.array(z.string()).default([]).description('tool names whose calls and results are kept for the whole episode'),
  trace: z.object({
    dir: z.string().default('').description('empty disables the JSONL trace'),
    console: z.boolean().default(true),
  }),
})

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
const clampNum = (v, lo, hi, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/**
 * Validate raw plugin config and clamp every number. Unknown modes/protocols throw
 * (a typo in an experiment arm must be loud); out-of-range numbers are clamped, never thrown.
 */
export function resolveConfig(raw) {
  const cfg = new Config(raw ?? {})
  cfg.model.temperature = clampNum(cfg.model.temperature, 0, 2, 0)
  cfg.model.maxTokens = clampInt(cfg.model.maxTokens, 16, 8192, 512)
  cfg.model.timeoutMs = clampInt(cfg.model.timeoutMs, 500, 300000, 20000)
  cfg.schedule.everySteps = clampInt(cfg.schedule.everySteps, 1, 1000, 1)
  cfg.schedule.maxCallsPerEpisode = clampInt(cfg.schedule.maxCallsPerEpisode, 0, 10000, 40)
  cfg.window.messages = clampInt(cfg.window.messages, 1, 200, 8)
  cfg.window.toolResultChars = clampInt(cfg.window.toolResultChars, 40, 100000, 4000)
  cfg.window.argChars = clampInt(cfg.window.argChars, 40, 100000, 400)
  cfg.bank.maxKnowledge = clampInt(cfg.bank.maxKnowledge, 0, 200, 12)
  cfg.bank.maxProcedural = clampInt(cfg.bank.maxProcedural, 0, 200, 12)
  cfg.bank.maxEditsPerCall = clampInt(cfg.bank.maxEditsPerCall, 0, 100, 6)
  cfg.intervention.maxChars = clampInt(cfg.intervention.maxChars, 20, 20000, 700)
  cfg.intervention.maxPerEpisode = clampInt(cfg.intervention.maxPerEpisode, 0, 1000, 12)
  cfg.intervention.dedupeJaccard = clampNum(cfg.intervention.dedupeJaccard, 0, 1, 0.8)
  cfg.bankctx.maxChars = clampInt(cfg.bankctx.maxChars, 20, 20000, 1500)
  return cfg
}

/** True when this counted pre-step should trigger a consult. */
export function scheduled(counted, schedule) {
  if (counted === 1) return schedule.firstStep
  return (counted - 1) % Math.max(1, schedule.everySteps) === 0
}
