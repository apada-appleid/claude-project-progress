import type { SessionMessage } from 'claude-code'

import type { Steps } from '../types'

export type PlanItem = { content: string; status: 'pending' | 'in_progress' | 'completed' }

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

const mark = (items: PlanItem[], at: number, status: PlanItem['status']): void => {
  const item = items[at]
  if (item !== undefined) items[at] = { ...item, status }
}

// Replays the session's task-list calls in order, the way the app keeps the list.
export const planItems = (messages: readonly SessionMessage[]): PlanItem[] | null => {
  let items: PlanItem[] | null = null

  for (const message of messages) {
    for (const use of message.toolUses) {
      if (use.tool === WRAP_TOOL && items !== null) {
        items = items.map(item => ({ ...item, status: 'completed' }))
        continue
      }
      if (use.tool !== PLAN_TOOL) continue

      const input = use.input
      if (Array.isArray(input.items)) {
        items = input.items.map(raw => {
          const one = (raw ?? {}) as { content?: unknown; status?: unknown }
          const status = one.status === 'completed' || one.status === 'in_progress' ? one.status : 'pending'

          return { content: String(one.content ?? ''), status }
        })
      }
      if (items === null) continue

      if (input.advance === true) {
        mark(items, items.findIndex(item => item.status === 'in_progress'), 'completed')
        mark(items, items.findIndex(item => item.status === 'pending'), 'in_progress')
      }
      if (Array.isArray(input.done)) {
        for (const n of input.done) mark(items, Number(n) - 1, 'completed')
      }
      if (typeof input.start === 'number') mark(items, input.start - 1, 'in_progress')
    }
  }

  return items
}

export const planSteps = (items: readonly PlanItem[] | null): Steps | null =>
  items === null || items.length === 0
    ? null
    : { done: items.filter(item => item.status === 'completed').length, total: items.length }
