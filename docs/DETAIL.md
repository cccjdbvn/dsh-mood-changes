# dsh-mood

A six-affect emotional pool (joy / sadness / anger / fear / surprise / disgust) with empathy conversion, coupling propagation, and daily audit logs.

## How it works

1. **Judge** — Every user message is sent to a local LLM (OpenAI-compatible endpoint) which classifies it into one or two of 41 fine-grained emotions.
2. **Empathy** — The judged emotion is converted through an empathy table into "her" response emotion.
3. **Pool** — Each emotion flows into a six-affect pool with half-life decay toward a configurable baseline.
4. **Coupling** — Event propagation spreads emotional weight between related affects; weak damping runs on each tick.
5. **States** — 17 special states (e.g. "feeling wronged", "anxious") trigger on certain emotions and modify subsequent values.
6. **Missing / Boredom** — Two time-driven tracks that grow when the owner is quiet and drop on interaction.
7. **Log** — A daily Markdown file records every write (who, what, why) with rollback support.
8. **Display** — A pill under the composer shows the current dominant emotion; click to see a full card with bars and a log viewer.

## Configuration

- `judgeBaseUrl` — Local LLM endpoint (default `http://127.0.0.1:1234/v1`)
- `judgeApiKey` — Optional API key
- `judgeModel` — Model name to request
- `judgeTimeout` — Request timeout in ms (default 3000)
- `judgeTemperature` — Sampling temperature (default 0.3)
- `tickIntervalMs` — Tick interval (default 900000 = 15 min)
- `worldDir` — Path to the world directory for state/log storage

## Tools

- `mood_log` — Query log entries by date and emotion filter
- `mood_rollback` — Roll back a log entry (same day only)
- `mood_baseline` — Write new baseline values

## Notes

- Requires a running local LLM with an OpenAI-compatible chat endpoint.
- State and logs are stored under `<worldDir>/mood/` and `<worldDir>/room/情绪日志/`.
- The plugin does not produce replies or write memories.