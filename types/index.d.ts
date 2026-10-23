export type Steps = { done: number; total: number }

export type Snapshot = {
  sessionId: string
  project: string
  /** The estimator's percent of the whole goal done; null before its first answer. */
  percent: number | null
  /** What is left, in a few Persian words. */
  left: string
  steps: Steps | null
  contextFreePct: number | null
  rate5hPct: number | null
  isWaiting: boolean
  isAway: boolean
  /** Where "away" was judged from: the machine's idle time, the last prompt in any session, or nothing. */
  idleSource: 'machine' | 'prompt' | null
  startedAt: number
  updatedAt: number
  estimator: { date: string; tokens: number }
}

declare module 'claude-code' {
  interface PluginState {
    'project-progress': {
      snapshot: Snapshot | null
      baseTitle: string | null
      tick: number
    }
  }
}
