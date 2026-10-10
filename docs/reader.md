# The game-state reader

[← Documentation](README.md)

The reader gives the agent and the harness the numbers a player reads off the game's
panels: gold, stored goods, population, popularity, the date, troops, messages. It
also tells the harness whether the game is paused, which the run loop depends on.

## How it works

Stronghold Crusader: Definitive Edition is a Windows game running under Proton, built
on Unity's Mono runtime. The reader is our own code; no game file is changed, and no
third-party mod is used.

1. `tools/ubuntu/run-proton.py` finds the running game and its Proton environment, and
   starts our Windows launcher inside the same Proton prefix.
2. The launcher (`src/windows/probe.cpp`) checks SHA-256 fingerprints of four game
   files against the build the reader was mapped for, and stops if any differ.
3. It loads our reader DLL (`src/windows/adapter.cpp`) into the game process and calls
   it once per sample. The DLL reads published game fields through the Mono runtime,
   reads everything twice and rejects the sample if the two reads differ.
4. Each sample is printed as one JSON line, and `run-proton.py` adds freshness and
   lifecycle information.

"Read-only" means it never changes game state or calls game functions that do.
Loading the DLL does run our code inside the game process, and when the game's garbage
collector has stalled, the reader asks the runtime for a collection (see
[Collector watchdog](#collector-watchdog)).

The tile map and whole-map summary use a second, simpler path: the probe reads the
engine's tile layers from outside the process (no DLL), in about 2 seconds.

## Single-player only

A sample is accepted only on an active local single-player map. The reader rejects the
main menu, loading screens, multiplayer games, the map editor and spectator mode;
those samples are `unavailable`, never zeros.

## Running it by hand

On the game machine, with the game running:

```bash
python3 tools/ubuntu/run-proton.py watch                     # stream until stopped
python3 tools/ubuntu/run-proton.py watch --samples 20         # 20 samples
python3 tools/ubuntu/run-proton.py watch --interval-ms 100    # sampling interval, 50–5000 (default 500)
python3 tools/ubuntu/run-proton.py probe                     # find the game and check fingerprints only
python3 tools/ubuntu/run-proton.py tiles --region 390 350 60 60  # tile layers for a rectangle
python3 tools/ubuntu/run-proton.py map                       # whole-map tile summary
python3 tools/ubuntu/run-proton.py test                      # run the Windows test programs under Proton
```

Readings go to standard output as JSON lines; diagnostics go to standard error. The
harness samples every 100 ms (`GAME_READER_INTERVAL_MS`); in a live check that cost no
measurable game CPU, memory or speed compared with 500 ms. `watch` does not start the
game or reconnect after the game exits.

## The stream

Each line has a `status`. Only `ok` lines carry an `observation`:

| Status | Meaning |
| --- | --- |
| `ok` | A valid sample |
| `unavailable` | Not on an active single-player map, or the read failed |
| `stale` | The sample was too old or took too long to capture |
| `game_exiting`, `game_exited` | The game is closing or gone |
| `stream_closed` | The reader stopped |

Every line also has a session ID, a `generation`, capture start and end times, the
time it was received and `valid_until_unix_ms`, 1.5 seconds after capture. **Treat a
sample as gone after that time**, even if no newer line arrives, and never keep the
last good sample as current.

The `generation` changes when the map, map name or local player changes, when game
time goes backwards (a reload), and after any rejected sample. Polling can miss a very
short change. Samples are not atomic snapshots: the double read catches most
concurrent changes, not all.

## What a sample contains

This is the full sample the harness receives. The model gets a compact summary of it
with each screenshot (see [Context](context.md#observations)); the full sample is saved
in the run's `events.jsonl`.

| Field | Contents | Notes |
| --- | --- | --- |
| `local_player_id`, `map_name`, `app_mode` | Who and where | Only modes 14 and 16 are accepted |
| `game_time`, `paused` | Game clock in ticks (30 per game second) and pause state | |
| `gold`, `population`, `popularity` | As shown in the game | Checked against the game's panels |
| `tax_index` | Tax level, 0 (largest bribe) to 11 | Not a rate or a gold amount |
| `resources_by_name` | 20 stored goods: wood, hops, stone, iron, pitch, wheat, bread, cheese, meat, apples, ale, flour, bows, crossbows, spears, pikes, maces, swords, leather and metal armour | Each checked against nonzero amounts in the game |
| `own_troops` | Total and 34 named types from the Army Report | Names follow the game's own spellings |
| `settlement` | Month and year, housing capacity, idle peasants, total food, rations, food types eaten and available, popularity factors and upcoming change | Popularity factors are 25 per point shown in the game. `months_of_food` does not match the game's panel; do not use it |
| `selected_building` | Type, workers, vacancies, working, keep access, missing inputs, health; `null` without an open panel | |
| `storage` | The local player's stockpile piles (tile, good, amount, capacity) and granaries (tile, amount, capacity); `null` when unavailable | Read from the engine's building records (below) |
| `structures` | Count and limit | **Map-wide**, including other players; use it only as a change signal |
| `placement` | What is being placed, and in which mode | |
| `camera` | Centre tile, visible tiles across and down, zoom | |
| `visible_messages` | On-screen message text, by channel | See below |
| `managed_heap` | The game's managed heap: size, used bytes, collection count, whether collection is disabled, and the watchdog's forced collections | Memory diagnostics; not shown to the model. See [Collector watchdog](#collector-watchdog) |

## Storage

A stockpile is four buildings: 2×2 piles at the corners of a 5×5 square, each holding
one good. A pile's capacity depends on its good (48 for wood, stone and iron, the only
ones checked); an empty pile reads amount 0 and capacity 0 and takes whichever good
arrives next. When no pile is empty, a good without room in its own piles is not
delivered: the market refuses to buy it and producers stop, and the game shows no text
message. Each granary holds 250 food of all kinds together; an empty granary also reads
capacity 0. All of this was seen live on Oasis by the Sea on 2026-10-09.

The reader takes these from the engine's records of building instances (one per id,
read in place, with no game function called), filtered by an owner field seen only
with player 1. `python3 tools/ubuntu/run-proton.py structures --ids FIRST COUNT` dumps
raw records for mapping more fields; its output is game memory, so keep it out of the
repository.

## Messages

The reader reports message text visible in the game's message areas, and placement
feedback such as "Needs to be placed adjacent to the stockpile". The stream turns
these into events: an event means "first seen on screen", not a guaranteed new game
event, and it repeats only after the text disappears.

Polling can miss brief or repeated messages, and spoken lines without text are never
captured. Placement and resource warnings were checked live. Low-popularity warnings
and enemy messages have not been, and the skirmish chat area is not read.

## Collector watchdog

Under Proton, the game's garbage collector (Unity's Boehm collector, inside Mono) can stop
starting collections for good. The heap then grows by what the game allocates, about
7.5 MiB a second whether paused or running, until the memory guard closes the game (see
[Status](status.md#known-issues)). The cause is
[Wine bug 59333](https://bugs.winehq.org/show_bug.cgi?id=59333): Wine can report a bogus
stack pointer for a thread the collector has suspended, the collector's total of thread
stack sizes wraps around, and the allocation threshold it keeps until the next collection
becomes too large ever to reach. Any collection recomputes that threshold.

So on every call the reader also checks the collection count. When the count has not
moved for 20 seconds while the heap's used bytes grew by 64 MiB, it asks Mono for one full
collection (`mono_gc_collect`, what `System.GC.Collect` does; the game's finalizers stay
on the game's own finalizer thread). Just before, it copies four of the collector's
variables, which tell the causes apart:

| Field | Meaning |
| --- | --- |
| `total_stack_bytes` | The thread-stack total from the last collection; a huge value is the Wine bug |
| `threshold_bytes` | The allocation that starts the next collection (about 23 MiB when healthy) |
| `dont_gc` | Non-zero when collection is disabled |
| `automatic_disabled` | Non-zero when automatic collection is off (Unity's manual mode) |

Their addresses were found by disassembly and hold only for the Mono runtime whose
fingerprint the launcher checks. `managed_heap.watchdog` gives the number of forced
collections in this game process and the latest one, with these fields, how long the
count stood still, how much the heap grew, the counts before and after, and how long the
collection took. The harness logs each one as a `gc_watchdog` event (see
[The harness](harness.md#safety-boundaries)).

About 150 MiB piles up during a stall before the collection frees it; the heap grows by
at most that much, and the game reuses it. The watchdog runs only while the reader is
sampling, as it is whenever the harness is connected.

## Limits

- One game build (see [Setup](setup.md#what-you-need)).
- Not atomic, and expires after 1.5 seconds.
- Single-player only.
- If a reader call is interrupted, restart the game before reading again.
