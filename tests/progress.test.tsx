import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { digest, fingerprint, parseEstimate } from '../hooks/estimate'
import { fit, partsFor } from '../hooks/line'
import { planItems, planSteps } from '../hooks/plan'
import { parseIdleMs } from '../hooks/presence'
import { prefixFor, stripPrefix } from '../hooks/title'

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const reply = (text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses,
})
const use = (tool: string, input: Record<string, unknown>) => ({ tool_use_id: tool + JSON.stringify(input), tool, input })

const snap = (over: Partial<Snapshot>): Snapshot => ({
  sessionId: 's',
  project: 'Site',
  percent: 62,
  left: 'test and deploy',
  steps: { done: 3, total: 5 },
  contextFreePct: 41,
  rate5hPct: 34,
  isWaiting: false,
  isAway: false,
  idleSource: 'machine',
  startedAt: 0,
  updatedAt: 0,
  estimator: { date: '2026-10-23', tokens: 12_000 },
  ...over,
})

test('the task list is replayed the way the app keeps it', () => {
  const items = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'pending' },
  ]
  const run = (...inputs: Record<string, unknown>[]) =>
    planSteps(planItems([reply('', inputs.map(input => use('mcp__ccd_turn__update_plan', input)))]))

  expect(planSteps(planItems([prompt('hi')]))).toBe(null)
  expect(run({ items })).toEqual({ done: 0, total: 3 })
  expect(run({ items }, { advance: true })).toEqual({ done: 1, total: 3 })
  expect(run({ items }, { advance: true }, { advance: true })).toEqual({ done: 2, total: 3 })
  expect(run({ items }, { done: [1, 3], start: 2 })).toEqual({ done: 2, total: 3 })
  expect(
    planSteps(planItems([reply('', [use('mcp__ccd_turn__update_plan', { items }), use('mcp__ccd_turn__wrap_up', {})])])),
  ).toEqual({ done: 3, total: 3 })
})

test('the estimate is read from the model leniently and clamped', () => {
  expect(parseEstimate('```json\n{"percent": 140, "left": "done"}\n```')).toEqual({ percent: 100, left: 'done' })
  expect(parseEstimate('{"percent": "37.6"}')).toEqual({ percent: 38, left: '' })
  expect(parseEstimate('no idea')).toBe(null)
  expect(parseEstimate('{"percent": "lots"}')).toBe(null)
})

test('the digest carries the goal, the tasks and the previous estimate, without reminders', () => {
  const text = digest(
    [prompt('<system-reminder>secret</system-reminder>build a shop'), reply('ok', [use('Edit', {})])],
    [{ content: 'cart', status: 'in_progress' }],
    { percent: 30, left: 'the cart' },
  )

  expect(text.includes('build a shop')).toBe(true)
  expect(text.includes('secret')).toBe(false)
  expect(text.includes('[>] cart')).toBe(true)
  expect(text.includes('30% — left: the cart')).toBe(true)
  expect(text.includes('[tools: Edit]')).toBe(true)
})

test('the fingerprint moves when the transcript grows or a call settles', () => {
  const a = [prompt('x'), reply('', [use('Bash', {})])]
  const b = [prompt('x'), reply('', [{ ...use('Bash', {}), text: 'done' }])]

  expect(fingerprint(a)).toBe(fingerprint([...a]))
  expect(fingerprint(a) === fingerprint(b)).toBe(false)
  expect(fingerprint(a) === fingerprint([...a, prompt('y')])).toBe(false)
})

test('the title prefix is built, swapped and stripped without piling up', () => {
  const here = prefixFor(snap({ percent: 62, isWaiting: true }))
  const away = prefixFor(snap({ isAway: true, contextFreePct: 80 }))

  expect(here).toBe('🟩🟩🟩⬜⬜ 60% 💬 · ')
  expect(away).toBe('🟦🟦🟦🟦⬜ 80% · ')
  expect(prefixFor(snap({ percent: null }))).toBe(null)
  expect(stripPrefix(`${here}Site`)).toBe('Site')
  expect(stripPrefix(`${away}${here}Site`)).toBe('Site')
  expect(stripPrefix('Site 50%')).toBe('Site 50%')
  // A prefix an earlier version wrote in Eastern Arabic digits.
  expect(stripPrefix('🟩🟩🟩🟩⬜ \u06F8\u06F0\u066A · Site')).toBe('Site')
})

test('the machine idle time is read from ioreg', () => {
  expect(parseIdleMs('    |   "HIDIdleTime" = 83544147625\n')).toBe(83544.147625)
  expect(parseIdleMs('nothing')).toBe(null)
})

