import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { digest, fingerprint, guessStatus, parseEstimate } from '../hooks/estimate'
import { dashboardHtml, isListed, parseSnapshot } from '../hooks/dashboard'
import { BLUE, ctxColor, fit, progressParts, RED, usageParts, YELLOW } from '../hooks/line'
import { planItems, planSteps } from '../hooks/plan'
import { parseIdleMs } from '../hooks/presence'
import { cutName, pie, prefixFor, STATUS_EMOJI, stripPrefix } from '../hooks/title'

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const reply = (text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses,
})
const use = (tool: string, input: Record<string, unknown>) => ({ tool_use_id: tool + JSON.stringify(input), tool, input })

// A line without the direction isolates around each part.
const plain = (text: string): string => text.replace(/[\u2068\u2069]/g, '')

const snap = (over: Partial<Snapshot>): Snapshot => ({
  sessionId: 's',
  project: 'Site',
  shortName: null,
  percent: 62,
  left: 'test and deploy',
  now: 'running tests',
  steps: { done: 3, total: 5 },
  contextFreePct: 41,
  contextTokens: null,
  contextWindow: null,
  rate5hPct: 34,
  status: 'working',
  background: 0,
  isAway: false,
  idleSource: 'machine',
  startedAt: 0,
  updatedAt: 0,
  endedAt: null,
  seenAt: null,
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
  expect(parseEstimate('```json\n{"percent": 140, "left": "done"}\n```')).toEqual({ percent: 100, left: 'done', now: '' })
  expect(parseEstimate('{"percent": "37.6"}')).toEqual({ percent: 38, left: '', now: '' })
  expect(parseEstimate('no idea')).toBe(null)
  expect(parseEstimate('{"percent": "lots"}')).toBe(null)
  expect(parseEstimate('{"percent": 90, "left": "x", "status": "blocked"}')?.status).toBe('error')
  expect(parseEstimate('{"percent": 90, "left": "x", "status": "question"}')?.status).toBe('question')
  expect(parseEstimate('{"percent": 90, "left": "x", "status": "maybe"}')?.status).toBe(undefined)
  expect(parseEstimate('{"percent": 50, "left": "x", "now": "running tests", "short": "Share card clipping"}')).toEqual({
    percent: 50,
    left: 'x',
    now: 'running tests',
    short: 'Share card clipping',
  })
})

test('without a verdict, a last message ending in a question mark is a question', () => {
  expect(guessStatus([prompt('go'), reply('Which colour should the button be?')])).toBe('question')
  expect(guessStatus([prompt('go'), reply('All done.'), reply('', [use('Bash', {})])])).toBe('done')
})

test('the digest carries the goal, the tasks and the previous estimate, without reminders', () => {
  const text = digest(
    [prompt('<system-reminder>secret</system-reminder>build a shop'), reply('ok', [use('Edit', {})])],
    [{ content: 'cart', status: 'in_progress' }],
    { percent: 30, left: 'the cart' },
    true,
    'Fix the clipping on the share card',
  )

  expect(text.includes('build a shop')).toBe(true)
  expect(text.includes('secret')).toBe(false)
  expect(text.includes('[>] cart')).toBe(true)
  expect(text.includes('30% — left: the cart')).toBe(true)
  expect(text.includes('[tools: Edit]')).toBe(true)
  expect(text.includes("Claude's turn has just ended")).toBe(true)
  expect(text.includes('SESSION NAME TO SHORTEN: Fix the clipping on the share card')).toBe(true)
})

test('the fingerprint moves when the transcript grows or a call settles', () => {
  const a = [prompt('x'), reply('', [use('Bash', {})])]
  const b = [prompt('x'), reply('', [{ ...use('Bash', {}), text: 'done' }])]

  expect(fingerprint(a)).toBe(fingerprint([...a]))
  expect(fingerprint(a) === fingerprint(b)).toBe(false)
  expect(fingerprint(a) === fingerprint([...a, prompt('y')])).toBe(false)
})

