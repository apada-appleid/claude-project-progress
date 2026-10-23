import type { Snapshot } from '../types'

// Any script's digits and percent sign, so a prefix written by an earlier version is stripped too.
const PREFIX = /^[🟩🟦⬜]{5} \p{Nd}+[%\u066A](?: 💬)? · /u

export const stripPrefix = (title: string): string => {
  let base = title
  while (PREFIX.test(base)) base = base.replace(PREFIX, '')

  return base
}

// Green squares for the estimate while you are here, blue for the context left while you are away.
export const prefixFor = (s: Snapshot): string | null => {
  const pct = s.isAway ? s.contextFreePct : s.percent
  if (pct === null) return null

  const filled = Math.max(0, Math.min(5, Math.round(pct / 20)))
  const bar = (s.isAway ? '🟦' : '🟩').repeat(filled) + '⬜'.repeat(5 - filled)

  return `${bar} ${Math.round(pct / 5) * 5}%${s.isWaiting ? ' 💬' : ''} · `
}
