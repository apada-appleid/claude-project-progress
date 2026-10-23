import type { Snapshot, Status } from '../types'

// Names longer than this are shown shortened in the sidebar; the full name stays in the band.
export const SHORT_AT = 22

// The emoji a session that is not working shows in place of the progress; none for one not started.
export const STATUS_EMOJI: Partial<Record<Status, string>> = {
  question: '\u2753',
  done: '\u2705',
  stopped: '\u23F9\uFE0F',
  error: '\u26A0\uFE0F',
}

const PIE = ['\u25CB', '\u25D4', '\u25D1', '\u25D5', '\u25CF'] as const
const BATTERY = '\u{1F50B}'

// A quarter-step pie: 0-12% empty, 13-37% a quarter, ... 88-100% full.
export const pie = (pct: number): string => PIE[Math.max(0, Math.min(4, Math.round(pct / 25)))] ?? PIE[0]

// This version's bracketed prefix, and the ones earlier versions wrote (a bar of squares or an emoji,
// then a dot), so any of them is stripped.
const PREFIX =
  /^(?:\[(?:[\u25CB\u25D4\u25D1\u25D5\u25CF] \d+%|\u{1F50B} \d+%|\u2753|\u2705|\u23F9\uFE0F?|\u26A0\uFE0F?)\] |(?:[🟩🟦⬜]{5} \p{Nd}+[%\u066A](?: 💬)?|\u2753|\u2705|\u23F9\uFE0F?|\u26A0\uFE0F?) · )/u

export const stripPrefix = (title: string): string => {
  let base = title
  while (PREFIX.test(base)) base = base.replace(PREFIX, '')

  return base
}

// The pie and percent only while a turn runs (the context left, by a battery, while you are away);
// otherwise the status emoji alone. In brackets, so it reads as not part of the name.
export const prefixFor = (s: Snapshot): string | null => {
  if (s.status !== 'working') {
    const emoji = STATUS_EMOJI[s.status]

    return emoji === undefined ? null : `[${emoji}] `
  }
  if (s.isAway) return s.contextFreePct === null ? null : `[${BATTERY} ${Math.round(s.contextFreePct / 5) * 5}%] `

  return s.percent === null ? null : `[${pie(s.percent)} ${Math.round(s.percent / 5) * 5}%] `
}

// Until the model has given a short name: the name cut at a word, with an ellipsis.
export const cutName = (name: string): string => {
  if (name.length <= SHORT_AT) return name
  const head = name.slice(0, SHORT_AT - 1)
  const space = head.lastIndexOf(' ')

  return `${(space > 8 ? head.slice(0, space) : head).trimEnd()}…`
}
