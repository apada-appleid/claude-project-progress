import type { SessionMessage } from 'claude-code'

const TASK_ID = /<task-id>([^<\s]+)<\/task-id>/g
const STOP_TOOLS = new Set(['TaskStop', 'KillShell'])

// Background shells still running, read from the transcript itself, so it survives a reload: each
// call that went to the background names its task, and the notification of its end names it again.
export const runningShells = (messages: readonly SessionMessage[]): string[] => {
  const started = new Set<string>()
  const ended = new Set<string>()

  for (const message of messages) {
    for (const use of message.toolUses) {
      const id = (use.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
      if (typeof id === 'string' && id !== '') started.add(id)
      if (STOP_TOOLS.has(use.tool)) ended.add(String(use.input.task_id ?? use.input.shell_id ?? ''))
    }
    if (message.role === 'user') {
      for (const match of message.text.matchAll(TASK_ID)) if (match[1] !== undefined) ended.add(match[1])
    }
  }

  return [...started].filter(id => !ended.has(id))
}
