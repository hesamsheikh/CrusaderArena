# Publishing runs

[← Documentation](README.md)

Runs are published to a Hugging Face dataset, not to this repository: they contain game
footage and take tens of MB each. This repository holds the tools that prepare and upload
them (`tools/dataset/`) and the dataset card (`tools/dataset/card.md`). Bundles are staged in
`harness/runtime/publish/`, which git ignores.

Nothing is sent anywhere until `npm run upload` runs with `--yes`.

## Steps

```bash
pip install datasets                      # Parquet tables and the Hugging Face client
npm run episodes -- --record ...          # a learning series, recorded (see The benchmark)
npm run package -- <series id> --submitter <hugging face user> [--tier official]
npm run upload -- harness/runtime/publish/v1.0/<benchmark>/<model>/<series id>        # dry run
npm run upload -- harness/runtime/publish/v1.0/<benchmark>/<model>/<series id> --yes  # upload
```

1. **Package.** `npm run package` takes learning series ids (`harness/runtime/series/<id>`)
   or run folders, checks them, and stages each one with its tables and a `manifest.json`.
   A bundle with problems is still staged so you can look at it; the problems are printed and
   listed in the manifest.
2. **Review.** Watch the videos and read `manifest.json`: what the scrub changed, and the
   problems.
3. **Upload.** `npm run upload` prints what it would send. With `--yes` it makes one commit
   per bundle; with `--pr` it opens a pull request instead, which is how anyone without
   write access to the dataset submits runs. `--tier official` is for runs made by the
   maintainers; everyone else's are `community`.

The token is `HF_TOKEN` (environment or `.env`), else the login from `hf auth login`. The
dataset is `--repo ORG/NAME` or `HF_DATASET_REPO`.

## What can be published

Packaging records a problem, and the upload refuses the bundle, unless:

- the series is completed and every episode has a result (below);
- every episode's result is a full-budget score (`valid` in its `episode.json`: completed,
  ended by the game-time budget, final pause confirmed, scored from the final reading;
  `invalid` says why not) or a run the model itself ended (outcome `model_failure`, published
  with `valid` false);
- every episode has `video.mp4` (record with `--record`);
- the runs' code was committed (`harness.dirty` is false) and every commit is on
  `origin/main` as last fetched, so anyone can see the code that ran;
- the runs carry a benchmark version (below);
- all episodes of a series share the benchmark minor version and preparation guide,
  the prompt and tool hashes, the model and its settings, and the run settings;
- the model endpoint is not a local address, and `--submitter` gives a Hugging Face user
  name;
- the scrub (below) found nothing to report.

The upload also refuses a bundle without a version, and one whose files changed after
packaging: every file's size and SHA-256 must match `manifest.json`. It never replaces a
bundle already in the dataset.

## Versions and attempts

The host stamps every run with the benchmark version its code belongs to (`run.json`
`benchmark.version`, from [`benchmark-versions.json`](../benchmark-versions.json); see
[Versions](benchmark.md#versions)), `MAJOR.MINOR.PATCH`. It is null when the code's
fingerprint is not a listed version; such runs are staged under `unversioned/` and cannot be
uploaded. Runs compare within one minor version, so bundles are staged under
`v<major>.<minor>/` and the exact version is in the `dataset_version` column; the episodes of a
series may differ only in the patch.

An episode of a series can run more than once: a stop or an infrastructure failure is run
again. The series keeps an episode's last attempt that is a full-budget score or a model
failure as its result (`harness/server/series.ts`), and that is the run published; earlier
attempts are not published and are not problems. An episode without a result yet, or a series
that is `running` or `paused`, is. The series folder's `runner.log` is not published.

## Scrubbing

Every text file a bundle publishes (`.json`, `.jsonl`, `.md`) is scrubbed by
`tools/dataset/scrub.py`:

- **Replaced** with placeholders: the game machine's SSH target and address (`<game-host>`)
  and source path (`<game-root>`) from `.env`, and this machine's home directory (`<home>`)
  and host name (`<hostname>`). Only values with a `/`, `.`, `@` or `:` are replaced; a plain
  word such as a short host name could be ordinary text, so it is reported instead.
- **Dropped:** `pid` and `windowId` (the game's process and window on the game machine),
  `system` and `graphics` in memory samples (machine-wide memory, the graphics driver and
  PCI device), and `directory` fields holding an absolute path (the recorder logs where it
  kept its frames).
- **Reported**, which blocks the upload: the API keys in `.env` and saved model profiles,
  other key-shaped strings (`sk-`, `hf_`, GitHub and AWS keys, bearer tokens, private keys),
  the local and game-machine user names, home and user runtime paths, IP addresses other than
  loopback, and email addresses. Findings name the file, line and kind, never the value.

Screenshots are base64 inside the logs; strings of 512 or more base64 characters, and
`data:image` URLs, are skipped, so letters inside an image are never a finding. Lines that
need no change are copied byte for byte. If text the video is drawn from (`run.json`,
`episode.json`, `events.jsonl`) was replaced, the video is rendered again from the scrubbed
files and the original `recording/`; without `recording/` that is a problem.

## The dataset

```
v<major>.<minor>/<benchmark>/<model ID with "/" as "--">/<series id>/
  series.parquet  series.json  playbook-after-episode-<n>.md  manifest.json
  episode-<n>/
    episode.parquet  timeline.parquet  final-overview.jpg  video.mp4
    run.json  inputs.json  episode.json  events.jsonl  logs.jsonl  notifications.jsonl
    memory.json  notebook.md  playbook.md
```

A single run that is not part of a series is staged as `run-<start time>-<id>/episode-1/`.
Not published: `recording/` (the raw frames; the video replaces them), `checkpoint.json`
(the conversation again) and `controls-guide.html`.

The dataset card defines three tables, read by the Hub's viewer and by `load_dataset`:

| Table | Rows | Holds |
| --- | --- | --- |
| `series` | One per learning series | Net worth per episode, the score (last episode), change from episode 1, totals of cost, tokens, time, turns and tool calls, the final playbook, the last final image |
| `episodes` | One per episode | Model, settings, benchmark version and harness version; the attempt and its outcome; how the run ended and whether it is a full-budget score; the scorecard and every good; game, wall and inference time; tokens by kind, cost; turns, compactions, tool calls in total and by tool, errors, building and anchor-tool results; the final image; paths of the video and files |
| `timeline` | One per game minute of each episode | Gold, net worth, population, housing, popularity, food, structures, troops, date and every good, with the tokens, cost, turns, tool calls and tool errors spent by then |

Column lists are in the [dataset card](../tools/dataset/card.md). The numbers in `series` and
`episodes` come from the same code as `npm run report` (`harness/server/run-report.ts`), so
the two always agree.

**The timeline** is read from `events.jsonl`: the stats in each host observation (stamped
with the budget clock), reader samples in tool results (stamped with a game tick, placed on
the budget clock from the final reading) and the final reading (from `episode.json` when the
log's final reading came back empty). The grid follows the budget. Row `m` is the latest reading
at or before `m` game minutes; row 0 is the first reading and the last row the final one.
Readings come from the agent's turns, so a minute without a fresh reading repeats the one
before, and `sample_game_seconds` shows when it was taken. Net worth uses the marketplace
sell prices in `harness/server/market-prices.ts`.

## Checks

```bash
python3 -m unittest discover -s tools/dataset
```

The tests build a small series and check the layout, the tables, the timeline, the scrub, the
problems that block an upload, and the upload itself against a fake Hub client. One test runs
`npm run report`'s code on a made-up run to check the fields packaging reads.