test('the title shows the bar only while working, and an emoji once the turn ends', () => {
  const here = prefixFor(snap({ percent: 62 }))
  const away = prefixFor(snap({ isAway: true, contextFreePct: 80 }))

  expect(here).toBe('[◑ 60%] ')
  expect(away).toBe('[ctx 20%] ')
  expect(prefixFor(snap({ percent: null }))).toBe(null)
  expect(prefixFor(snap({ status: 'question', isAway: true }))).toBe(`[${STATUS_EMOJI.question}] `)
  expect(prefixFor(snap({ status: 'done' }))).toBe(`[${STATUS_EMOJI.done}] `)
  expect(prefixFor(snap({ status: 'stopped' }))).toBe(`[${STATUS_EMOJI.stopped}] `)
  expect(prefixFor(snap({ status: 'idle' }))).toBe(null)
  for (const emoji of Object.values(STATUS_EMOJI)) {
    expect(stripPrefix(`[${emoji}] ${here}Site`)).toBe('Site')
    expect(stripPrefix(`${emoji} · Site`)).toBe('Site')
  }
  expect(stripPrefix(`${away}Site`)).toBe('Site')
  expect(stripPrefix('[🔋 75%] Site')).toBe('Site')
  expect(stripPrefix('🟩🟩🟩⬜⬜ 60% 💬 · Site')).toBe('Site')
  expect(stripPrefix('🚀 launch')).toBe('🚀 launch')
  expect(stripPrefix('[draft] Site')).toBe('[draft] Site')
  expect(stripPrefix(`${here}Site`)).toBe('Site')
  expect(stripPrefix(`${away}${here}Site`)).toBe('Site')
  expect(stripPrefix('Site 50%')).toBe('Site 50%')
  // A prefix an earlier version wrote in Eastern Arabic digits.
  expect(stripPrefix('🟩🟩🟩🟩⬜ \u06F8\u06F0\u066A · Site')).toBe('Site')
})

test('the pie fills in quarter steps, and a long name is cut at a word', () => {
  expect([0, 12, 13, 37, 38, 62, 63, 87, 88, 100].map(pie).join('')).toBe('○○◔◔◑◑◕◕●●')
  expect(cutName('Fix the clipping on the share card')).toBe('Fix the clipping on…')
  expect(cutName('Blog migration')).toBe('Blog migration')
})

test('the band names the full title the sidebar shortens, and the task in progress', () => {
  const line = fit(progressParts(snap({ project: 'Fix the clipping on the share card', shortName: 'Share card clipping' }), 0), 500)

  expect(line.includes('Fix the clipping on the share card')).toBe(true)
  expect(line.includes('now: running tests')).toBe(true)
  expect(fit(progressParts(snap({ status: 'done' }), 0), 500).includes('now:')).toBe(false)
})

test('the projects page lists every project, what needs you first, with names escaped', () => {
  const html = dashboardHtml(
    [
      snap({ sessionId: 'a', project: 'Done one', status: 'done' }),
      snap({ sessionId: 'b', project: '<b>Ask</b>', status: 'question' }),
    ],
    0,
  )

  expect(html.indexOf('&lt;b&gt;Ask&lt;/b&gt;') < html.indexOf('Done one')).toBe(true)
  expect(html.includes('<b>Ask</b>')).toBe(false)
  expect(html.includes('http-equiv="refresh"')).toBe(true)
  expect(html.includes('width:62%;background:#22c55e')).toBe(true)
  expect(html.includes('width:59%;background:#3b82f6')).toBe(true)
  expect(dashboardHtml([], 0).includes('No projects yet')).toBe(true)
})

