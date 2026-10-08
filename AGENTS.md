# AGENTS.md

Guidance for AI coding agents working in this repository. It tells you where things
are and how to work here; the facts live in [`docs/`](docs/README.md). Link to the
docs instead of copying them into this file.

## What this is

Crusader Arena is a benchmark in which AI models play Stronghold Crusader: Definitive
Edition through screenshots and mouse and keyboard tools. A TypeScript harness runs
the agent; a C++ reader supplies game state. Start with
[docs/how-it-works.md](docs/how-it-works.md).

## This repository is public

It is open source (MIT) and published on GitHub. Anything committed is public at once
and stays in history. Before every commit, read `git diff --cached`, both the file list
and the contents, and keep out:

- **Secrets and personal data:** API keys, tokens, `.env`, SSH targets, IP addresses,
  hostnames, usernames, email addresses, personal file paths. Configuration belongs in
  `.env`; `.env.example` holds only empty or public default values.
- **Run data:** `harness/runtime/` (run folders hold full screenshots and model output;
  `config/models.json` holds API keys).
- **Game material:** game files, binaries, memory dumps, screenshots, extracted game
  text or decompiled code. Facts learned from the game, such as prices, footprints or
  field names, are fine in your own words. `.internal/` holds private images made
  from game screenshots.
- **Third-party mod code**, unless its license has been reviewed.

Push only `main`. Other local branches can hold private history. Do not change the
git identity or other git configuration.

## Where things are

| Path | Contents | Read |
| --- | --- | --- |
| `harness/server/` | Host server (`index.ts`), run loop (`controller.ts`, `session.ts`), agent and tools (`model.ts` plus `placement.ts`, `anchors.ts`, `economy.ts`, `tile-map.ts`, `map-view.ts`), prompt assembly (`preparation.ts`), context and compaction (`context.ts`), what the model sees of game state (`status.ts`, `game-events.ts`), game connection (`device.ts`), storage (`store.ts`, `run-memory.ts`), episodes and reports (`episodes.ts`, `run-report.ts`), recording (`recorder.ts`, `video.ts`) | [agent](docs/agent.md), [context](docs/context.md), [tools](docs/tools.md), [harness](docs/harness.md) |
| `harness/shared/protocol.ts` | Types shared by server and dashboard: run settings, model settings, allowed keys | |
| `harness/src/` | The React dashboard | [harness](docs/harness.md) |
| `prompt/` | Everything the model reads: controls, game reference, benchmark rules, objectives | [context](docs/context.md), [benchmark](docs/benchmark.md) |
| `src/windows/` | The C++ reader: launcher, DLL and probe, cross-compiled for Windows and run under Proton | [reader](docs/reader.md) |
| `tools/ubuntu/` | Game-machine helpers: window bridge, reader stream, memory guard, recorder, control monitor, setup scripts | [setup](docs/setup.md), [harness](docs/harness.md) |
| `tools/video/` | Run video renderer | [harness](docs/harness.md#run-videos) |
| `tools/dataset/` | Packaging, scrubbing and uploading runs to the Hugging Face dataset; the dataset card and benchmark version | [publishing](docs/publishing.md) |
| `tests/` | C++ and Python tests for the reader and its tools | |
| `docs/` | The documentation; [docs/status.md](docs/status.md) says what is verified | |

## How to work here

- **Keep the docs true.** When you change behaviour, update the page that describes
  it in the same change. Docs describe current behaviour plainly, with no dated
  diaries. Verification status belongs in `docs/status.md`.
- **Say how you know.** Keep apart what was checked in the live game, what is tested
  in code, and what comes from static analysis. Never claim a live check you did not
  make.
- **Keep the system prompt fixed within a run.** It must stay byte-identical for
  provider caching; per-turn information travels in observations and tool results.
- **Restart the host after editing `prompt/` or `harness/`**: it loads them once at
  startup, and `npm run episodes` refuses a stale host.
- **Work without private files.** A fresh clone has no `.internal/` guide images.
  Code and tests must not depend on them.
- **Check before finishing:** `npm test` and `npm run build`; for the video renderer,
  `python3 -m unittest discover -s tools/video`; for the dataset tools,
  `python3 -m unittest discover -s tools/dataset`. Tests in `tools/ubuntu/` and
  `tests/` run on the game machine (see [setup](docs/setup.md)).
- **Ask before billed model runs.** They cost money.

## The live game

- The game runs on a separate Linux machine, reached over SSH with `GAME_SSH_HOST`
  and `GAME_REMOTE_ROOT` from `.env`. Its copy of this repository is synced by hand,
  so check it is current before testing there.
- Never assume the game is running, paused or on a given map. Check with the dashboard
  or `python3 tools/ubuntu/run-proton.py watch --samples 3` on the game machine.
- Never modify installed game files. Restarting the game and loading benchmark saves
  for testing is fine.
- Single-player only. Do not work around the multiplayer refusal.
