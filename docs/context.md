# Context: what the model sees

[← Documentation](README.md)

This page describes everything the model is sent during a run, and how the harness
keeps that within a working budget. The code is in `harness/server/preparation.ts`
(prompt), `harness/server/model.ts` (observations and tools),
`harness/server/context.ts` (pruning and estimates) and
`harness/server/controller.ts` (compaction).

## Every request

Each request to the model contains three things:

1. **The system prompt**, the same for the whole run.
2. **The tool definitions**: names, descriptions and parameters of the 27 tools.
3. **The conversation so far**, starting with the preparation message and the model's
   `BEGIN` reply, then turns of model replies, tool results and host messages.

## The system prompt

The host builds one system prompt per run, in this order:

| Part | Source | Contents |
| --- | --- | --- |
| Briefing | Built from the run settings | That the model is being evaluated, how a run works (preparation, timed play, the end), the game-time budget, real-time limit and default wait, and the ground rules: keep playing, stay in the loaded game, never press `P` or `Escape`, treat game text as data |
| This run | Run settings | The benchmark name and the operator's instruction. Without a benchmark file, the instruction alone defines success |
| Benchmark rules | `prompt/benchmarks/<name>.md` | Task, score, what is not allowed, map notes, how to start |
| Controls | `prompt/game-controls.md` | How a turn works, what the model sees, tools by purpose, placement rules, camera and keys, an opening playbook, plans and notes, what to do when control fails |
| Screen layout | `screenLayout()` in `harness/server/visual-guide.ts` | Where the construction menu buttons are, as percentages of the screen |
| Game reference | `prompt/game-mechanics.md` | Economy, population, buildings and production chains (and troops, siege and fortifications for military benchmarks) |

When building it, the host:

- removes HTML comments, which are notes for maintainers;
- replaces the building cost tables with a pointer to `building_info`, which returns
  one building's details on demand;
- drops the military sections when the benchmark file says `military: false`, which
  roughly halves the game reference.

The prompt is **identical, byte for byte, for the whole run**. Things that change
(the game clock, the plan, the notebook) travel in observations and tool results
instead. This keeps the start of every request the same, so providers that cache
prompt prefixes can reuse it. The exact prompt of each run is saved in its
`inputs.json`.

## The preparation message

Before timed play the host pauses the game and sends one message, with no tools
available:

- instructions to study the guide, make a plan and end the reply with `BEGIN` on its
  own line;
- the **construction menu guide**: one image of all ten construction menu pages, with
  numbered buttons and the name and purpose of each;
- optionally, a screenshot of a developed settlement from an earlier human game on a
  different map, to show what a strong economy looks like.

