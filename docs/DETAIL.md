# dsh-mood

A six-affect emotional pool (joy / sadness / anger / fear / surprise / disgust) with direct judging of the agent's own emotions, coupling propagation, and daily audit logs.

## How it works

1. **Judge** — Each time the agent finishes a reply, the latest conversation round goes to a local LLM (OpenAI-compatible endpoint), which classifies HER (the agent's) current emotion into one or two of 41 fine-grained emotions. Two rounds: first "did this turn directly move her?", then, if not, a context-aware "what is she feeling right now?"
2. **Pool** — Her emotion flows into a six-affect pool with half-life decay toward a configurable baseline.
3. **Coupling** — Event propagation spreads emotional weight between related affects; weak damping runs on each tick.
4. **States** — 17 special states (e.g. "feeling wronged", "anxious", "light-hearted") trigger on certain emotions and modify subsequent values.
5. **Missing / Boredom** — Two time-driven tracks that grow when the owner is quiet and drop on interaction.
6. **Log** — A daily Markdown file records every write (who, what, why) with rollback support.
7. **Display** — A pill under the composer shows the current dominant emotion; click to see a full card with bars and a log viewer.

The judge keeps its own clean dialogue context (last few rounds, both sides; cleared after 20 minutes of silence) and never touches the agent's own context.

## Configuration

- `judgeBaseUrl` — Local LLM endpoint (default `http://127.0.0.1:1234/v1`)
- `judgeApiKey` — Optional API key
- `judgeModel` — Model name to request
- `judgeTimeout` — Request timeout in ms (default 6000)
- `judgeTemperature` — Sampling temperature (default 0.3)
- `tickIntervalMs` — Tick interval (default 900000 = 15 min)
- `worldDir` — Path to the world directory for state/log storage
- `ownerNames` — Display names of the owner in QQ messages (missing only drops for these, private chat only)

## Tools

- `mood_log` — Query log entries by date and emotion filter
- `mood_rollback` — Roll back a log entry (same day only)
- `mood_baseline` — Write new baseline values

## Notes

- Requires a running local LLM with an OpenAI-compatible chat endpoint.
- State and logs are stored under `<worldDir>/mood/` and `<worldDir>/room/情绪日志/`.
- The plugin does not produce replies or write memories.