test('a finished project leaves the list once seen and quiet; one that needs you stays', () => {
  const min = 60_000
  const now = 10 * 60 * min
  const done = snap({ status: 'done', updatedAt: now, endedAt: now - 20 * min })

  expect(isListed(done, now)).toBe(true)
  expect(isListed({ ...done, seenAt: now - 30 * min }, now)).toBe(true)
  expect(isListed({ ...done, seenAt: now - 5 * min }, now)).toBe(false)
  expect(isListed({ ...done, seenAt: now - 5 * min, endedAt: now - 5 * min }, now)).toBe(true)
  expect(isListed({ ...done, seenAt: now - 5 * min }, now, 30 * min)).toBe(true)
  expect(isListed({ ...done, updatedAt: now - 7 * 60 * min }, now)).toBe(false)
  expect(isListed(snap({ status: 'question', updatedAt: now, endedAt: 0, seenAt: now }), now)).toBe(true)
  expect(isListed(snap({ status: 'working', updatedAt: now - 25 * 60 * min }), now)).toBe(false)

  const html = dashboardHtml([{ ...done, project: 'Old one', seenAt: now - 5 * min }, snap({ project: 'Live one', updatedAt: now })], now)
  expect(html.includes('Old one')).toBe(false)
  expect(html.includes('Live one')).toBe(true)
  expect(html.includes('1 finished or closed project hidden')).toBe(true)
})

test('a session file from an earlier version still reads', () => {
  expect(parseSnapshot('{"sessionId": "x", "isWaiting": true}')?.status).toBe('idle')
  expect(parseSnapshot('{"sessionId": "x"}')?.background).toBe(0)
  expect(parseSnapshot('not json')).toBe(null)
})

test('the machine idle time is read from ioreg', () => {
  expect(parseIdleMs('    |   "HIDIdleTime" = 83544147625\n')).toBe(83544.147625)
  expect(parseIdleMs('nothing')).toBe(null)
})

test('each row drops its least important parts first', () => {
  const progress = progressParts(snap({ status: 'question' }), 90 * 60_000)
  const narrow = fit(progress, 40)

  expect(fit(progress, 500).includes('⏱ 1h 30m')).toBe(true)
  expect(narrow.includes('⏱')).toBe(false)
  expect(narrow.includes('62%')).toBe(true)
  expect(narrow.includes('waiting for your answer')).toBe(true)
  expect(fit(progressParts(snap({ background: 2 }), 0), 500).includes('⟳ 2 in background')).toBe(true)
  expect(fit(progressParts(snap({ isAway: true }), 0), 500).includes('paused while you are away')).toBe(true)

  const usage = usageParts(snap({ contextTokens: 118_000, contextWindow: 200_000 }))
  expect(plain(fit(usage, 500))).toBe('context 59% · 118k of 200k · 5h limit 34% · estimator today 12k tokens')
  expect(plain(fit(usage, 20))).toBe('context 59%')
  expect(fit(usage, 20)).toBe('\u2068context 59%\u2069')
})

test('the context bar is blue, then yellow, then red as it fills', () => {
  expect(ctxColor(snap({ contextFreePct: 41 }))).toBe(BLUE)
  expect(ctxColor(snap({ contextFreePct: 25 }))).toBe(YELLOW)
  expect(ctxColor(snap({ contextFreePct: 10 }))).toBe(RED)
})

// The world beneath the mod: a session whose transcript, idle time and title the test controls.
const world = (on: On, env: Record<string, string> = {}, title = 'Site') => {
  const clock = mock.clock(on)
  mock.env(on, env)
  const state = {
    messages: [prompt('build a landing page')],
    idleNs: 5e9,
    asked: 0,
    titles: [title],
    verdict: 'done',
    snapshot: null as Snapshot | null,
  }

  on('state.set', { plugin: 'project-progress', key: 'snapshot' }, (_, e, next) => {
    state.snapshot = e.value as Snapshot

    return next(e)
  })

  on('command.register', () => ({ value: { command: 'progress' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer, reason: e.reason === 'refusal' ? 'answer' : e.reason }))
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
  on('agent.list', () => ({ value: [] }))
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
        text: JSON.stringify({ percent: 40, left: 'contact form', now: 'writing the form', status: state.verdict, short: 'Share card clipping' }),
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
  await $.turn.start({ text: 'build a landing page', turnId: 't1' })
  await clock.advance(2000)
  expect(state.asked).toBe(1)
  expect(state.snapshot?.percent).toBe(40)
  expect(state.titles.at(-1)).toBe(`[${pie(40)} 40%] Site`)

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
  expect(state.titles.at(-1)).toBe('[ctx 25%] Site')

  // The turn ends on a question while you are away: one final estimate still reads why.
  state.verdict = 'question'
  await $.turn.complete({ answer: 'Which colour?', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' })
  await clock.advance(1000)
  expect(state.asked).toBe(3)
  expect(state.snapshot?.status).toBe('question')
  expect(state.titles.at(-1)).toBe(`[${STATUS_EMOJI.question}] Site`)
  await clock.advance(60_000)
  expect(state.asked).toBe(3)

  // The next turn shows the bar again, and stopping it shows the stop sign with no model call.
  state.idleNs = 5e9
  await $.turn.start({ text: 'blue', turnId: 't2' })
  await clock.advance(1000)
  expect(state.titles.at(-1)).toBe(`[${pie(40)} 40%] Site`)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, reason: 'aborted', turnId: 't2' })
  await clock.advance(1000)
  expect(state.titles.at(-1)).toBe(`[${STATUS_EMOJI.stopped}] Site`)
  expect(state.asked).toBe(3)
})

