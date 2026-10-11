# Roadmap

What Crusader Arena plans to do next. [Status](docs/status.md) says what works and is
verified today, and the [changelog](CHANGELOG.md) says what each version changed. When
an item is done it leaves this page and appears in the changelog.

The page has three sections, **Now**, **Next** and **Later**, in that order. Each item is
one bullet that starts with a bold title ending in a full stop, followed by a sentence or
two. The project website shows this file, so keep that shape.

## Now

- **Find the bugs we have not hit yet.** Run more models for longer, and try in the live
  game what is so far only tested in code: the fixed game speed in an agent run and the
  minimum turn length while waiting.
- **Full-length runs.** Make the default 25 game minutes reliable. The game's garbage
  collector can stall under Proton, which ended earlier long runs; with the reader's
  watchdog against it, three 25-game-minute episodes have run in full, which is too few
  to call them reliable.
- **A better harness.** Improve the tools, prompt and context where recorded runs show
  models getting stuck, make the two machines easier to set up, and play with the
  text-only menu guide that a fresh checkout uses, which no model has used yet.

## Next

- **Other maps.** Scored benchmarks on more of the game's maps, not only Oasis by the
  Sea, starting with the two diagnostic scenarios already defined (Cactus Valley and A
  Mightier Oasis).
- **First results.** Run several models on one benchmark version and publish the
  comparison, with every run in the
  [dataset](https://huggingface.co/datasets/hesamation/crusader-arena-runs).
- **Prompt fixes from the 1.5 runs.** The sell prices the prompt lists for net worth leave
  out wheat and hops (8 each), so Kimi K3 took them as worthless, and the prompt says the
  settlement is judged on net worth, population and popularity with unstated weights while
  the published score is net worth alone. Also decide whether the prompt should say that
  peasants stop arriving while 24 stand idle, which stalled every model's population.
- **Tool fixes from the 1.5 runs.** `find_sites` searches only the current view and
  placing on a tile off screen fails, which cost Claude Haiku 5.5 its iron mines: search
  the whole map's tile data and let `build_structure` move the camera itself. The rule
  that ends a run after four replies without tools ended GLM 5.3 Flash's run 5 game
  seconds early, so the last seconds should not count.

## Later

- **Play against enemies.** Single-player games against the game's computer-controlled
  lords, with military and defence scoring. The reader will need to tell the agent's
  buildings and troops from the opponents' and to read enemy messages. Games against
  other players stay refused.
- **Other setups.** Game machines on other Linux distributions or Windows, and other
  window sizes and game builds.