test('a narrow line drops the estimator cost first and keeps the percent and waiting flag', () => {
  const parts = partsFor(snap({ isWaiting: true }), 90 * 60_000)
  const wide = fit(parts, 500)
  const narrow = fit(parts, 40)

  expect(wide.includes('estimator today 12k tokens')).toBe(true)
  expect(wide.includes('⏱ 1h 30m')).toBe(true)
  expect(narrow.includes('estimator today')).toBe(false)
  expect(narrow.includes('62%')).toBe(true)
  expect(narrow.includes('waiting for you')).toBe(true)
  expect(fit(partsFor(snap({ isAway: true }), 0), 500).includes('context 41% free')).toBe(true)
})

// The world beneath the mod: a session whose transcript, idle time and title the test controls.
const world = (on: On, env: Record<string, string> = {}) => {
  const clock = mock.clock(on)
  mock.env(on, env)
  const state = {
    messages: [prompt('build a landing page')],
    idleNs: 5e9,
    asked: 0,
    titles: ['Site'],
    snapshot: null as Snapshot | null,
  }

  on('state.set', { plugin: 'project-progress', key: 'snapshot' }, (_, e, next) => {
    state.snapshot = e.value as Snapshot

    return next(e)
  })

  on('command.register', () => ({ value: { command: 'progress' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: '/work/site' }))
  on('session.surfaces', () => ({ value: ['desktop'] as const }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: 50_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour' as const, percentUsed: 34 }],
    },
  }))
  on('session.messages', () => ({ value: state.messages }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: `"HIDIdleTime" = ${state.idleNs}`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', () => {
    state.asked += 1

    return {
      value: {
        isAnswered: true as const,
        text: '{"percent": 40, "left": "contact form"}',
        usage: { input_tokens: 2000, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('mcp.call', (_, e) => {
    if (e.tool === 'get_session') {
      return { value: { content: [{ type: 'text', text: JSON.stringify({ title: state.titles.at(-1) }) }], isError: false } }
    }
    state.titles.push(String(e.args.title))

    return { value: { content: [], isError: false } }
  })

  return { clock, state }
}

test('the model is asked once per change, and never while you are away', async ($, on) => {
  const { clock, state } = world(on)

  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: false })
  await clock.advance(2000)
  expect(state.asked).toBe(1)
  expect(state.snapshot?.percent).toBe(40)
  expect(state.titles.at(-1)).toBe('🟩🟩⬜⬜⬜ 40% · Site')

  await clock.advance(60_000)
  expect(state.asked).toBe(1)

  state.messages = [...state.messages, reply('hero section done')]
  await clock.advance(60_000)
  expect(state.asked).toBe(2)

  state.idleNs = 10 * 60e9
  state.messages = [...state.messages, reply('contact form started')]
  await clock.advance(60_000)
  expect(state.asked).toBe(2)
  expect(state.snapshot?.isAway).toBe(true)
  expect(state.snapshot?.estimator.tokens).toBe(4060)
  expect(state.titles.at(-1)).toBe('🟦🟦🟦🟦⬜ 75% · Site')
})

test('the band draws the bar and the line on the terminal and the desktop', async ($, on) => {
  const { clock } = world(on)

  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: false })
  await clock.advance(2000)

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [160, 60]) {
      const ui = await $.ui.mount({
        plugin: 'project-progress',
        surface,
        component: 'AbovePrompt',
        requestId: 'band',
        props: {
          hasSurvey: false,
          isWorking: false,
          maxRows: 10,
          bodyColumns,
          scroll: { offset: 0, bodyRows: 10 },
          view: {},
        },
      })
      const line = await ui.find({ type: 'Text', text: /40%/ })

      expect(line?.text.includes('left: contact form')).toBe(bodyColumns === 160)
      expect(line?.text.includes('context 75% free')).toBe(true)
      expect(await ui.find({ key: 'open' })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('the projects pane lists every session file with its bar, on every surface', async ($, on) => {
  const { clock } = world(on, { HOME: '/home/t' })
  const other = snap({ sessionId: 'other', project: 'Shop', updatedAt: clock.now() })

  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({
    value: [{ name: 'other.json', kind: 'file' as const, size: 1, mtimeMs: clock.now(), isLink: false }],
  }))
  on('fs.read', () => ({ value: JSON.stringify(other) }))

  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: false })
  await clock.advance(2000)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'project-progress',
      surface,
      component: 'Pane',
      requestId: 'projects',
      props: {
        title: 'Project progress',
        isFocused: false,
        bodyColumns: 80,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })

    expect((await ui.find({ type: 'Text', text: /Shop/ }))?.text).toBe('Shop')
    expect((await ui.find({ type: 'Text', text: /62%/ }))?.text.includes('left: test and deploy')).toBe(true)
    await ui.unmount()
  }
})
