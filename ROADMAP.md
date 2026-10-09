# Roadmap

What Crusader Arena plans to do next. [Status](docs/status.md) says what works and is
verified today, and the [changelog](CHANGELOG.md) says what each version changed. When
an item is done it leaves this page and appears in the changelog.

The page has three sections, **Now**, **Next** and **Later**, in that order. Each item is
one bullet that starts with a bold title ending in a full stop, followed by a sentence or
two. The project website shows this file, so keep that shape.

## Now

- **Find the bugs we have not hit yet.** Run more models for longer, and try in the live
  game what is so far only tested in code: the fixed game speed in an agent run, the
  minimum turn length while waiting, and the automatic re-run after an infrastructure
  failure.
- **Full-length runs.** Make the default 25 game minutes reliable. Runs longer than 10
  game minutes are not yet stable, because the game can start leaking memory during long
  pauses.
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

## Later

- **Play against enemies.** Single-player games against the game's computer-controlled
  lords, with military and defence scoring. The reader will need to tell the agent's
  buildings and troops from the opponents' and to read enemy messages. Games against
  other players stay refused.
- **Other setups.** Game machines on other Linux distributions or Windows, and other
  window sizes and game builds.
