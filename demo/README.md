# demo/ - record the glasses screen of Next Question from the Even Hub simulator

Copied from the Fill Notes demo tool and adapted. Starts the server (replay mode, fictional AMA only, no network),
the glasses app (vite, port 5174) and the simulator (automation port 9899), runs a JSON script, then stops only what it started.

```bash
demo/run-scene.sh demo/next-question-scene1.json /path/to/output-dir
```

- Server journal and pairing code go to `<out>/data/` (not into the repo). The app gets `?server=...&pair=...` in its URL.
- Refuses to start if 8788, 5174 or the automation port is already listening. Never kills by port; PIDs are in `<out>/pids/`.
- Script fields: `automationPort`, `fps`, `scale`, `serverOffsetSec` (capture t0 = first /api/health + this),
  `steps` (`up` `down` `click` `double_click` `wait` `end`, plus `session_end` = HTTP POST /api/session {"action":"end"} to the server),
  `marks`. Avoid `long_press` (opens the Mac microphone).
- Replay timeline: fixture events are at fixed seconds (server/fixtures/questions.json). Keep inputs >= 1 s away from them.
- Output: `scene.mp4`, `frames/`, `marks/`, `report.json` (pictureChanges, inputs, marks, listeners after stop).
