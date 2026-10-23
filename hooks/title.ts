import type { Snapshot, Status } from '../types'

// The emoji a session that is not working shows in place of the bar; none for one not started.
export const STATUS_EMOJI: Partial<Record<Status, string>> = {
  question: '\u2753',
  done: '\u2705',
  stopped: '\u23F9\uFE0F',
  error: '\u26A0\uFE0F',
}

// The bar (any script's digits and percent sign, the old waiting mark included, so a prefix an
// earlier version wrote is stripped too), or one of the status emoji, then the separator.
const PREFIX = /^(?:[🟩🟦⬜]{5} \p{Nd}+[%\u066A](?: 💬)?|\u2753|\u2705|\u23F9\uFE0F?|\u26A0\uFE0F?) · /u

export const stripPrefix = (title: string): string => {
  let base = title
  while (PREFIX.test(base)) base = base.replace(PREFIX, '')

  return base
}

// The bar only while a turn runs: green for the estimate, blue for the context left while you
// are away. Otherwise the status emoji alone, so the sidebar stays quiet.
export const prefixFor = (s: Snapshot): string | null => {
  if (s.status !== 'working') {
    const emoji = STATUS_EMOJI[s.status]

    return emoji === undefined ? null : `${emoji} · `
  }

  const pct = s.isAway ? s.contextFreePct : s.percent
  if (pct === null) return null

  const filled = Math.max(0, Math.min(5, Math.round(pct / 20)))
  const bar = (s.isAway ? '🟦' : '🟩').repeat(filled) + '⬜'.repeat(5 - filled)

  return `${bar} ${Math.round(pct / 5) * 5}% · `
}
