import type { Snapshot, Status } from '../types'
import { STATUS_EMOJI } from './title'

export const GREEN = '#22c55e'
export const BLUE = '#3b82f6'
export const YELLOW = '#eab308'
export const RED = '#ef4444'
export const BAR_PX = 110
export const BAR_CELLS = 12

// Where the context bar turns from blue to yellow, and from yellow to red.
export const CTX_WARN = 70
export const CTX_FULL = 85

const STATUS_TEXT: Partial<Record<Status, string>> = {
  question: 'waiting for your answer',
  done: 'done',
  stopped: 'stopped by you',
  error: 'stopped on an error',
}

// One piece of a line; the highest `drop` gives way first when room runs out, 0 never.
export type Part = { text: string; drop: number }

const elapsed = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000))

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const tokens = (n: number): string => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`)

// How full the context window is.
export const ctxUsed = (s: Snapshot): number | null => (s.contextFreePct === null ? null : 100 - s.contextFreePct)

// Blue while there is room, yellow as it fills, red near full.
export const ctxColor = (s: Snapshot): string => {
  const used = ctxUsed(s) ?? 0

  return used >= CTX_FULL ? RED : used >= CTX_WARN ? YELLOW : BLUE
}

// The first row: how far the work is.
export const progressParts = (s: Snapshot, now: number): Part[] => {
  const parts: Part[] = []
  const said = STATUS_TEXT[s.status]
  if (said !== undefined) parts.push({ text: `${STATUS_EMOJI[s.status] ?? ''} ${said}`, drop: 0 })
  // The sidebar shows a short name; here is the full one.
  if (s.shortName !== null) parts.push({ text: s.project, drop: 2 })

  parts.push({ text: s.percent === null ? 'estimating…' : `${s.percent}%`, drop: 0 })
  if (s.isAway && s.status === 'working') parts.push({ text: '⏸ estimates paused while you are away', drop: 3 })
  else if (s.status === 'working' && s.now !== '') parts.push({ text: `now: ${s.now}`, drop: 1 })
  if (s.background > 0) parts.push({ text: `⟳ ${s.background} in background`, drop: 1 })
  if (s.steps !== null) parts.push({ text: `${s.steps.done}/${s.steps.total} steps`, drop: 1 })
  if (s.left !== '') parts.push({ text: `left: ${s.left}`, drop: 4 })
  parts.push({ text: `⏱ ${elapsed(now - s.startedAt)}`, drop: 5 })

  return parts
}

// The second row: how much of the context, the plan and the estimator is used.
export const usageParts = (s: Snapshot): Part[] => {
  const used = ctxUsed(s)
  const parts: Part[] = [{ text: `ctx ${used ?? '?'}%`, drop: 0 }]
  if (s.contextTokens !== null && s.contextWindow !== null) {
    parts.push({ text: `${tokens(s.contextTokens)} of ${tokens(s.contextWindow)}`, drop: 3 })
  }
  if (s.rate5hPct !== null) parts.push({ text: `5h limit ${s.rate5hPct}%`, drop: 2 })
  parts.push({ text: `estimator today ${tokens(s.estimator.tokens)} tokens`, drop: 4 })

  return parts
}

export const fit = (parts: readonly Part[], columns: number): string => {
  let kept = [...parts]
  const width = (list: readonly Part[]) => list.reduce((n, part) => n + part.text.length + 3, 0)

  while (width(kept) > columns) {
    const worst = Math.max(...kept.map(part => part.drop))
    if (worst === 0) break
    const at = kept.map(part => part.drop).lastIndexOf(worst)
    kept = kept.filter((_, i) => i !== at)
  }

  return kept.map(part => part.text).join(' · ')
}

export const svgBar = (pct: number, color: string): string => {
  const filled = Math.round((BAR_PX * Math.max(0, Math.min(100, pct))) / 100)
  const fill = filled > 0 ? `<rect width="${filled}" height="8" rx="4" fill="${color}"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_PX}" height="8" viewBox="0 0 ${BAR_PX} 8"><rect width="${BAR_PX}" height="8" rx="4" fill="#888888" fill-opacity="0.25"/>${fill}</svg>`
}

export const cells = (pct: number): [string, string] => {
  const filled = Math.round((BAR_CELLS * Math.max(0, Math.min(100, pct))) / 100)

  return ['█'.repeat(filled), '░'.repeat(BAR_CELLS - filled)]
}
