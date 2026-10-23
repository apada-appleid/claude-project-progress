export type Steps = { done: number; total: number }

/**
 * What the session is doing: `working` while a turn runs; once it ends, whether Claude asked
 * something (`question`), finished (`done`), was stopped by you (`stopped`) or by an error
 * (`error`); `idle` before the first turn.
 */
export type Status = 'idle' | 'working' | 'question' | 'done' | 'stopped' | 'error'

export type Snapshot = {
  sessionId: string
  project: string
  /** The estimator's percent of the whole goal done; null before its first answer. */
  percent: number | null
  /** What is left, in a few words. */
  left: string
  steps: Steps | null
  contextFreePct: number | null
  rate5hPct: number | null
  status: Status
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
