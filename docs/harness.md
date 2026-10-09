# The harness and dashboard

[← Documentation](README.md)

The harness is the host server (`harness/server/`) and the browser dashboard
(`harness/src/`). It connects to the game, runs agents, enforces the rules and saves
everything. This page covers using it. For installation see [Setup](setup.md).

## Start the host

```bash
npm run dev
```

Open http://127.0.0.1:4317. The server serves both the dashboard and its API, and
listens only on `127.0.0.1`. On macOS, start it from a terminal: a server started
inside another app, such as an editor's preview pane, can be denied local network
access and fail to reach the game machine.

The server reads its prompt and harness files once at startup. **Restart it after
editing anything in `prompt/` or `harness/`.**

## Connect the game

Start the game on the game machine and load a single-player map, then click **Connect
game**. The host opens SSH sessions that start:

- the window bridge, which captures the game window and sends input to it;
- the reader stream, sampled every 100 ms;
- the memory guard (the header shows `MEMORY GUARD ON`);
- the control monitor, a terminal window on the game machine.

The dashboard then shows the game and current stats. Outside runs the game preview
refreshes every 5 seconds, every 2 seconds while you have manual control, and at once
after a manual action. Stats that are older than 1.5 seconds, or unavailable in menus
and loading screens, are shown as unavailable, never as zero.

## Model profiles

A profile is a display name, a model ID, an endpoint and a key. **Home → Configure**
lists them; **+ Add** creates one.

- **Endpoints.** `https://openrouter.ai/api/v1` and Moonshot's endpoint use the
  OpenAI-compatible chat completions API. `https://api.anthropic.com` uses Anthropic's
  own Messages API, for Claude models by their Anthropic IDs (such as
  `claude-haiku-5-5`), with adaptive thinking: the reasoning level becomes Claude's
  effort (`minimal` and `low` both become `low`). Any other endpoint is treated like
  Moonshot's.

- The default profile, Kimi K3, reads `MOONSHOT_API_KEY` (and optionally
  `MOONSHOT_MODEL`, `MOONSHOT_BASE_URL`) from `.env`. Restart after changing `.env`.
- Keys typed into the dashboard are saved in `harness/runtime/config/models.json`, a
  git-ignored file readable only by your user. It is plain JSON, not an encrypted
  vault. The API never returns saved keys, and leaving the key field blank keeps the
  existing one.
- Endpoints must use HTTPS (plain HTTP only for localhost) and cannot contain
  credentials or a query string. Changing a profile's endpoint requires entering the
  key again.
- A profile with saved runs keeps its model ID and endpoint, so its runs stay
  attributable. Create a new profile for a different model.
