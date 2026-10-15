# Roadmap

What Crusader Arena plans to do next. [Status](docs/status.md) says what works and is
verified today, and the [changelog](CHANGELOG.md) says what each version changed. When
an item is done it leaves this page and appears in the changelog.

The page has three sections, **Now**, **Next** and **Later**, in that order. Each item is
one bullet that starts with a bold title ending in a full stop, followed by a sentence or
two. The project website shows this file, so keep that shape.

## Now

- **Find the bugs we have not hit yet.** Run more models for longer, and try in the live
  game what is so far only tested in code, starting with what 1.7.0 relies on: that a tick
  played at speed 90 is the same game as at 40, and that people walk through trees, bushes
  and farm fields, as the routes to the keep count them. The 1.6.3 fixes are still to be
  seen live too: `place_near` placing a first Armory, purchases counted while the town eats
  and pays taxes, and the second try at the end-of-run save.
- **Full-length runs.** Keep long runs reliable. None of the 21 runs in the evaluation by
  the morning of 2026-10-13 was cut short by the game: the reader's watchdog broke 16
  garbage-collector stalls in 12 of them. Since then the game has rendered on the game
  machine's NVIDIA GPU, and the 26 evaluation games played there all ran their full game
  time at the first attempt.
- **A better harness.** Improve the tools, prompt and context where recorded runs show
  models getting stuck, make the two machines easier to set up, and play with the
  text-only menu guide that a fresh checkout uses, which no model has used yet.

## Next

- **Tool fixes from the 1.6.2 runs.** `set_workshop` still opened a building drawn in
  front of the workshop four times on The Sinkhole (three times a tall Armory), after
  trying the footprint's back corner and roof: try its side corners too.
- **Version only the benchmark.** Split what a run plays and scores (the prompt, the
  tools and what they do, the run rules, scoring and what the reader observes) from the
  harness that carries it (model requests and caching, cost, the host and dashboard,
  recording, the overlay), fingerprint only the first, and play a round from the newest
  checkout with only its benchmark files taken from the round's commit. Earlier rounds
  would then get harness fixes without changing version, instead of the shims that bring
  the prompt cache key and the run overlay to 1.5.1, 1.5.6 and 1.6.2 today.
- **Other maps.** Scored benchmarks on more of the game's maps beyond Oasis by the Sea,
  Large Barren Desert and The Sinkhole, each with a person's reference game and a
  do-nothing baseline.

## Later

- **Play against enemies.** Single-player games against the game's computer-controlled
  lords, with military and defence scoring. The reader will need to tell the agent's
  buildings and troops from the opponents' and to read enemy messages. Games against
  other players stay refused.
- **Other setups.** Game machines on other Linux distributions or Windows, and other
  window sizes and game builds.
