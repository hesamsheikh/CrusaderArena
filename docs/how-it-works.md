# How it works

[← Documentation](README.md)

Crusader Arena lets an AI model play Stronghold Crusader: Definitive Edition the way
a person does: it looks at screenshots of the game and clicks and types. A small
reader adds the numbers a player would read off the game's panels (gold, stored
goods, population, popularity), so the model does not have to squint at them. A
harness runs everything around the model: it pauses the game while the model
thinks, carries out its actions, keeps time and records the run.

## The pieces

The tested setup uses two machines: a **host** that runs the harness and talks to
the model provider, and a **game machine** that runs the game under Steam and Proton.

```text
Host machine (tested: macOS)                Game machine (tested: Ubuntu 26.04, Steam + Proton)

 Browser dashboard
        │
 Host server ───────────── SSH ──────────►  game-window.py    screenshots of, and input to, the game window
   ├─ run controller                        run-proton.py     game state from the reader inside the game
   ├─ agent ◄──► model provider API         monitor-memory.py memory guard
   └─ run files on disk                     record-window.py  frames for run videos (optional)
                                            control-status.py activity monitor with a local stop key
```

| Piece | Runs on | What it does | Code |
| --- | --- | --- | --- |
| Dashboard | Host, in a browser | Live game view and stats, run setup, run history and logs | `harness/src/` |
| Host server | Host | Serves the dashboard on `127.0.0.1`, owns the game connection, starts runs, saves them | `harness/server/index.ts` |
| Run controller | Host | The run loop: preparation, pausing, timing, stop conditions, context compaction | `harness/server/controller.ts` |
| Agent | Host | The model, its system prompt and its 27 tools, run with the [Pi](https://github.com/earendil-works/pi) agent runtime | `harness/server/model.ts` |
| Game-window bridge | Game machine | Captures only the game window and sends mouse and keyboard input to it | `tools/ubuntu/game-window.py` |
| Reader | Game machine, inside the game | Reads game state from memory and streams it as JSON lines | `src/windows/`, `tools/ubuntu/run-proton.py` |
| Memory guard | Game machine | Closes the game before a known memory leak exhausts the machine | `tools/ubuntu/monitor-memory.py` |
| Recorder | Game machine | Captures frames for an edited run video | `tools/ubuntu/record-window.py` |
| Control monitor | Game machine | Terminal window showing what the harness is doing, with a local stop key | `tools/ubuntu/control-status.py` |

The host starts every game-machine helper on demand over SSH. Nothing on the game
machine listens on the network.

## A run, start to finish

1. **Connect.** The operator clicks **Connect game** in the dashboard. The host opens
   SSH sessions that start the window bridge, the reader stream (one sample every
   100 ms), the memory guard and the control monitor.
2. **Start.** The operator picks a model, a benchmark and an instruction, and clicks
   **Start run**. The host refuses unless the game is connected, the model has a key,
   the memory guard is active and the reader confirms a single-player map is loaded.
3. **Prepare.** The host pauses the game and sends the model its system prompt and a
   preparation message with a guide to the construction menus. The model has no tools
   yet. It plans and must end its reply with `BEGIN`.
4. **Play.** The host unpauses the game and sends the first screenshot. From then on
   the model works in turns: it thinks while the game is paused, then calls tools.
   Tools that only read (stats, notes, lookups, map reads) run with the game still
   paused; the host unpauses it at the first tool that acts, waits or takes a
   screenshot.
   If a turn acts without looking at the result, or calls no tools at all, the host
   lets 5 game seconds pass and sends a new screenshot. A turn that ran the game for
   less than the minimum turn length (8 game seconds by default) is topped up the same
   way, which caps how many requests, and so how much cost, a run can take.
5. **Finish.** The run ends when the play-time budget is used up (10 minutes by
   default), the real-time safety limit is reached (60 minutes), the operator stops
   it, or something fails. The host pauses the game, confirms the pause and saves a
   final screenshot and reading. It then centres the camera on the keep, zooms all the
   way out and saves that view too, as a picture of what the agent built.
6. **Afterwards.** Every message, tool call, screenshot and reading is on disk. A
   recorded run can be rendered into a video. Unattended episodes
   (`npm run episodes`) also write a scorecard.

## Time is play time

Models think at very different speeds, so the budget is **play time**: real time while
the game is running, not wall-clock time. The game is paused whenever the model is
thinking, and stays paused while it only reads, so thinking and reading cost nothing.
The host measures play time from the reader: the real time between samples in which the
game's clock advanced. A pause from any cause, including a game menu, does not count.

Game speed matters. At the normal speed setting (30) the game advances 30 ticks a
second and one game second takes one real second; a faster setting fits more game time,
and so more production and income, into the same play time. The model changes it with
`+` and `-` and sees the current speed in every observation. Waits, the default wait and
the minimum turn length are measured in game seconds.

A separate real-time limit (60 minutes by default) stops runs that would otherwise
take too long. It does include thinking time, so a very slow model can be cut off
before its play time is used up. The run record says which limit ended the run.

## What the model can and cannot do

- It sees only the game window, never the desktop.
- It acts only through its tools. Every click and key goes to the game window, at
  coordinates in the latest screenshot.
- It cannot pause the game or open the game menu: `P` and `Escape` are refused.
- It has no shell, files, browser or network access.
- Runs are single-player only. The reader refuses multiplayer games, and the host
  disconnects if it sees one.

## Read next

- [The agent](agent.md): the turn loop, rules and memory.
- [Context](context.md): exactly what the model is sent.
- [The benchmark](benchmark.md): what is measured and how runs are compared.
