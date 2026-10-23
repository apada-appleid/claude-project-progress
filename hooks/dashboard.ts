import type { Snapshot, Status } from '../types'
import { ctxColor, ctxUsed, fit, GREEN, progressParts, usageParts } from './line'
import { prefixFor } from './title'

export const STALE_MS = 10 * 60_000
export const REFRESH_SECONDS = 10

// What needs you first, then what is working, then the rest; newest first within each.
const ORDER: Readonly<Record<Status, number>> = { question: 0, working: 1, error: 2, stopped: 3, done: 4, idle: 5 }

export const sortProjects = (list: readonly Snapshot[]): Snapshot[] =>
  [...list].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || b.updatedAt - a.updatedAt)

// A session file as read back: a session still on an earlier version writes fewer fields.
export const parseSnapshot = (text: string): Snapshot | null => {
  try {
    return {
      shortName: null,
      now: '',
      status: 'idle',
      background: 0,
      contextTokens: null,
      contextWindow: null,
      ...(JSON.parse(text) as object),
    } as Snapshot
  } catch {
    return null
  }
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const bar = (pct: number, color: string): string =>
  `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${color}"></i></div>`

const project = (s: Snapshot, now: number): string => {
  const isStale = now - s.updatedAt > STALE_MS
  const tag = prefixFor(s)?.trim() ?? ''

  return `<section class="${isStale ? 'stale' : ''}">
<h2>${tag === '' ? '' : `<span class="tag">${escape(tag)}</span> `}<bdi>${escape(s.project)}</bdi>${isStale ? ' <span class="note">last estimate</span>' : ''}</h2>
<div class="row">${bar(s.percent ?? 0, GREEN)}<span>${escape(fit(progressParts(s, now, false), 1000))}</span></div>
<div class="row">${bar(ctxUsed(s) ?? 0, ctxColor(s))}<span class="dim">${escape(fit(usageParts(s), 1000))}</span></div>
</section>`
}

// A page of its own, outside any session: every project, reloading itself every few seconds.
export const dashboardHtml = (list: readonly Snapshot[], now: number): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Project progress</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--dim:#78716c;--line:#e7e5e4;--track:rgba(120,113,108,.22)}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b1a;--fg:#f5f5f4;--dim:#a8a29e;--line:#2e2c2a}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
h1{font-size:15px;font-weight:600;margin:0}
section{padding:10px 0;border-top:1px solid var(--line)}
section.stale{opacity:.55}
h2{font-size:13px;font-weight:600;margin:0 0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{color:var(--dim);font-weight:500}
.note,.dim,header span{color:var(--dim);font-weight:400}
.row{display:flex;align-items:center;gap:8px;margin-top:3px}
.row span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.bar{flex:0 0 96px;height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.bar i{display:block;height:100%;border-radius:3px}
.empty{color:var(--dim);padding:24px 0}
</style></head><body>
<header><h1>Project progress</h1><span>${new Date(now).toTimeString().slice(0, 8)}</span></header>
${list.length === 0 ? '<p class="empty">No projects yet. Sessions running the mod show up here.</p>' : sortProjects(list).map(s => project(s, now)).join('\n')}
</body></html>
`
