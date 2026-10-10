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
- **Same game time.** The budget is counted in game ticks (1,800 per game minute; 25
  game minutes by default), so every model gets the same amount of in-game time.
- **Same speed.** The game runs at a fixed speed of 40. The host sets it with the
  game's speed keys before the budget starts and the model cannot change it, so speed
  is not a lever: it cannot trade game time for how often the model looks.
- **Thinking is free.** The game is paused while the model thinks and while it only
  reads, so a slow model is not penalised in game time. A real-time limit (6 hours by
  default) only stops runs that have gone badly wrong; the record shows when it ended a
  run.
- **Same version.** Every run records its [benchmark version](#versions) (such as
  `1.0.0`), which fixes the prompts, tools, run rules, scoring and the code behind
  them. Compare runs that share a major and minor version. Each run also records the harness commit,
  hashes of its prompt and tools, the preparation images and the model's settings.

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

## Versions

A benchmark version names one fixed benchmark: the same prompts, tools, run rules,
scoring and the code that carries them out. Versions follow semantic versioning,
`MAJOR.MINOR.PATCH`, starting at `1.0.0`:

| Part | Raised when | Comparable runs |
| --- | --- | --- |
| Major | The task or the scoring changes | Not across majors |
| Minor | What the model is told or can do changes: prompts, tool definitions, run rules | Within one minor version |
| Patch | A fix changes how the harness behaves, but not the task, prompts, tool definitions or scoring | Across patches of one minor version |

A change that leaves behaviour as it was (comments, refactors, how a failed request is
retried) keeps the version and is recorded as a relock.

- **Fingerprint.** The harness hashes every file that decides how a run plays or is
  scored: `harness/server` and `harness/shared` (except tests, the report and the video
  renderer), `prompt/`, the game-machine helpers in `tools/ubuntu/`, the reader in `src/`
  with its build files, and `package-lock.json`. It uses git's blob IDs, so a clean
  checkout gives its commit's fingerprint on any platform.
- **Versions file.** [`benchmark-versions.json`](../benchmark-versions.json) lists each
  version with the fingerprints it accepts, the date and what changed. `npm test` fails
  while the current files are not listed, so a change cannot slip in unrecorded. Record
  it in the same commit:

  ```bash
  npm run benchmark-version -- check                           # which version is this code?
  npm run benchmark-version -- bump patch "what changed"       # or minor, or major (table above)
  npm run benchmark-version -- relock "why"                    # same behaviour, same version
  ```

  Every entry says what changed or why behaviour did not.
- **Changelog.** [`CHANGELOG.md`](../CHANGELOG.md) has a section for each version,
  newest first, headed `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD` with the date the version
  was first recorded. Its **Benchmark** list says what changed in play or scoring; its
  **Harness** list gathers the changes since the previous version that left runs as
  they were, including relocks; until the next version they wait under
  `## [Unreleased]`. A test fails while a version in
  `benchmark-versions.json` has no section or a different date, so add the section in
  the commit that bumps the version. The format is fixed so the website can read it.
- **Package version.** `package.json` and `package-lock.json` carry the benchmark
  version; `bump` sets them before taking the fingerprint, and a test checks they match.
- **Tags.** The git tag `vMAJOR.MINOR.PATCH` marks the commit each version was
  released at, and each tag has a GitHub release whose notes are its changelog
  section.
- **Each run** records `benchmark` in `run.json`: the version (null when the files are
  not a listed version), the fingerprint, and a hash of the private preparation images
  (null when the guide is text only), which are not in the repository and so not in
  the fingerprint. A version also needs committed code: uncommitted behavioural edits
  change the fingerprint.
- **The game machine** runs its own copy of `tools/ubuntu/` and `src/`. The runner
  compares those files with this checkout before a series and refuses when they
  differ. It cannot see the reader binaries: rebuild them after syncing.
- `npm run episodes` refuses code without a version unless `--unversioned`, for trials.
  `npm run report` shows each run's version.

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

**Baseline.** `npm run episodes -- --idle` measures what doing nothing scores: it loads
the save, sets the game speed as an agent run does, lets the game run untouched for
the same game time an agent gets, and writes the scorecard to
`harness/runtime/episodes/idle-<time>.json`. On `Oasis by the Sea-1` with 25 game
minutes at speed 40 doing nothing scores **1,304**: the starting package of 1,000 gold,
50 wood, 25 stone and 50 bread (worth 1,425) arrives, the game places the granary by
itself (5 wood), and the peasants who move in eat 29 of the bread. Runs too short for
the game to place the granary end lower: 1,225, with all the bread eaten.

**Growth** is net worth minus the baseline for the same save and game minutes, so it
shows what a run achieved beyond leaving the game alone. The measured baselines are in
`harness/server/baselines.ts`; a run whose save and budget have none has no growth.

