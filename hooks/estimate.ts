import type { SessionMessage } from 'claude-code'

import type { Status } from '../types'
import type { PlanItem } from './plan'

export const SYSTEM = `You estimate how complete the project worked on in a Claude Code session is.
You get the goal (the person's first request and any later requests), Claude's task list when there is one, the previous estimate, and the latest messages.
Reply with ONLY a JSON object, no prose, no code fence:
{"percent": <integer 0-100>, "left": "<what is left, in English, at most 8 words>", "now": "<what Claude is doing, at most 6 words>", "status": "<only when the turn has ended>", "short": "<only when asked>"}
Rules:
- percent is the share of the WHOLE goal that is done, judged from evidence in the messages, not from promises.
- When a task list exists, weigh it heavily; a step in progress counts as half done.
- Planning or just started: 0-15. Built but not verified: 70-85. Verified and handed over: 95-100.
- Stay close to the previous estimate unless the messages show real progress; new requirements from the person may lower it.
- "left" names the concrete remaining work (e.g. "test and fix the checkout page"); when done, "done".
- When the digest says Claude's turn has ended, "status" says why it stopped, judged from Claude's last message:
  "question" when it asks the person something or waits for their decision, approval or input;
  "done" when the work asked for is finished and nothing is asked of the person;
  "blocked" when it stopped without finishing, on an error or something it cannot do.
  While Claude is still working, leave "status" out.
- "now" names what Claude is doing at this moment (e.g. "running the checkout tests"); once the turn has ended, what it did last.
- When the digest gives a SESSION NAME TO SHORTEN, "short" is that name in at most 3 words and 20 characters, keeping its meaning (e.g. "Fix the clipping on the share card" becomes "Share card clipping"). Otherwise leave "short" out.`

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

const clean = (text: string): string => text.replace(REMINDER, '').trim()

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`

// What the person typed: a user row with text, not one carrying tool results.
const isPrompt = (m: SessionMessage): boolean =>
  m.role === 'user' && (m.toolResults?.length ?? 0) === 0 && clean(m.text) !== ''

export const hasWork = (messages: readonly SessionMessage[]): boolean => messages.some(isPrompt)

// Changes whenever the transcript grows or a tool call in its last message settles.
export const fingerprint = (messages: readonly SessionMessage[]): string => {
  const last = messages[messages.length - 1]
  const settled = last?.toolUses.filter(use => use.text !== undefined).length ?? 0

  return `${messages.length}:${last?.text.length ?? 0}:${last?.toolUses.length ?? 0}:${settled}`
}

export const digest = (
  messages: readonly SessionMessage[],
  items: readonly PlanItem[] | null,
  previous: { percent: number | null; left: string },
  hasEnded: boolean,
  nameToShorten?: string,
): string => {
  const prompts = messages.filter(isPrompt).map(m => clean(m.text))
  const goal = [cut(prompts[0] ?? '', 1500), ...prompts.slice(1).slice(-3).map(p => cut(p, 300))]

  const tasks =
    items === null
      ? '(none)'
      : items
          .map(item => `${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]'} ${item.content}`)
          .join('\n')

  const recent = messages
    .filter(m => isPrompt(m) || (m.role === 'assistant' && (clean(m.text) !== '' || m.toolUses.length > 0)))
    .slice(-10)
    .map(m => {
      const tools = [...new Set(m.toolUses.map(use => use.tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')))].slice(0, 6)
      const text = cut(clean(m.text), 400)

      return `${m.role === 'user' ? 'person' : 'claude'}: ${text}${tools.length > 0 ? ` [tools: ${tools.join(', ')}]` : ''}`
    })

  const before = previous.percent === null ? '(none)' : `${previous.percent}% — left: ${previous.left}`

  return [
    'GOAL (first request, then later ones):',
    goal.filter(Boolean).join('\n---\n'),
    '',
    'TASK LIST:',
    tasks,
    '',
    `PREVIOUS ESTIMATE: ${before}`,
    '',
    `SESSION: ${hasEnded ? "Claude's turn has just ended; give the status." : 'Claude is working now.'}`,
    ...(nameToShorten === undefined ? [] : [`SESSION NAME TO SHORTEN: ${nameToShorten}`]),
    '',
    'LATEST MESSAGES (oldest first):',
    recent.join('\n'),
  ].join('\n')
}

export type Estimate = { percent: number; left: string; now: string; status?: Status; short?: string }

const STATUS_OF: Readonly<Record<string, Status>> = { question: 'question', done: 'done', blocked: 'error' }

export const parseEstimate = (text: string): Estimate | null => {
  const json = /\{[\s\S]*\}/.exec(text)
  if (json === null) return null

  try {
    const value = JSON.parse(json[0]) as { percent?: unknown; left?: unknown; now?: unknown; status?: unknown; short?: unknown }
    const percent = Number(value.percent)
    if (!Number.isFinite(percent)) return null

    const status = STATUS_OF[String(value.status ?? '')]
    const short = String(value.short ?? '').trim()

    return {
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      left: cut(String(value.left ?? '').trim(), 60),
      now: cut(String(value.now ?? '').trim(), 60),
      ...(status === undefined ? {} : { status }),
      ...(short === '' ? {} : { short: cut(short, 24) }),
    }
  } catch {
    return null
  }
}

// Where the model gave no status: a last message ending in a question mark (Latin or Arabic) asks something.
export const guessStatus = (messages: readonly SessionMessage[]): Status => {
  const last = [...messages].reverse().find(m => m.role === 'assistant' && clean(m.text) !== '')

  return last !== undefined && /[?\u061F]$/u.test(clean(last.text)) ? 'question' : 'done'
}