- **Model settings** (Configure → model settings), recorded in every run:

  | Setting | Values | Meaning |
  | --- | --- | --- |
  | Reasoning | `default`, `off`, `minimal`, `low`, `medium`, `high` | `default` sends no reasoning setting and lets the endpoint decide. `off` is OpenRouter only. Moonshot accepts only `default`. On Anthropic a level is Claude's effort |
  | Max tokens | 1,024 to 131,072 (default 8,192) | Output tokens per reply, reasoning included. Used for gameplay, preparation and compaction (compaction never below 8,192) |
  | Providers, allow fallbacks | Provider names in order of preference | OpenRouter only: which upstream providers may serve the model. Empty lets OpenRouter choose for each request |
  | Prices | US dollars per million tokens: input, output, cache read, cache write; optionally higher ones for prompts over a number of tokens | Not OpenRouter, which reports what it billed. The provider's list prices, which the host applies to each request's tokens to record its cost (see [Context](context.md#tokens-and-caching)). Cache write is the 5-minute rate; a prompt counts input, cache reads and cache writes. A run cannot start without them. Runs record the prices they used |

  Profiles created before these settings existed keep what the harness used to send:
  low reasoning on OpenRouter, the endpoint's default elsewhere, 8,192 tokens, no
  provider preference.
- A profile can instead read `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` from `.env`,
  by creating it through the API with `envKey` set to that name; the endpoint must be
  OpenRouter's or Anthropic's.
- **Configure → Test saved model** sends one short, billed request.

## Manual control

**Take control** lets you click, right-click, drag, scroll and press the allowed keys
in the live view (focus the view to type). **P · Pause** and **Esc** buttons are
available. Manual and agent input never mix: starting a run, leaving the page or
opening settings turns manual control off.

## Start a run

On **Home**, fill in:

| Field | Default | Meaning |
| --- | --- | --- |
| Benchmark type | | Benchmark name; selects `prompt/benchmarks/<name>.md` (see [The benchmark](benchmark.md#scenarios)) |
| Model | | A saved profile |
| Instruction | | The operator's instruction to the agent, up to 12,000 characters |
| Game minutes | 25 | Game-time budget (0.5 to 120). The game speed is fixed at 40 and not a setting; see [How it works](how-it-works.md#time-is-game-time) |
| Wall limit | 360 minutes | Real-time limit, including thinking time (up to 720) |
| Default wait | 5 game seconds | How long the host waits after a turn that acted without looking (0 to 300) |
| Minimum turn | 8 game seconds | Least game time a turn that runs the game takes; the host waits out the rest (0 to 60, 0 turns it off). See [the agent](agent.md#a-turn) |
| Context budget | 120,000 tokens | When to compact the conversation (32,000 to 200,000; see [Context](context.md#compaction)) |
| Record video | on | Record the game while the agent acts |

**Start run** is refused unless the game is connected, the model has a key (and prices,
unless it is on OpenRouter), the memory guard is active and the reader confirms a
single-player map within 3 seconds. The run
is named `Model · Benchmark · YYYYMMDD-HHMMSSZ` (UTC).

The API also accepts a turn limit of 1 to 12 (`maxTurns`) for short diagnostics; the
dashboard does not offer it.

## Watch and stop a run

While a run is active the dashboard shows the agent's latest screenshot, stats, the
agent's messages and tool calls, its plan and notebook, the phase, the time left,
inference timing and compactions. The dashboard takes no screenshots of its own during
a run: the preview changes when the agent observes. Extra captures would queue behind
the agent's inputs and cost it game time.

Stop a run with **Stop** in the dashboard, by disconnecting, or with the control
monitor on the game machine (below). Stopping aborts the model request and waits, and
cancels queued input; an input already being sent finishes its key or button release.

If the host restarts, unfinished runs are marked **interrupted**. Runs cannot be
resumed.

## What a run saves

Every run gets its own folder, `harness/runtime/runs/<name>-<time>-<id>/`, readable
only by your user. The sidebar lists runs by model; select one to see its record and
logs. **Export logs** and **Download full events** download them.

| File | Contents |
| --- | --- |
| `run.json` | Name, model and its settings, instruction, benchmark, run settings, status, timestamps, turns, tokens, cost (see [Context](context.md#tokens-and-caching)), the learning series, episode and attempt (if any), and progress: budget used, which limit ended the run, the error that ended it, plan, notebook, playbook, compactions, timings, memory, recording summary. Also the harness and benchmark versions (see below) |
| `inputs.json` | Exactly what the agent was given: system prompt, benchmark rules, controls, settings, model |
| `logs.jsonl` | Readable log of messages, actions and errors, written live |
| `events.jsonl` | Every model stream event and tool result, including screenshots and the full reader sample behind each observation, plus host events. Can reach hundreds of MB |
| `memory.json`, `notebook.md`, `playbook.md` | The agent's plan, notebook, playbook (learning series only) and compaction handoffs |
| `checkpoint.json` | The conversation (without images), memory and progress, rewritten each turn. For inspection; runs cannot resume from it |
| `notifications.jsonl` | Every reader event: messages seen on screen, gaps in the reader stream |
| `controls-guide.html` | The first screenshot annotated with the construction controls |
| `final-overview.jpg` | The game after the final reading, centred on the keep with minimap clicks and zoomed all the way out with `Z`, still paused. Near a map edge the keep is in view but off centre. Taken only when the final pause was confirmed and the reader reports the camera; changes nothing but the camera |
| `recording/`, `video.mp4` | Recorded frames and the rendered video (recorded runs only) |
| `episode.json` | The scorecard (`npm run episodes` only; see [The benchmark](benchmark.md#the-scorecard)) |

**Harness version.** Every run records which code produced it, in `run.json` under
`harness`: the git commit the host started from, whether the files the
[benchmark fingerprint](benchmark.md#versions) covers had uncommitted changes (and a
hash of those changes; docs, tests, the dashboard and the dataset tools do not count),
and hashes of the exact system prompt and tool definitions. The run page
shows it, and `npm run report` has a Harness column, so runs made with different code
are easy to tell apart. `run.json` also records the [benchmark version](benchmark.md#versions)
under `benchmark`: the version, the fingerprint of the files it covers, and a hash of the
private preparation images.

Known API keys and fields named like keys are replaced with `[redacted]` before
anything is logged. Treat the runs folder as private anyway: it holds full screenshots
and model output.

## Run videos

With **Record video** on (or `--record` for episodes), the game machine records the
game window while the agent acts, and the host renders an edited MP4 when the run
ends.

- **Recording.** A separate SSH session captures the game window only, scaled to
  1600 × 900: 10 frames per second for 2.5 seconds after each input, 4 otherwise.
  Recording holds while the game is paused for thinking. It runs independently of the
  agent's own screenshots and clicks, and a recorder failure never stops the run.
  The frames are JPEGs kept in `<run>/recording/`: a 2-game-minute run recorded at
  the earlier 1440 × 810 took 370 MB, and 1600 × 900 frames are larger.
- **The video** (`<run>/video.mp4`, 1920 × 1080 H.264 with no audio track, one chapter
  per turn) plays actions at real speed with a drawn pointer, click rings, building
  names and key badges; fast-forwards idle stretches; cuts paused frames; and shows
  each thinking pause briefly, the paused game beside the model's reasoning as it
  types out. The game fills 1600 × 900; beside it are the plan and the turn's tool
  calls, below it game time and the main stats. It ends on the result: the final
  overview beside the score. A 2-game-minute run renders to about 1:40 and 11 MB. The
  dataset's copy is scaled to 720p ([Publishing](publishing.md#smaller-than-the-run)).

Re-render or change the edit by hand (needs Pillow and ffmpeg with libx264):

```bash
npm run video -- <run folder>                        # writes <run>/video.mp4
npm run video -- <run> --idle-speed 16 --max-idle 2  # compress idle play harder
npm run video -- <run> --max-think 0 --outro 0       # no thinking pauses, no result
```

Other options: `--speed`, `--min-think`, `--think-rate`, `--fps`, `--max-seconds`
(for previews) and `--encoder`.

## Safety boundaries

**Host server.** Listens on `127.0.0.1` only, rejects other `Host` headers, and
requires a dashboard header (and a matching origin, if sent) on every request that
changes something. Keys stay on the host.

**Game machine.** The host starts each helper over SSH with key login; no service
listens on the network. The window bridge:

- attaches to exactly one game process of your own user (Steam app `3024040`) and its
  window, matched by title, window class and process, and refuses if anything is
  ambiguous or changes;
- captures that window's own image, not the desktop, so other windows covering the
  game never appear in screenshots;
- sends input events addressed to the game window only, with no system-wide input
  injection, pointer warping, shell commands or arbitrary keyboard shortcuts;
- checks the game is the active window and has the screenshot's size before every
  input, and rejects coordinates outside it;
- exposes only finite clicks, drags and key presses, never a held key.

This bridge is written for the tested GNOME, Xwayland and Proton setup and refuses
states it does not recognise. It limits what the tools can do; it is not a sandbox
against other code running as your user.

**Single-player only.** The reader rejects multiplayer, map editor and spectator
states. Runs cannot start without its confirmation, and if it reports a multiplayer
game while connected, the host disconnects.

**Memory guard.** The game can leak memory during long pauses (see
[Status](status.md#known-issues)). Every connection runs a guard that closes the game
if it uses more than 7 GiB or the machine has less than 2 GiB available. A run cannot
start without it. If it closes the game, the run ends with that reason and the last
memory reading.

## Control monitor

Connecting opens **Crusader Arena — Game control monitor**, an `xterm` on the game
machine. It shows the model and run, the phase, turns and tokens, current stats,
screenshots sent, model requests and every input with its acknowledgement or failure.
It only uses private files under `$XDG_RUNTIME_DIR/crusader-arena/` and adds no
network listener.

| Key | Effect |
| --- | --- |
| `S` or `Space` | Stop: block input locally and tell the host to abort the run |
| `R` | Allow input again (does not resume a stopped run) |
| `Q` | Stop and close the monitor. Closing the window also stops |

Click the game again before giving input: the bridge refuses input while the monitor
or any other window has focus. The monitor never appears in the agent's screenshots.

## Development checks

```bash
npm test                                                  # harness tests
npm run build                                             # type check and production build
npm start                                                 # serve the built dashboard
python3 -m unittest discover -s tools/video               # video timeline and a tiny render (needs ffmpeg)
python3 -m unittest discover -s tools/ubuntu -p 'test_*.py'  # game-machine helpers (run on Ubuntu)
```

The harness tests drive real agent turns against fake models, game devices and
clocks, including long runs, repeated compaction, stops, deadlines and failures.