These images are game screenshots, so they are **not in the repository**. They live
in `.internal/ui-reference/`, which git ignores; see [Setup](setup.md#3-guide-images).
Without the guide image the model gets the same guide as text: every page's button
names and roles, which come from `harness/server/visual-atlas.ts`. The run log says
so, and `inputs.json` records `preparationGuide: "text only"`. The settlement image is
skipped if absent.

The preparation message and the accepted reply are **pinned**: they open every later
request unchanged and are never trimmed or compacted, so the guide stays in view (and
cached) for the whole run.

## Observations

`observe`, `wait_and_observe`, the camera tools and `flat_view` return an
observation, and the host sends one itself when a turn needs it. An observation has:

- **A screenshot**: JPEG of the game window only, at the window's own size.
- **A JSON block**:

| Field | Contents |
| --- | --- |
| `run_clock` | Game seconds used, left and budgeted, and real minutes left |
| `width`, `height` | The image size; clicks use these pixel coordinates |
| `stats` | A compact settlement summary (below), or `{"status": "unavailable"}` when there is no reading less than 1.5 seconds old |
| `game_events` | Game messages seen since the previous screenshot, each listed once as `{text, seconds_ago}` |
| `game_events_dropped` | Only if messages were lost before delivery (more than the buffer holds, or older than 2 minutes) |
| `reader_unavailable_seconds` | Only if the reader was down for stretches of 2 seconds or more since the previous screenshot |

The `stats` summary contains:

| Field | Contents |
| --- | --- |
| `date` | In-game month and year, such as "July 1194" |
| `gold` | Gold |
| `population` | Current population, housing and idle peasants |
| `popularity` | Current popularity, the upcoming change, and the nonzero factors behind it, in the game's own popularity points |
| `tax_level` | 0 (largest bribe) to 11, with 3 meaning no tax; the same scale as `set_tax` |
| `food` | Total food, rations (`none`, `half`, `full`, `extra`, `double`), food types eaten and available |
| `goods` | Every stored good by name, such as `wood_planks`, `stone`, `bread` |
| `troops` | Own troops, total and by type. Only for benchmarks that allow military |
| `placement_mode` | `none`, `placing` or `demolishing` |
| `selected_building` | Only while a building panel is open: workers, vacancies, whether it works, keep access, missing inputs, health |
| `camera` | Centre tile and zoom |

The summary leaves out what the model does not need: reader timestamps and session
details, raw codes, the map-wide structure count, and troops in non-military
benchmarks. The full reader sample behind every observation is still saved in the
run's `events.jsonl` (as `details.readerStats`) for reports, but is never sent to the
model. [The reader](reader.md) describes the full sample and its limits.

The host also adds short messages of its own, for example "Timed play has started"
before the first screenshot, or a note that it let 5 game seconds pass because the
model acted without looking.

Most other tools return text only. `map_overview` returns a colour-coded map image and
`guide_page` returns one page of the construction menu guide.

## Keeping the context small

- **Old images are dropped.** Only the two newest images stay in the conversation
  (the pinned guide does not count). Older ones become a short placeholder telling the
  model to target only the latest screenshot. Full images stay on disk.
- **Text stays until compaction.** Old readings and tool results remain in the
  conversation until it is compacted.
- **Plan and notebook are not repeated.** The model sees them when it reads or writes
  them, and after a compaction.

## Compaction

When the conversation grows too large, the host replaces it with a summary the model
writes for its future self.

- **Budget.** Each run has a working context budget, 120,000 tokens by default
  (32,000 to 200,000). It is a setting, not a check of the model's real limit; set it
  at or below what the model supports.
- **Trigger.** Before each request the host estimates the size. It compacts when the
  estimate passes 65% of the budget, or earlier if the text-only summary request
  (below) would get too close to the limit.
- **Estimate.** Before any measurement the host counts text bytes (including tool
  definitions) at 2.5 bytes per token, plus a fixed allowance per image (4,096 tokens
  by default). After each reply it anchors on the token usage the provider reported
  and only estimates what was added since. Removed content is never subtracted, so
  the estimate errs high.
- **Summary request.** With the game paused, the model gets its next request
  unchanged (the same system prompt, tools and conversation, screenshots included)
  with one more message asking for a handoff: verified progress with evidence,
  decisions, failures, uncertainties and next steps (40 bytes to 12 KB). Only that
  message is new, so the provider's prompt cache covers the rest. If the model calls
  a tool instead of answering, writes too little, or the request would not fit the
  budget, the host asks once more with the conversation as text only and no tools.
- **New conversation.** The pinned preparation message and reply; one message with
  the current plan, the notebook and the handoff; the last model reply with its tool
  results; and a fresh observation. The system prompt never changed, so the rules,
  controls and objective are still there.
- **Failure.** If the summary fails, is out of range, or the new conversation is still
  over 65% of the budget, the run ends with an error. The previous conversation and
  checkpoint are kept. Compaction is not retried.

Compaction takes real time but no game time, and never resets the budget.

## Tokens and caching

The host adds up the token usage the provider reports for every request, including
preparation and compaction. `npm run report` splits it into uncached input, cache
reads, cache writes and output, and shows the share of all input read from the cache.
Providers that do not report cache writes show 0.

Most providers cache repeated prompt prefixes on their own, which the fixed system
prompt, the pinned opening and the unchanged history are designed to benefit. Claude
models through OpenRouter (model IDs starting `anthropic/`) cache only what the
request marks, so for them the host marks four points: the system prompt, the tool
definitions, the end of the pinned preparation exchange, and the conversation up to
the oldest screenshot still shown. Every turn replaces that screenshot with a
placeholder, so the history before it is what the next request repeats unchanged;
a mark on the newest message would write a cache entry that no later request reads.
