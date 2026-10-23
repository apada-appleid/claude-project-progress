# project-progress

A Claude Code mod that shows how far each session's project has come, without opening the session.

Every minute a small, cheap model (Haiku by default) reads a short digest of the session and estimates the share of the goal that is done. When you step away from the computer, estimates pause and the bar shows the context window left instead, so no tokens are spent while nobody is watching.

## What you see

**In the sidebar** (Claude desktop app): the start of each session's title says what the session is doing.

```
🟩🟩🟩⬜⬜ 60% · my-landing-page     ← working
🟦🟦🟦🟦⬜ 80% · api-refactor        ← working while you are away: blue shows the context left
❓ · docs-site                      ← waiting for your answer
✅ · blog-redesign                  ← done
⏹️ · data-import                    ← stopped by you
⚠️ · deploy-script                  ← stopped on an error
```

The bar shows only while Claude is working, so the sidebar stays quiet. When a turn ends, the estimate that runs at that moment also reads whether Claude asked you something or finished; a stop by you or an error is known at once. The title changes only when its prefix changes (the bar in 5% steps), not every minute.

**Above the prompt**: one line with a colored bar and the details.

```
████████░░░░ 62% · 3/5 steps · left: tests and deploy · context 41% free · 5h limit 34% · ⏱ 1h 20m · estimator today 12k tokens
```

Once the turn ends, the line starts with the session's status (`❓ waiting for your answer`, `✅ done`, ...). When the line is too narrow, the least important parts drop first: the estimator's cost, the time, the 5-hour limit, then what is left.

**The projects pane**: `/progress` (or the **Projects** button on the line) opens a pane that lists every session running the mod, each with its own bar and details.

## How it keeps token use low

- The model is asked only when the session changed since the last estimate. A session waiting for you costs nothing.
- Nothing is estimated while you are away: no mouse or keyboard input for 3 minutes (read from the machine's idle time on macOS). The one exception is the single estimate when a turn ends, which tells a question from a finished job.
- Each estimate costs about 1.5–3k tokens: a digest of the goal, Claude's task list, the previous estimate and the last 10 messages, each cut short.
- The step count (`3/5 steps`) is read straight from Claude's task list and costs no tokens.
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