test('a long name is shortened in the sidebar and kept whole in the snapshot', async ($, on) => {
  const { clock, state } = world(on, {}, 'Fix the clipping on the share card')

  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await clock.advance(2000)
  expect(state.titles.at(-1)).toBe(`[${pie(40)} 40%] Share card clipping`)
  expect(state.snapshot?.project).toBe('Fix the clipping on the share card')
  expect(state.snapshot?.now).toBe('writing the form')

  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' })
  await clock.advance(1000)
  expect(state.titles.at(-1)).toBe(`[${STATUS_EMOJI.done}] Share card clipping`)
  expect(state.snapshot?.project).toBe('Fix the clipping on the share card')
})

test('background work keeps a finished turn working until its task ends', async ($, on) => {
  const { clock, state } = world(on)
  const shell = { ...use('Bash', { command: 'render.sh' }), text: 'started', result: { backgroundTaskId: 'b1' } }

  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'render it', turnId: 't1' })
  state.messages = [...state.messages, reply('Rendering in the background.', [shell])]
  await clock.advance(2000)
  await $.turn.complete({ answer: 'Rendering.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' })
  await clock.advance(1000)
  expect(state.snapshot?.background).toBe(1)
  expect(state.titles.at(-1)).toBe(`[${pie(40)} 40%] Site`)

  state.messages = [...state.messages, prompt('<task-notification><task-id>b1</task-id><status>completed</status></task-notification>')]
  await clock.advance(60_000)
  expect(state.snapshot?.background).toBe(0)
  expect(state.titles.at(-1)).toBe(`[${STATUS_EMOJI.done}] Site`)
})

test('the session counts as seen once it is on screen after the turn ended', async ($, on) => {
  const { clock, state } = world(on)
  const band = {
    plugin: 'project-progress',
    surface: 'desktop',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as const

  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(2000)
  await (await $.ui.mount(band)).unmount()
  await clock.advance(60_000)
  expect(state.snapshot?.seenAt).toBe(null)

  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' })
  await clock.advance(1000)
  expect(state.snapshot?.endedAt).not.toBe(null)
  await (await $.ui.mount(band)).unmount()
  await clock.advance(60_000)
  expect((state.snapshot?.seenAt ?? 0) >= (state.snapshot?.endedAt ?? Infinity)).toBe(true)
})

test('the band draws the bar and the line on the terminal and the desktop', async ($, on) => {
  const { clock } = world(on)

  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: false })
  await clock.advance(2000)

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [160, 40]) {
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
      const progress = await ui.find({ type: 'Text', text: /40%/ })
      const usage = await ui.find({ type: 'Text', text: /context 25%/ })

      expect(progress?.text.includes('left: contact form')).toBe(bodyColumns === 160)
      expect(usage?.text.includes('50k of 200k')).toBe(bodyColumns === 160)
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
    expect((await ui.find({ type: 'Text', text: /62%/ }))?.text.includes('now: running tests')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /context 59%/ })).toBeDefined()
    expect(await ui.find({ key: 'window' })).toBeDefined()
    await ui.unmount()
  }
})
