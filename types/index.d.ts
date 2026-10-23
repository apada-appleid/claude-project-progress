export type Steps = { done: number; total: number }

/**
 * What the session is doing: `working` while a turn runs; once it ends, whether Claude asked
 * something (`question`), finished (`done`), was stopped by you (`stopped`) or by an error
 * (`error`); `idle` before the first turn.
 */
export type Status = 'idle' | 'working' | 'question' | 'done' | 'stopped' | 'error'

/**
 * What the mod knows of the session's title: the full name, the title it last set, and the short
 * name the model gave for that full name.
 */
export type TitleRecord = { base: string; shown: string; short: { for: string; text: string } | null }

export type Snapshot = {
  sessionId: string
  /** The session's full name. */
  project: string
  /** What the sidebar shows in place of a long name; null when the name is short enough. */
  shortName: string | null
  /** The estimator's percent of the whole goal done; null before its first answer. */
  percent: number | null
  /** What is left, in a few words. */
  left: string
  /** What Claude is doing now: the task list's step in progress, else the model's words. */
  now: string
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
      titleRecord: TitleRecord | null
      tick: number
    }
  }
}
