// The auxiliary model call. Shaped after dsh-session-title-llm (createUserMessage + deepFreeze'd
// GenerateOptions + BlockAssembler), with two deliberate differences:
//   - no `purpose` (its type is the closed union 'compaction' | 'session-title')
//   - nothing is appended to the session log (rule R2)
import { readFileSync } from 'node:fs'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import { applyEdits, renderBank } from './bank.mjs'
import { parseTextReply } from './protocol-text.mjs'
import { runToolsProtocol } from './protocol-tools.mjs'
import { PLUGIN } from './window.mjs'

const promptCache = new Map()

/** Keep or drop a `<!-- name --> … <!-- /name -->` region. */
const region = (text, name, keep) =>
  text.replace(new RegExp(`[ \\t]*<!--\\s*${name}\\s*-->([\\s\\S]*?)<!--\\s*/${name}\\s*-->[ \\t]*\\n?`, 'g'), keep ? '$1' : '')

/** Load prompts/memory.<locale>.md, keep the regions this arm needs, fill the placeholders. */
export function loadPrompt(cfg) {
  const path = cfg.promptFile || new URL(`../prompts/memory.${cfg.locale}.md`, import.meta.url)
  const key = `${path}|${cfg.mode}|${cfg.protocol}|${cfg.bank.maxEditsPerCall}|${cfg.intervention.maxChars}`
  const hit = promptCache.get(key)
  if (hit !== undefined) return hit
  let text = readFileSync(path, 'utf8')
  text = region(text, 'bank', cfg.mode !== 'proactive-nobank')
  text = region(text, 'tags', cfg.protocol === 'text' && cfg.mode !== 'proactive-nobank')
  text = region(text, 'intervene', cfg.mode !== 'bankctx')
  text = text
    .replaceAll('{{maxEdits}}', String(cfg.bank.maxEditsPerCall))
    .replaceAll('{{maxChars}}', String(cfg.intervention.maxChars))
    .replaceAll('{{mode}}', cfg.mode)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  promptCache.set(key, text)
  return text
}

const tag = (name, body) => `<${name}>\n${body}\n</${name}>`

/** The per-call user message: task, bank, what we already said, the transcript, the pending write. */
export function buildUserText(cfg, input) {
  const parts = [tag('task', input.task || '(no task text)')]
  if (cfg.mode !== 'proactive-nobank') parts.push(tag('memory_bank', input.bankRender || '(empty)'))
  parts.push(tag('already_told_the_agent', input.alreadyTold.length ? input.alreadyTold.map(t => `- ${t}`).join('\n') : '(nothing yet)'))
  parts.push(
    `<transcript step="${input.step}" window="${cfg.window.messages}">\n${JSON.stringify(input.transcript, null, 1)}\n</transcript>`,
  )
  parts.push(tag('about_to_act', input.aboutToAct || 'unknown'))
  return parts.join('\n\n')
}

/** One streamed model call, drained into blocks. */
async function streamOnce(ctx, options) {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(deepFreeze({ ...options }))) {
    options.signal?.throwIfAborted()
    assembler.push(chunk)
  }
  options.signal?.throwIfAborted()
  const blocks = assembler.blocks()
  return {
    blocks,
    text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    toolCalls: blocks.filter(b => b.type === 'tool-call'),
    usage: assembler.usage,
    finish: assembler.finish,
    message: assembler.message({ kind: 'model', provider: options.provider, model: options.model }),
  }
}

/**
 * Ask the memory model about one step, apply its bank edits, and report its decision.
 * Throws on timeout, transport failure, or a terminal finish reason; the caller fails open.
 */
export async function consult(ctx, cfg, state, input, signal) {
  const started = Date.now()
  const system = loadPrompt(cfg)
  const bankRender = cfg.mode === 'proactive-nobank' ? '' : renderBank(state.bank)
  const userText = buildUserText(cfg, { ...input, bankRender })
  const messages = [
    createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'plugin', plugin: PLUGIN } }),
  ]
  const signals = [signal, AbortSignal.timeout(cfg.model.timeoutMs)].filter(Boolean)
  const options = {
    provider: input.route.provider,
    model: input.route.model,
    messages,
    system,
    temperature: cfg.model.temperature,
    maxTokens: cfg.model.maxTokens,
    sessionId: input.sessionId,
    signal: AbortSignal.any(signals),
  }

  const requireDecision = cfg.mode !== 'bankctx'
  let parsed
  if (cfg.protocol === 'tools') {
    parsed = await runToolsProtocol({
      streamOnce: opts => streamOnce(ctx, opts),
      options,
      messages,
      maxEdits: cfg.bank.maxEditsPerCall,
      requireDecision,
    })
  } else {
    const out = await streamOnce(ctx, options)
    parsed = {
      ...parseTextReply(out.text, { maxEdits: cfg.bank.maxEditsPerCall, requireDecision }),
      usage: out.usage,
      finish: out.finish,
      raw: out.text,
    }
  }
  // Terminal finishes, following dsh's own auxiliary-call convention (dsh-session-title-llm's
  // finishError). `max-tokens` belongs here: a truncated reply loses the closing tags the parser
  // needs (an unterminated <context_for_action> never matches, so a real intervention would be
  // recorded as a deliberate `no_intervention`), and under the tools protocol BlockAssembler drops
  // every tool-call block outright, so that round's bank edits would vanish unreported. Throwing
  // lands it on the caller's fail-open + `error` event path instead. `tool-calls` is NOT terminal
  // here: it is the normal continuation inside runToolsProtocol.
  if (parsed.finish?.kind === 'error' || parsed.finish?.kind === 'aborted' || parsed.finish?.kind === 'max-tokens') {
    const why = parsed.finish.failure?.message
      ?? (parsed.finish.kind === 'max-tokens' ? `reply truncated at maxTokens=${cfg.model.maxTokens}` : 'unknown')
    throw new Error(`memory model finished ${parsed.finish.kind}: ${why}`)
  }

  const { applied, rejected } = applyEdits(state.bank, parsed.edits, cfg.bank)
  return {
    decision: parsed.intervention ? 'intervene' : 'no_intervention',
    note: parsed.intervention,
    edits: applied,
    malformed: [...parsed.malformed, ...rejected],
    usage: parsed.usage,
    finish: parsed.finish,
    raw: parsed.raw,
    ms: Date.now() - started,
    system,
    user: userText,
  }
}
