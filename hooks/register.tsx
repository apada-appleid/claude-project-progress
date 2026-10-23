import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot, Status, TitleRecord } from '../types'
import type { Estimate } from './estimate'
import { digest, fingerprint, guessStatus, hasWork, parseEstimate, SYSTEM } from './estimate'
import { runningShells } from './background'
import { BAR_CELLS, BAR_PX, barColor, barPct, cells, fit, partsFor, svgBar } from './line'
import { planItems, planSteps } from './plan'
import { parseIdleMs } from './presence'
import { cutName, prefixFor, SHORT_AT, stripPrefix } from './title'

const snapshot = atom({ plugin: 'project-progress', key: 'snapshot' } as const, null)
const titleRecord = atom({ plugin: 'project-progress', key: 'titleRecord' } as const, null)
const tick = atom({ plugin: 'project-progress', key: 'tick' } as const, 0)

const PANE = 'projects'
const PANE_TITLE = 'Project progress'
const STALE_MS = 10 * 60_000
const WEEK_MS = 7 * 24 * 3600_000

// 'quiet' never estimates, 'tick' when something changed, 'force' always, and 'final', once a turn
// ends, always (away or not) and reads from it why the turn stopped.
type Mode = 'quiet' | 'tick' | 'force' | 'final'

const RANK: Readonly<Record<Mode, number>> = { quiet: 0, tick: 1, force: 2, final: 3 }

// What session.start builds over its own $, for the timer and the other hooks to call.
type Session = {
  refresh: (mode: Mode) => Promise<void>
  clearTitle: () => Promise<void>
}

// The session's title as read back: the app's id and title, the mod's record, and the full name.
type TitleRead = { id: string; title: string; record: TitleRecord | null; base: string }

const textOf = (blocks: readonly { text?: string }[]): string => blocks.map(block => block.text ?? '').join('')

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

const fileName = (id: string): string => id.replace(/[^\w-]/g, '_')

