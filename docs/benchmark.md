# The benchmark

[← Documentation](README.md)

The benchmark asks a model to build and run a medieval economy from a fixed starting
save, within a fixed amount of **game time**, using only screenshots and mouse and
keyboard tools. It tests whether a model can turn what it sees into a sequence of
working actions in a real-time strategy game: find space, place buildings that the
game accepts, keep workers fed and housed, and grow.

## What makes runs comparable

- **Same start.** Every episode launches the game fresh and loads the same save by
  name.
- **Same game time.** The budget is counted in game ticks (1,800 per game minute), so
  every model gets the same amount of in-game time.
- **Thinking is free.** The game is paused while the model thinks and while it only
  reads, so a slow model is not penalised in game time. A real-time limit (60 minutes by default) stops runs
  that take too long; the record shows when that limit ended a run.
- **Same tools and prompt.** Every model gets the same system prompt, tools and guide
  for a given benchmark and harness version. Each run records the harness commit and
  hashes of its prompt and tools, plus the model's settings, so a comparison can
  check it is like for like.

## Scenarios

A run's **benchmark name** selects its rules: the host lowercases it, turns other
characters into `-`, and loads `prompt/benchmarks/<name>.md` if it exists. "Oasis by
the Sea construction" loads `oasis-by-the-sea-construction.md`. Without a rules file,
the operator's instruction alone defines the task.

| Benchmark | Save | Task | Scored |
| --- | --- | --- | --- |
| Oasis by the Sea construction | `Oasis by the Sea-1` | Grow the economy as far as possible | Yes: net worth |
| Cactus Valley construction | `Cactus Valley-1` | Build a basic working settlement: granary, stockpile, wood, housing, food | No (diagnostic) |
| Free build construction | `A Mightier Oasis-1` | Make visible construction progress | No (diagnostic) |

