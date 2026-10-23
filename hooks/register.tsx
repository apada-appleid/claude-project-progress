import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'
import { digest, fingerprint, hasWork, parseEstimate, SYSTEM } from './estimate'
import { BAR_CELLS, BAR_PX, barColor, barPct, cells, fit, partsFor, svgBar } from './line'
import { planItems, planSteps } from './plan'
import { parseIdleMs } from './presence'
import { prefixFor, stripPrefix } from './title'

const snapshot = atom({ plugin: 'project-progress', key: 'snapshot' } as const, null)
const baseTitle = atom({ plugin: 'project-progress', key: 'baseTitle' } as const, null)
const tick = atom({ plugin: 'project-progress', key: 'tick' } as const, 0)

const PANE = 'projects'
const PANE_TITLE = 'Project progress'
const STALE_MS = 10 * 60_000
const WEEK_MS = 7 * 24 * 3600_000

// 'tick' estimates when something changed, 'force' always, 'quiet' never.
type Mode = 'tick' | 'force' | 'quiet'

// What session.start builds over its own $, for the timer and the other hooks to call.
type Session = {
  refresh: (mode: Mode) => Promise<void>
  syncTitle: (s: Snapshot) => Promise<void>
  clearTitle: () => Promise<void>
}

const textOf = (blocks: readonly { text?: string }[]): string => blocks.map(block => block.text ?? '').join('')

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

export const register: Register = (on, options) => {
  const awayMs = Number(options.idleMinutes ?? 3) * 60_000
  const intervalMs = Math.max(15, Number(options.intervalSeconds ?? 60)) * 1000
  const model = String(options.model ?? 'haiku')
  const tokenCap = Number(options.dailyTokenCap ?? 400_000)

  let session: Session | null = null
  let sharedDir = ''
  let isWaiting = false
  let isTitleOn = options.renameTitles !== false

  on('session.start', async ($, e, next) => {
    const sessionId = (await $.session.id()).replace(/[^\w-]/g, '_')
    const home = await $.env.get('HOME')
    sharedDir = home === undefined ? '' : `${home}/.claude/project-progress`

    let lastFingerprint = ''
    let lastPrefix: string | null = null
    let isBusy = false
    let isAgain = false

    const currentTitle = async (): Promise<string> => {
      const info = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
      if (info.isError) throw new Error(textOf(info.content))

      return String((JSON.parse(textOf(info.content)) as { title?: unknown }).title ?? '')
    }

    const setTitle = async (title: string): Promise<void> => {
      const set = await $.mcp.call('ccd_session_mgmt', 'set_session_title', { session_id: 'self', title })
      if (set.isError) throw new Error(textOf(set.content))
    }

    // Renames only when the prefix itself changes, so the sidebar is not rewritten every minute.
    const syncTitle = async (s: Snapshot): Promise<void> => {
      if (!isTitleOn) return
      const prefix = prefixFor(s)
      if (prefix === lastPrefix) return

      try {
        const current = await currentTitle()
        const base = stripPrefix(current)
        if (base === '') return
        await update($, baseTitle, () => base)
        const title = prefix === null ? base : prefix + base
        if (title !== current) await setTitle(title)
        lastPrefix = prefix
      } catch {
        // Outside the desktop app there is no session title to change; the band and the pane still work.
        isTitleOn = false
      }
    }

    const clearTitle = async (): Promise<void> => {
      lastPrefix = null
      try {
        const current = await currentTitle()
        const base = stripPrefix(current)
        if (base !== '' && base !== current) await setTitle(base)
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
        isAgain = true
        return
      }
      isBusy = true

      try {
        if ((await $.session.surfaces()).length === 0) return

        const now = await $.clock.now()
        const [usage, messages, idle] = await Promise.all([$.session.usage(), $.session.messages(), idleFor(now)])
        const prev = await read($, snapshot)
        const isAway = mode !== 'force' && idle.ms !== null && idle.ms >= awayMs
        const items = planItems(messages)
        const today = new Date(now).toISOString().slice(0, 10)
        let estimator = prev?.estimator.date === today ? prev.estimator : { date: today, tokens: 0 }
        let percent = prev?.percent ?? null
        let left = prev?.left ?? ''

        const print = fingerprint(messages)
        const isChanged = mode === 'force' || (mode === 'tick' && print !== lastFingerprint)
        if (!isAway && isChanged && hasWork(messages) && estimator.tokens < tokenCap) {
          lastFingerprint = print
          const answer = await $.model.complete({
            model,
            system: [{ text: SYSTEM, cache: true }],
            prompt: digest(messages, items, { percent, left }),
            maxTokens: 150,
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
          const estimate = answer.isAnswered ? parseEstimate(answer.text) : null
          if (estimate !== null) ({ percent, left } = estimate)
        }

        const rate = usage.rateLimits.find(limit => limit.kind === 'five_hour')
        const fresh: Snapshot = {
          sessionId,
          project: '',
          percent,
          left,
          steps: planSteps(items),
          contextFreePct: usage.context.percent === undefined ? null : 100 - usage.context.percent,
          rate5hPct: rate === undefined ? null : Math.round(rate.percentUsed),
          isWaiting,
          isAway,
          idleSource: idle.source,
          startedAt: usage.startedAt,
          updatedAt: now,
          estimator,
        }

        // The title first: it is what names the project, from the first check on.
        await syncTitle(fresh)
        fresh.project = (await read($, baseTitle)) ?? basename(await $.session.cwd())

        await update($, snapshot, () => fresh)
        await update($, tick, n => n + 1)
        if (sharedDir !== '') {
          await $.fs.write(`${sharedDir}/sessions/${sessionId}.json`, JSON.stringify(fresh)).catch(() => undefined)
        }
      } finally {
        isBusy = false
        if (isAgain) {
          isAgain = false
          void refresh('quiet')
        }
      }
    }

    session = { refresh, syncTitle, clearTitle }

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
      isWaiting = false
      $.clock.after(300, () => void session?.refresh('quiet'))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      isWaiting = true
      $.clock.after(300, () => void session?.refresh('tick'))
    }

    return done
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
      const s = await read($, snapshot)
      if (s !== null) await session?.syncTitle(s)
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
              .then(text => JSON.parse(text) as Snapshot)
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
