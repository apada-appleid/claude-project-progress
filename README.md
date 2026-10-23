# project-progress

A Claude Code mod that shows how far each session's project has come, without opening the session.

Every minute a small, cheap model (Haiku by default) reads a short digest of the session and estimates the share of the goal that is done. When you step away from the computer, estimates pause and the progress gives way to how full the context window is, so no tokens are spent while nobody is watching.

## What you see

**In the sidebar** (Claude desktop app): the start of each session's title says what the session is doing.

```
[◑ 60%] Share card clipping      ← working: the pie fills in quarters (○ ◔ ◑ ◕ ●)
[ctx 25%] API refactor            ← working while you are away: how full the context is
[❓] Docs site search             ← waiting for your answer
[✅] Blog migration               ← done
[⏹️] Data import                  ← stopped by you
[⚠️] Deploy script                ← stopped on an error
```

- What the mod adds sits in brackets, so it never reads as part of the name.
- The pie and percent show only while Claude is working, so the sidebar stays quiet. Background work (a shell or a subagent still running after the turn) counts as working.
- When a turn ends, the estimate that runs at that moment also reads whether Claude asked you something or finished; a stop by you or an error is known at once. `[❓]` shows only when Claude actually asked you something.
- A name longer than 22 characters is shown shortened: the same estimate gives a version of 3 words at most ("Fix the clipping on the share card" becomes "Share card clipping"). The full name stays in the line above the prompt, and `/progress title off` puts it back in the title. Rename a session and the mod takes the new name.
- The title changes only when what it shows changes (the percent in 5% steps), not every minute.

**Above the prompt**: one line with a colored bar and the details.

```
████████░░░░ Fix the clipping on the share card · 62% · now: running the checkout tests · 3/5 steps · left: tests and deploy · ctx 59% · 5h limit 34% · ⏱ 1h 20m · estimator today 12k tokens
```

The full name shows when the sidebar shortens it, and `now:` is the task list's step in progress, or the model's words for what Claude is doing. Once the turn ends, the line starts with the session's status (`❓ waiting for your answer`, `✅ done`, ...). When the line is too narrow, the least important parts drop first: the estimator's cost, the time, the 5-hour limit, then what is left.

**The projects pane**: `/progress` (or the **Projects** button on the line) opens a pane that lists every session running the mod, each with its own bar and details.

## How it keeps token use low

- The model is asked only when the session changed since the last estimate. A session waiting for you costs nothing.
- Nothing is estimated while you are away: no mouse or keyboard input for 3 minutes (read from the machine's idle time on macOS). The one exception is the single estimate when a turn ends, which tells a question from a finished job.
- Each estimate costs about 1.5–3k tokens: a digest of the goal, Claude's task list, the previous estimate and the last 10 messages, each cut short.
- The step count (`3/5 steps`) and the step in progress are read straight from Claude's task list and cost no tokens.
- The end-of-turn status and the short name ride on the same estimate, so they cost no extra call.
- A daily cap per session stops estimates once the estimator has used 400k tokens that day.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install project-progress --marketplace apada-appleid/claude-project-progress
```

From a shell:

```bash
claude plugin install project-progress --marketplace apada-appleid/claude-project-progress
```

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `apada-appleid/claude-project-progress`, then **Add plugin**.

New sessions load the mod by themselves. In a session that is already open, run `/reload-plugins`.

## Commands

| Command | What it does |
| --- | --- |
| `/progress` | Open the projects pane |
| `/progress now` | Estimate right away, even if nothing changed |
| `/progress title off` | Remove the bar from this session's title |
| `/progress title on` | Put it back |

## Options

Set them with `/plugin configure project-progress@apada`, or in `settings.json` under `pluginConfigs`.

| Option | Default | Meaning |
| --- | --- | --- |
| `idleMinutes` | `3` | Minutes without mouse or keyboard input before estimates pause |
| `intervalSeconds` | `60` | How often the session is checked |
| `model` | `haiku` | The estimator model: an alias or a full model id |
| `renameTitles` | `true` | Put the bar at the start of the session title |
| `dailyTokenCap` | `400000` | Tokens the estimator may use per session per day |

## Notes

- The sidebar bar needs the Claude desktop app, which lets a session rename itself. In a terminal the line above the prompt and the projects pane still work.
- Away detection reads `HIDIdleTime` through `ioreg` on macOS. Elsewhere the mod falls back to the time since your last prompt in any session.
- Estimates run on your own Claude account, through the session's own client. Each session writes its latest snapshot to `~/.claude/project-progress/sessions/` so the projects pane can show every session.

## Author

Made by Apada: [GitHub](https://github.com/apada-appleid) · [apadaa.ir](https://apadaa.ir)