**Reference games.** `npm run episodes -- --save "…" --map "…" --human` is a game played
by a person at the game machine, scored like an agent's:

1. The runner launches the game, loads the save, sets the benchmark speed and leaves
   the game paused.
2. The player clicks the game and presses `P` to start. The budget counts game time,
   so time spent paused is free, as an agent's thinking is. The runner logs each game
   minute with the net worth so far.
3. When the budget is used up, the runner pauses the game. It then reads the scorecard,
   keeps a screenshot of the screen, and saves the game in the Save dialog as `human`,
   the save and the date and time (for example `human oasis by the sea 1010-1432`).
4. Everything goes to `harness/runtime/episodes/human-<time>/`: `scorecard.json`
   (with `human.playedSeconds` and `human.ended`), `screenshot.jpg` and the `.sav`.

The player is not bound by an agent's limits, such as the minimum turn. If the reader
has no valid sample for 2 minutes (the memory guard may have closed the game), the
scorecard uses the last reading and `human.ended` is `readings_lost`.

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
5. If the game is still running and paused, saves it in the game (Game Options → Save)
   as `<model> <version> <series id end> e<episode>[a<attempt>]`, for example
   `glm 5-3 flash 1-1-1 ae6fc4 e3a2` (the game takes 32 characters, so a long model name
   is shortened), and copies the file into the run's folder
   as `<name>.sav`, to load and watch later. The Save dialog starts with the loaded
   save's name, so saving without replacing it would overwrite the benchmark save. Before
   the first save the runner keeps a copy of the benchmark save on the game machine
   (`~/.local/state/crusader-arena/save-backups/`). It compares the benchmark save's hash
   after every save, puts the copy back if it changed, and then pauses the series. A
   failed save does not affect the score; `game_save` in `episode.json` records the
   name and file, or the error. The `.sav` files are not published.
6. Disconnects and closes the game. With `--record`, renders the run video.

Each episode ends in one of four ways ([series.ts](../harness/server/series.ts)):