All three are Free Build games saved at the very start of play, with soldiers and
defences not allowed. The starting goods are still arriving when a save loads:
`Oasis by the Sea-1` shows 120 gold and 12 wood, and the rest of the package arrives
within about 25 game seconds: wood first, then stone, bread and the last of the gold
(see [Scoring](#scoring-net-worth)). The Oasis rules tell the model this, and the game
reference tells it that starting goods rise at first.

The saves are not included. To make one, start a Free Build game on that map and save
it straight away under the exact name in the table. A save made later starts from a
different position, so its runs are not comparable. `npm run episodes` loads a save
by typing its name into the game's Load Game search box, so names may contain only
letters, digits, spaces and hyphens.

The no-military rule is an instruction in the prompt. The harness does not offer
military buildings in its placement tools, but it does not block a model that clicks
them by hand. The scorecard reports troop counts.

## Scoring: net worth

The scored benchmark ranks runs by **net worth** when the run ends: gold, plus every
stored good valued at the game's marketplace sell price per unit.

| Good | Gold per unit | Good | Gold per unit |
| --- | --- | --- | --- |
| Wood | 1 | Bread, cheese, meat, apples | 4 |
| Stone | 7 | Ale, flour | 10 |
| Iron | 23 | Hops, wheat | 8 |
| Pitch | 10 | Spears | 10 |
| Bows | 15 | Pikes | 18 |
| Crossbows, maces, swords | 30 | Leather armour | 12 |
| Metal armour | 30 | | |

The prices are a fixed table in the game (no difficulty or demand effects), read from
the game code and spot-checked in play. They are in `harness/server/market-prices.ts`.

**Growth** is net worth minus the starting package: 1,000 gold, 50 wood, 25 stone and
50 bread, worth 1,425. The package arrives within about 25 game seconds of loading,
so it is a fixed constant rather than a reading at load time.

Population, popularity, food and buildings are reported beside the score but do not
count. Buildings matter only through what they produce. Buying at the marketplace
lowers net worth (the buy price is higher than the sell price); selling leaves it
unchanged.

## Running episodes

`npm run episodes` runs a learning series of episodes (3 by default) without an
operator. For each episode it:

1. Starts the game through Steam on the game machine and connects to it.
2. Waits out the startup screens, opens Load Game, searches for the save by name and
   loads it (up to 3 attempts), then confirms the map with the reader.
3. Pauses the game and starts the agent run with the given budget.
4. When the run ends, takes the final reading and writes the scorecard,
   `episode.json`, into the run's folder.
5. Disconnects and closes the game. With `--record`, renders the run video.

A failed episode is recorded and the series goes on with the next.

```bash
npm run episodes -- --save "Oasis by the Sea-1" --map "Oasis by the Sea" \
  --benchmark "Oasis by the Sea construction" --model "Kimi K3" \
  --prompt-file prompt/objectives/oasis-by-the-sea.txt --game-minutes 10
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--save` | required | Save name as typed into the Load Game search (letters, digits, spaces and `-`) |
| `--map` | none | Map name the reader must report after loading |
| `--benchmark` | `Custom` | Benchmark name (selects the rules file) |
| `--model` | | Name of a saved model profile with a key |
| `--prompt`, `--prompt-file` | | The operator instruction (one is required unless `--dry-run`) |
| `--game-minutes` | 10 | Game-time budget |
| `--wall-limit-minutes` | 60 | Real-time limit |
| `--default-wait` | 5 | Game seconds the host waits after a turn that acted without looking |
| `--min-turn-seconds` | 8 | Least game time a turn that runs the game takes (0 turns it off) |
| `--context-budget` | 120000 | Working context budget in tokens |
| `--episodes` | 3 | Episodes in the series, one after another, each with a fresh game launch |
| `--no-playbook` | off | Run the episodes as independent runs, with no playbook and no series |
| `--record` | off | Record the run and render a video |
| `--dry-run` | off | Everything except the agent run; no model cost |
| `--restart` | off | Close a game that is already running instead of stopping |
| `--keep-game` | off | Leave the game running and paused afterwards |
| `--port` | 4317 | Dashboard port |

Before starting, the dashboard must be running (`npm run dev`, from a terminal; see
[Setup](setup.md#known-issues)), not connected and not running a run. It must also
have been started after the last change to the harness or prompt files; the runner
checks this.

## Learning series

The episodes of a series play the same save, each from the start. One thing carries
over: the agent's **playbook**, Markdown notes of up to 8 KB, which measures how much
the agent learns from playing.

- **Start.** The preparation message says which episode of how many this is and shows
  the playbook as the previous episode left it (empty in the first).
- **During play** the agent can read and change the playbook with `playbook_read`,
  `playbook_write` and `playbook_edit` ([Tools](tools.md#memory)). They cost no game
  time.
- **After the episode** the host shows the agent the final reading, net worth
  included, and its playbook, and asks for the complete next version. The request
  repeats the last gameplay request plus that message, so it is cached like the
  compaction request. If the model calls a tool instead, it is asked again as text
  only. A reply that is empty or over 8 KB leaves the playbook as the agent last wrote
  it during play.
- **Score.** The last episode's net worth is the series' score. The report also shows
  each episode's net worth and the change from episode 1 to the last.

The runner keeps each series in `harness/runtime/series/<id>/`: `series.json` (the
save, benchmark, model and each episode's run, status and net worth, or its error) and
`playbook-after-episode-<n>.md`. Each run folder also holds its final `playbook.md`.
Runs started from the dashboard are never part of a series.

## The scorecard

`episode.json` holds:

- `net_worth`, `goods_value`, and `net_worth_start` / `net_worth_growth` (Oasis only);
- `gold`, `population`, `housing`, `popularity`, `total_food`, the nonzero goods,
  the map-wide structure count and own troops;
- the map, date and game time;
- a run summary: status, stop reason, budget used, turns, tokens, inference timing and
  memory;
- `source`: `final` for a reading taken after the final pause, or `last_observed` when
  the game was gone at the end (for example after a memory-guard stop) and the last
  valid reading from the run was used instead.

Runs started from the dashboard do not write `episode.json`.

## Comparing runs

`npm run report` prints one Markdown table with a row per run and, when the runs
include learning series, a second table with a row per series: net worth by episode,
the final episode's net worth (the series' score), the change from episode 1, and the
series' cost. It only reads files, so it is safe to run during a benchmark.

```bash
npm run report                                              # every run under harness/runtime/runs
npm run report -- --benchmark "Oasis by the Sea" --model kimi --since 2026-10-01
npm run report -- --runs /path/to/runs --json > report.json
```

Filters ignore case and punctuation. `--model` matches the profile name or the
provider's model ID; `--since` takes an ISO date or time.

Columns, in order: run, start time, model, model settings (reasoning, output limit,
providers), harness version (commit, uncommitted-change hash, and prompt and tool
hashes), benchmark, map, how it ended, game seconds, wall seconds, turns, tokens
(total, uncached input, cache reads, cache writes, the share of input read from the
cache, output, tokens per game minute), cost in US dollars as the provider billed it
(OpenRouter reports it; other providers leave it blank), population, housing,
popularity, net worth, growth, gold, food, structures, troops, where the score came
from, building placements attempted / placed / failed, anchor-tool calls / placed /
failed, retries, retry methods, retries skipped, peak game memory, tool errors and
tool usage.

"How it ended" is one of: `game_time` (budget used), `wall_limit`, `turn_limit`,
`memory_guard`, `error: <last error>`, `stopped`, `interrupted`, `running` or
`incomplete`. For runs without `episode.json`, the score is rebuilt from the last
reading in the run's tool results and labelled `last_tool_observation`, without
growth. Missing data stays blank rather than guessed; `~` marks game time derived from
reader ticks and `*` marks an unfinished run.

## Limits

- **One environment.** The benchmark has only run on one Ubuntu machine with one game
  build. See [Status](status.md).
- **Single reading.** The score is one reader sample after the final pause. Reads are
  checked twice but are not atomic snapshots.
- **No control of randomness.** Neither the game's nor the model's randomness is
  fixed, so the change across a series mixes learning with chance. Run several
  series, or compare with a series run with `--no-playbook`.
- **Harness versions.** Prompt and tool changes affect results. Compare runs with the
  same Harness value in `npm run report`.
- **The memory guard can end a run early** (see [Status](status.md#known-issues));
  the scorecard then uses the last valid reading.
- **Not built yet:** scores for the diagnostic benchmarks, military or defence
  scoring, rankings across runs, and a published comparison of models.

## Adding a benchmark

Create `prompt/benchmarks/<name>.md`. Start it with front matter; `military: false`
removes the troop, siege and fortification sections from the game reference:

```markdown
---
military: false
---
# Benchmark: <title>

**Task.** ...
**Score.** ...
**Not allowed.** ...

## The map
## Start
```

Then start runs with the matching benchmark name. Automatic scoring exists only for
net worth; a new scoring rule needs code in `harness/server/episodes.ts`.