export const register: Register = (on, options) => {
  const awayMs = Number(options.idleMinutes ?? 3) * 60_000
  const intervalMs = Math.max(15, Number(options.intervalSeconds ?? 60)) * 1000
  const model = String(options.model ?? 'haiku')
  const tokenCap = Number(options.dailyTokenCap ?? 400_000)

  let session: Session | null = null
  let sharedDir = ''
  // Counts the main loop's turns, so a turn's late verdict never lands on the next one.
  let turn = 0
  let isTurnOpen = false
  // A question or a plan waiting for your answer, inside a turn.
  let isAsking = false
  // Between a turn's end and the final estimate's verdict, the session still reads as working.
  let isAwaitingVerdict = false
  // How the last turn ended: stopped by you or an error (known at once), else the model's verdict.
  let ending: Status | null = null
  let verdict: Status | null = null

  // Working while a turn runs or background work goes on; a question only when Claude asked one.
  const statusOf = (background: number): Status => {
    if (isAsking) return 'question'
    if (isTurnOpen || isAwaitingVerdict) return 'working'
    if (ending !== null) return ending
    if (verdict === 'question') return 'question'
    if (background > 0) return 'working'

    return verdict ?? 'idle'
  }
  let isTitleOn = options.renameTitles !== false

  on('session.start', async ($, e, next) => {
    const sessionId = fileName(await $.session.id())
    const home = await $.env.get('HOME')
    sharedDir = home === undefined ? '' : `${home}/.claude/project-progress`
    const before = (await read($, snapshot))?.status
    ending = before === 'stopped' ? before : null
    verdict = before === 'question' || before === 'done' || before === 'error' ? before : null

    let lastFingerprint = ''
    let isBusy = false
    let again: Mode | null = null

    // The session as the desktop app knows it: its own id, which outlives a restart, and its title.
    const appSession = async (): Promise<{ id: string; title: string }> => {
      const info = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
      if (info.isError) throw new Error(textOf(info.content))
      const value = JSON.parse(textOf(info.content)) as { sessionId?: unknown; title?: unknown }

      return { id: String(value.sessionId ?? sessionId), title: String(value.title ?? '') }
    }

    const setTitle = async (title: string): Promise<void> => {
      const set = await $.mcp.call('ccd_session_mgmt', 'set_session_title', { session_id: 'self', title })
      if (set.isError) throw new Error(textOf(set.content))
    }

    const recordFile = (id: string) => `${sharedDir}/titles/${fileName(id)}.json`

    // What the mod last set: held for this run, and on disk for after a restart.
    const loadRecord = async (id: string): Promise<TitleRecord | null> => {
      const held = await read($, titleRecord)
      if (held !== null || sharedDir === '') return held

      try {
        return JSON.parse(await $.fs.read(recordFile(id))) as TitleRecord
      } catch {
        return null
      }
    }

    const saveRecord = async (id: string, record: TitleRecord): Promise<void> => {
      await update($, titleRecord, () => record)
      if (sharedDir !== '') await $.fs.write(recordFile(id), JSON.stringify(record)).catch(() => undefined)
    }

    // The full name: the one the mod kept while the title is still the one it set, else the title as
    // you or the app renamed it, less any prefix.
    const readTitle = async (): Promise<TitleRead> => {
      const app = await appSession()
      const record = await loadRecord(app.id)
      const base = record !== null && app.title === record.shown ? record.base : stripPrefix(app.title)

      return { ...app, record, base }
    }

    const clearTitle = async (): Promise<void> => {
      try {
        const read = await readTitle()
        if (read.base !== '' && read.base !== read.title) await setTitle(read.base)
        await saveRecord(read.id, { base: read.base, shown: read.base, short: read.record?.short ?? null })
      } catch {
        // Nothing to restore where the title cannot be read.
      }
    }

    // The machine's idle time; where it cannot say, the time since a prompt in any session.
    const idleFor = async (now: number): Promise<{ ms: number | null; source: Snapshot['idleSource'] }> => {
      try {
        const ran = await $.process.run(['ioreg', '-c', 'IOHIDSystem', '-r', '-d', '1'], { timeoutMs: 5000 })
        const ms = ran.exitCode === 0 ? parseIdleMs(ran.stdout) : null
        if (ms !== null) return { ms, source: 'machine' }
      } catch {
        // No host commands here: fall back to the last prompt.
      }
      if (sharedDir === '') return { ms: null, source: null }

      try {
        return { ms: now - Number(await $.fs.read(`${sharedDir}/last-seen`)), source: 'prompt' }
      } catch {
        return { ms: null, source: null }
      }
    }

    const refresh = async (mode: Mode): Promise<void> => {
      if (isBusy) {
        again = again === null || RANK[mode] > RANK[again] ? mode : again
        return
      }
      isBusy = true

      try {
        if ((await $.session.surfaces()).length === 0) return

        const now = await $.clock.now()
        const [usage, messages, idle] = await Promise.all([$.session.usage(), $.session.messages(), idleFor(now)])
        const prev = await read($, snapshot)
        const isAway = mode !== 'force' && idle.ms !== null && idle.ms >= awayMs
        const ofTurn = turn
        const items = planItems(messages)
        const today = new Date(now).toISOString().slice(0, 10)
        let estimator = prev?.estimator.date === today ? prev.estimator : { date: today, tokens: 0 }
        let percent = prev?.percent ?? null
        let left = prev?.left ?? ''
        let doing = prev?.now ?? ''

        // Outside the desktop app there is no session title to change; the band and the pane still work.
        let title: TitleRead | null = null
        if (isTitleOn) {
          try {
            title = await readTitle()
          } catch {
            isTitleOn = false
          }
        }
        const base = title === null || title.base === '' ? null : title.base
        const isLong = base !== null && base.length > SHORT_AT
        let short = base !== null && title?.record?.short?.for === base ? title.record.short : null
        const isShortWanted = isLong && short === null

        const print = fingerprint(messages)
        const isChanged = mode === 'force' || mode === 'final' || (mode === 'tick' && print !== lastFingerprint)
        let estimate: Estimate | null = null
        if ((mode === 'final' || !isAway) && isChanged && hasWork(messages) && estimator.tokens < tokenCap) {
          lastFingerprint = print
          const answer = await $.model.complete({
            model,
            system: [{ text: SYSTEM, cache: true }],
            prompt: digest(messages, items, { percent, left }, mode === 'final', isShortWanted ? (base ?? undefined) : undefined),
            maxTokens: 200,
            timeoutMs: 30_000,
          })
          const used = answer.usage
          estimator = {
            date: today,
            tokens:
              estimator.tokens +
              used.input_tokens +
              used.output_tokens +
              (used.cache_read_input_tokens ?? 0) +
              (used.cache_creation_input_tokens ?? 0),
          }
          estimate = answer.isAnswered ? parseEstimate(answer.text) : null
          if (estimate !== null) {
            ;({ percent, left } = estimate)
            if (estimate.now !== '') doing = estimate.now
            if (isShortWanted && base !== null && estimate.short !== undefined) short = { for: base, text: estimate.short }
          }
        }
        if (mode === 'final' && ofTurn === turn && !isTurnOpen) {
          verdict = estimate?.status ?? guessStatus(messages)
          isAwaitingVerdict = false
        }
        const agents = (await $.agent.list()).filter(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting')
        const background = runningShells(messages).length + agents.length
        const status = statusOf(background)
        // The task list's step in progress says what Claude is doing better than any guess.
        const step = items?.find(item => item.status === 'in_progress')?.content
        if (step !== undefined && step !== '') doing = step.length > 60 ? `${step.slice(0, 59)}…` : step

        const rate = usage.rateLimits.find(limit => limit.kind === 'five_hour')
        const fresh: Snapshot = {
          sessionId,
          project: base ?? basename(await $.session.cwd()),
          shortName: isLong && base !== null ? (short?.text ?? cutName(base)) : null,
          percent,
          left,
          now: doing,
          steps: planSteps(items),
          contextFreePct: usage.context.percent === undefined ? null : 100 - usage.context.percent,
          rate5hPct: rate === undefined ? null : Math.round(rate.percentUsed),
          status,
          background,
          isAway,
          idleSource: idle.source,
          startedAt: usage.startedAt,
          updatedAt: now,
          estimator,
        }

        // The title changes only when what it shows changes, so the sidebar is not rewritten every minute.
        if (title !== null && base !== null) {
          const prefix = prefixFor(fresh)
          const shown = prefix === null ? base : prefix + (fresh.shortName ?? base)
          try {
            if (shown !== title.title) await setTitle(shown)
            const record: TitleRecord = { base, shown, short }
            if (JSON.stringify(record) !== JSON.stringify(title.record)) await saveRecord(title.id, record)
          } catch {
            isTitleOn = false
          }
        }

        await update($, snapshot, () => fresh)
        await update($, tick, n => n + 1)
        if (sharedDir !== '') {
          await $.fs.write(`${sharedDir}/sessions/${sessionId}.json`, JSON.stringify(fresh)).catch(() => undefined)
        }
      } finally {
        isBusy = false
        const pending = again
        again = null
        if (pending !== null) void refresh(pending)
      }
    }

    session = { refresh, clearTitle }

    await $.command.register({
      name: 'progress',
      description: 'Project progress: open the projects pane; "now" estimates at once; "title off|on" toggles the bar in the session title',
      argumentHint: '[now | title off | title on]',
    })
    $.clock.every(intervalMs, () => void refresh('tick'))
    $.clock.after(2000, () => void refresh('tick'))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turn += 1
      isTurnOpen = true
      isAwaitingVerdict = false
      ending = null
      verdict = null
      $.clock.after(300, () => void session?.refresh('quiet'))
    }

    return next(e)
  })

  // Stopped by you or by an error is known at once; whether Claude asked something or finished
  // is read by the final estimate.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      isTurnOpen = false
      if (e.reason === 'answer') {
        isAwaitingVerdict = true
        $.clock.after(300, () => void session?.refresh('final'))
      } else {
        ending = e.reason === 'aborted' ? 'stopped' : 'error'
        $.clock.after(300, () => void session?.refresh('quiet'))
      }
    }

    return done
  })

  // A question or a plan waiting for your answer holds the turn open: show it as a question meanwhile.
  on('tool.call', async ($, e, next) => {
    const asks = e.agentId === undefined && (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode')
    if (!asks) return next(e)

    isAsking = true
    $.clock.after(0, () => void session?.refresh('quiet'))
    try {
      return await next(e)
    } finally {
      isAsking = false
      $.clock.after(0, () => void session?.refresh('quiet'))
    }
  })

  // Where the machine cannot report its idle time, a prompt in any session marks you present.
  on('prompt.submit', async ($, e, next) => {
    const submitted = await next(e)
    if (sharedDir !== '' && e.isMeta !== true) {
      await $.fs.write(`${sharedDir}/last-seen`, String(await $.clock.now())).catch(() => undefined)
    }

    return submitted
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const args = e.args.trim()

    if (args === 'now') {
      await session?.refresh('force')
      return { text: 'Fresh estimate done.' }
    }
    if (args === 'title off') {
      isTitleOn = false
      await session?.clearTitle()
      return { text: 'Bar removed from the session title.' }
    }
    if (args === 'title on') {
      isTitleOn = true
      await session?.refresh('quiet')
      return {
        text: isTitleOn
          ? 'Bar back in the session title.'
          : "This session's title can't be changed here; that needs the Claude desktop app.",
      }
    }

    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })

    return {
      text: opened.isPlaced
        ? 'Projects pane opened.'
        : 'Projects pane opened, but this screen has no room to show it.',
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null) return next(e)

    const line = fit(partsFor(s, await $.clock.now()), e.props.bodyColumns - 28)

    if (e.surface === 'terminal') {
      const { Box, Button, Text } = $.ui.resolve(e)
      const [full, empty] = cells(barPct(s))

      return (
        <Box flexDirection="row" gap={1}>
          <Box>
            <Text color={barColor(s)}>{full}</Text>
            <Text dimColor>{empty}</Text>
          </Box>
          <Text wrap="truncate-end">{line}</Text>
          <Button key="open" label="Projects" plain dimColor onPress={() => void $.ui.open({ id: PANE, title: PANE_TITLE })} />
        </Box>
      )
    }

    const { Box, Button, Svg, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Svg source={svgBar(barPct(s), barColor(s))} alt={`${barPct(s)}%`} width={BAR_PX} height={8} />
        <Text wrap="truncate-end">
          {line}
        </Text>
        <Button key="open" label="Projects" plain dimColor onPress={() => void $.ui.open({ id: PANE, title: PANE_TITLE })} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const now = await $.clock.now()

    // Every session writes its own file, so the pane sees the projects of all of them.
    let list: Snapshot[] = []
    if (sharedDir !== '') {
      const dir = `${sharedDir}/sessions`
      try {
        const files = (await $.fs.list(dir)).filter(
          f => f.kind === 'file' && f.name.endsWith('.json') && now - f.mtimeMs < WEEK_MS,
        )
        const loaded = await Promise.all(
          files.map(f =>
            $.fs
              .read(`${dir}/${f.name}`)
              // A session still on an earlier version writes fewer fields.
              .then(text => ({ shortName: null, now: '', status: 'idle', background: 0, ...(JSON.parse(text) as object) }) as Snapshot)
              .catch(() => null),
          ),
        )
        list = loaded.filter((s): s is Snapshot => s !== null).sort((a, b) => b.updatedAt - a.updatedAt)
      } catch {
        list = []
      }
    }

    const columns = e.props.bodyColumns - (e.surface === 'terminal' ? BAR_CELLS + 2 : 16)
    const rowLine = (s: Snapshot) => fit(partsFor(s, now), columns)
    const isStale = (s: Snapshot) => now - s.updatedAt > STALE_MS
    const name = (s: Snapshot) => `${s.project}${isStale(s) ? ' — last estimate' : ''}`

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column" gap={1}>
          {list.length === 0 && <Text dimColor>No projects yet.</Text>}
          {list.map(s => {
            const [full, empty] = cells(barPct(s))

            return (
              <Box key={s.sessionId} flexDirection="column">
                <Text bold dimColor={isStale(s)} wrap="truncate-end">
                  {name(s)}
                </Text>
                <Box flexDirection="row" gap={1}>
                  <Box>
                    <Text color={barColor(s)}>{full}</Text>
                    <Text dimColor>{empty}</Text>
                  </Box>
                  <Text dimColor wrap="truncate-end">
                    {rowLine(s)}
                  </Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }

    const { Box, Svg, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 && <Text dimColor>No projects yet.</Text>}
        {list.map(s => (
          <Box key={s.sessionId} flexDirection="column">
            <Text bold dimColor={isStale(s)} wrap="truncate-end">
              {name(s)}
            </Text>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Svg source={svgBar(barPct(s), barColor(s))} alt={`${barPct(s)}%`} width={BAR_PX} height={8} />
              <Text dimColor wrap="truncate-end">
                {rowLine(s)}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