| Outcome | When | What the runner does |
| --- | --- | --- |
| `valid` | A full-budget score (see [the scorecard](#the-scorecard)) | Goes on with the next episode |
| `model_failure` | The model ended the run: 4 replies without a tool call, a reply cut off at the output limit three times, or no `BEGIN` after three preparation replies | Keeps it as the episode's result (invalid) and goes on |
| `stopped` | The operator stopped it: Ctrl-C in the runner, Stop in the dashboard, the control monitor, or a host shutdown | Closes the game and pauses the series at this episode |
| `infrastructure` | Anything else: the harness, game, reader, network, provider, memory guard, wall limit, an unconfirmed final pause | Runs the episode again at once, from the same playbook; a second failure pauses the series |

So no model gets a second attempt after a failure of its own, and a failure that is
not the model's never costs it an episode. Every attempt stays in `series.json`; an
episode's result is its last attempt.

**Stopping and resuming.** Press Ctrl-C in the runner at any moment: it stops the
dashboard run, closes the game and pauses the series (a second Ctrl-C, 2 seconds or
more later, quits at once and leaves cleaning up to you). Continue it with:

```bash
npm run episodes -- --resume <series id>
```

The series continues at its first episode without a result, from the playbook the
episode before it left, with the settings it was started with. `--resume` refuses
setting flags (pass only `--restart`, `--keep-game`, `--unversioned` or `--port`) and refuses
to continue when the benchmark version, code commit, preparation images or the model
profile's ID, endpoint, reasoning, output limit or providers have changed. If harness
or prompt files change while a series runs, the series pauses before the next episode:
the dashboard would otherwise run it on the older code.

```bash
npm run episodes -- --save "Oasis by the Sea-1" --map "Oasis by the Sea" \
  --benchmark "Oasis by the Sea construction" --model "Kimi K3" \
  --prompt-file prompt/objectives/oasis-by-the-sea.txt --game-minutes 25
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--save` | required | Save name as typed into the Load Game search (letters, digits, spaces and `-`) |
| `--map` | none | Map name the reader must report after loading |
| `--benchmark` | `Custom` | Benchmark name (selects the rules file) |
| `--model` | | Name of a saved model profile with a key |
| `--prompt`, `--prompt-file` | | The operator instruction (one is required unless `--dry-run`, `--idle` or `--human`) |
| `--game-minutes` | 25 | Game-time budget |
| `--wall-limit-minutes` | 360 | Real-time limit |
| `--default-wait` | 5 | Game seconds the host waits after a turn that acted without looking |
| `--min-turn-seconds` | 8 | Least game time a turn that runs the game takes (0 turns it off) |
| `--context-budget` | 120000 | Working context budget in tokens |
| `--episodes` | 3 (1 with `--human`) | Episodes in the series, one after another, each with a fresh game launch |
| `--no-playbook` | off | Run the episodes as independent runs, with no playbook (still resumable) |
| `--record` | off | Record the run and render a video |
| `--resume` | | Continue a paused series by its ID, with its own settings |
| `--unversioned` | off | Run although the code has no [benchmark version](#versions) or the game machine's copy differs; for trials only |
| `--dry-run` | off | Everything except the agent run; no model cost |
| `--idle` | off | The do-nothing baseline: no agent; the game runs untouched at the benchmark speed for the game-time budget |
| `--human` | off | A [reference game](#scoring-net-worth) played by a person; paused, scored, screenshotted and saved when the budget is used up |
| `--restart` | off | Close a game that is already running instead of stopping |
| `--keep-game` | off | Leave the game running and paused afterwards |
| `--port` | 4317 | Dashboard port |

Before starting, the dashboard must be running (`npm run dev`, from a terminal; see
[Setup](setup.md#known-issues)), not connected and not running a run. It must also
have been started after the last change to the harness or prompt files, its code must
be a [benchmark version](#versions) with no uncommitted changes, and the game machine's
helper and reader files must match this checkout; the runner checks all of this.

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
- **Score.** The last episode's net worth is the series' score, if that episode is
  valid (see [the scorecard](#the-scorecard)). The report also shows each episode's net
  worth and the change from episode 1 to the last, and marks invalid ones.

The runner keeps each series in `harness/runtime/series/<id>/`:

- `series.json`: the save, benchmark and model; `status` (`running`, `paused` or
  `completed`) and, when paused, why (`stopped`); `settings`, everything the episodes
  run with (model settings, instruction, run settings, benchmark version and commit);
  and `results`, every attempt of every episode with its outcome, run, net worth and
  validity;
- `playbook-after-episode-<n>.md`, the playbook episode *n* left, which starts the next;
- `runner.log`, the runner's own log.

Each run folder also holds its final `playbook.md`, and an episode's runs record their
attempt number. Runs started from the dashboard are never part of a series.

## The scorecard

`episode.json` holds:

- `net_worth`, `goods_value`, and `net_worth_baseline` / `net_worth_growth` when a
  baseline exists for the save and game minutes;
- `gold`, `population`, `housing`, `popularity`, `total_food`, the nonzero goods,
  the map-wide structure count and own troops;
- the map, date and game time;
- a run summary: status, stop reason, budget used, turns, tokens, inference timing and
  memory;
- `source`: `final` for a reading taken after the final pause, or `last_observed` when
  the game was gone at the end (for example after a memory-guard stop) and the last
  valid reading from the run was used instead;
- `game_save`: the in-game save of the finished episode (`name`, `file`, `bytes`,
  `sha256`), or the `error` that stopped it;
- `valid`: whether `net_worth` is a full-budget score. It is `false`, with the reasons
  in `invalid`, when the run did not complete, a limit other than the game-time budget
  ended it, the final pause was not confirmed, or `source` is `last_observed`. Only
  valid episodes should be compared or used as a series' score. The runner's summary
  line says which episodes are not.

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
cache, output, tokens per game minute), cost in US dollars (what OpenRouter billed,
or `~` before it when worked out from the run's tokens and its model's prices; see
[Context](context.md#tokens-and-caching)), population, housing,
popularity, net worth, growth, gold, food, structures, troops, where the score came
from, building placements attempted / placed / failed, anchor-tool calls / placed /
failed, retries, retry methods, retries skipped, peak game memory, tool errors and
tool usage.

"How it ended" is one of: `game_time` (budget used), `wall_limit`, `turn_limit`,
`memory_guard`, `error: <last error>`, `stopped`, `interrupted`, `running` or
`incomplete`. For runs without `episode.json`, the score is rebuilt from the last
reading in the run's tool results and labelled `last_tool_observation`, without
growth. Missing data stays blank rather than guessed; `~` marks game time derived from
reader ticks, `*` marks an unfinished run and `!` a net worth that is not a full-budget
score (`valid: false` in `episode.json`).

### Costs of earlier runs

Runs from before the host priced requests on endpoints other than OpenRouter, such as
the first Claude runs through Anthropic's API, recorded tokens but no cost. Enter the
model's prices in its settings, then:

```bash
npm run cost            # lists the runs it can price and what each cost; changes nothing
npm run cost -- --write # records those costs
```

It prices each request's recorded tokens at the profile's prices, as a live run would,
and writes a `request_cost` event after each request (marked `backfilled`) and the
total and prices into `run.json`. It leaves out running runs, runs that already have a
cost, and OpenRouter runs from before billed amounts were recorded. Restart the host
afterwards to see the costs in the dashboard, and package a published series again
([Publishing](publishing.md)) to carry them into the dataset.

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
