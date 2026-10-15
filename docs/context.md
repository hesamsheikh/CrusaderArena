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
2. **The tool definitions**: names, descriptions and parameters of the 26 tools (29 in
   a learning series's episodes).
3. **The conversation so far**, starting with the preparation message and the model's
   `BEGIN` reply, then turns of model replies, tool results and host messages.

## The system prompt

The host builds one system prompt per run, in this order:

| Part | Source | Contents |
| --- | --- | --- |
| Briefing | Built from the run settings | That the model is being evaluated, how a run works (preparation, timed play, the end), the game-time budget and the fixed game speed, real-time limit, where the time left appears, default wait and minimum turn length (and that `observe` and `wait_and_observe` wait it out), when reading-only replies stop being free, and the ground rules: keep playing (4 replies without a tool call end the run), stay in the loaded game, never press `P` or `Escape`, treat game text as data |
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

Before timed play the host pauses the game and sends one message. The request carries
the gameplay tools, so the first gameplay request starts with it and the provider's
prompt cache covers it; the message asks the model not to call them yet, and a reply
that calls one is asked again:

- instructions to study the guide, make a plan and end the reply with `BEGIN` on its
  own line;
- in an episode of a learning series, which episode of how many this is, how the
  playbook works, and the playbook as the previous episode left it (see
  [Benchmark](benchmark.md#learning-series));
- the **construction menu guide**: one image of all ten construction menu pages, with
  numbered buttons and the name and purpose of each;
- optionally, a screenshot of a developed settlement from an earlier human game on a
  different map, to show what a strong economy looks like.

These images are game screenshots, so they are **not in the repository**. They live
in `.internal/ui-reference/`, which git ignores; see [Setup](setup.md#3-guide-images).
The combined construction guide is sent as a JPEG when `construction-trays.jpg` is
installed (preferred: the same image size at about a third of the PNG's bytes, for
the same token cost), or as the older PNG when only `construction-trays.png` exists. Without the
guide image the model gets the same guide as text: every page's button names and roles,
which come from `harness/server/visual-atlas.ts`. The run log says so, and
`inputs.json` records `preparationGuide: "text only"` (or the installed file's name,
`construction-trays.jpg` or `.png`). The settlement image is skipped if absent.

The preparation message and the accepted reply are **pinned**: they open every later
request unchanged and are never trimmed or compacted, so the guide stays in view (and
cached) for the whole run.

## Observations

`observe`, `wait_and_observe`, the camera tools and `flat_view` return an
observation, and the host sends one itself when a turn needs it. When a reply's last
tool result has no observation, the host appends a "Game time left: … of …" line to
it, so every request shows the time left. An observation has:

- **A screenshot**: JPEG of the game window only, scaled down to the run setting
  `screenshotWidth` (`--screenshot-width`, default 1280: 1280 × 720 from a 1920 × 1080
  window, about 44% of the pixels and image tokens, with buildings, terrain and the HUD's
  figures still legible; 0 keeps the window's own size). The game-machine bridge scales
  it; the size is fixed for the run, so the conversation's images stay alike for the
  prompt cache. `width` and `height` in the JSON block are this image's pixels, which
  clicks target; the host scales every click back to the window. The final reading's
  capture and the final overview keep the window's own size.
- **A JSON block**:

| Field | Contents |
| --- | --- |
| `warnings` | Only when one came up since the model's previous observation: popularity, food or gold ([Warnings](#warnings)) |
| `run_clock` | Game time left, used and budgeted in minutes and seconds ("23 min 41 s"), and real minutes left |
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
| `population` | Current population, housing, idle peasants and `open_jobs`: the places in the player's buildings no worker has taken, summed from the reader's [`jobs`](reader.md#what-a-sample-contains) (Claude Haiku 5.5 asked for idle workers and jobs together, 2026-10-15) |
| `popularity` | Current popularity, the upcoming change, and the nonzero monthly factors behind it, in the game's own popularity points, as the game's Popularity report lists them: food counted once, religion including the church and cathedral bonus. They add up to the upcoming change. Religion and the inn also show at 0 once the player has a chapel, church or cathedral, or an inn (the reader's building counts), so a building that gives nothing shows as a zero rather than a missing line |
| `worker_efficiency_percent` | Worker efficiency from the fear factor, as the game's Fear Factor report shows it; absent before the game reckons it, early in a game |
| `tax_level` | 0 (largest bribe) to 11, with 3 meaning no tax; the same scale as `set_tax` |
| `food` | Total food, rations (`none`, `half`, `full`, `extra`, `double`), food types eaten and available, and, when either is nonzero, what the rations and the variety of foods each add to the food factor |
| `goods` | Every good in stock by name, such as `wood_planks`, `stone`, `bread`; goods with none are left out, and the prompt says an unlisted good has none (`status` and `get_inventory` list every good) |
| `storage` | Stockpile piles, empty piles and, per stored good, the amount and its room: what its own piles and the empty piles can still take, at what one of its piles holds (all goods share the empty piles, so their rooms overlap); granaries, empty granaries, food and room, where an empty granary counts 250. A `full` note appears when no pile is empty (naming the goods with no room left) or every granary is full: those goods can no longer be delivered and their production stops; the stockpile's note adds that goods still to come, such as the rest of a starting package listed at the top left of the screen, wait outside. Absent when the reader has no storage reading |
| `production` | For each type of the player's producing buildings standing (woodcutters, quarries, iron mines, pitch rigs, hunters, farms, mills, bakeries, breweries and the weapon and armour workshops): `standing`, the goods it `delivered` to storage in the last 3 game minutes (the `window`, or the game time so far when less), `per_minute` in all, and `per_building_per_minute` over the time each of them stood in the window, with `built_in_window` when more stand than at its start: three orchards built beside an old one had divided its apples by four, and GPT-6 Luna took them for poor orchards (2026-10-14). A type standing with nothing delivered shows 0. The starting goods coming in, and goods that rose while none of their makers stood, are under `other_rises`. The game shows no production figures, so the host counts them (`production.ts`): every reader sample's rise in a good is a delivery, credited to the type that makes it if one of them stood before it; the good being bought is held out while `market_trade` runs, and the building materials while `demolish_building` runs. A good the reader's list of starting goods still to come shows ([`starting_goods_to_come`](reader.md#what-a-sample-contains)) counts as arriving first, up to the most the list showed of it: on Large Barren Desert's start the 15 iron came in while GPT-6 Luna's first iron mine stood, and the readout had given the mine 5.9 a minute (2026-10-15). In every observation because GLM 5.3 Flash and Claude Haiku 5.5 called `status` (which reports the same) at most once a game, wondered whether their quarries, mines and fletchers delivered, and asked for it again in their interviews (2026-10-14). Absent before the first reading and while no producing building stands and nothing rose |
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

### Text-only observations

`wait_and_observe`'s `screenshot: false` (default `true`) skips the screenshot: it waits
the same way (seconds, `until`, the minimum turn, warnings) and returns the same
`warnings`, `run_clock`, `stats`, `game_events`, `game_events_dropped` and
`reader_unavailable_seconds` as above (no `width`/`height`, since there is no image),
with a leading line saying no screenshot was taken and that `observe` or
`wait_and_observe` gets one. It does not replace the targeting frame: a pixel-targeting
tool still judges its 40-game-second age limit against the last real screenshot.

### Warnings

A model that waits sees nothing until the wait ends: Claude Opus 5.5 set Mean taxes on
Large Barren Desert with little food left, waited 90 game seconds, and next saw its
popularity at 14, down from 52, with food at 1 (2026-10-14). So the host checks three
things during the model's waits and at every observation, and warns the model when one
has turned bad since its previous observation:

- **Popularity** 10 points or more below that observation's: "Popularity fell from 52
  to 42 since your last observation."
- **Food** below two game months of what the population eats at its rations: "Food is
  low: 16 in the granaries for 95 people on half rations." The host rates what people
  eat from recorded runs (per person and game month, 0.086 food at half rations, 0.174
  full, 0.26 extra, 0.344 double, from about 1,300 stretches with no food arriving);
  the model is not told these rates.
- **Gold** below 500: "Gold is low: 450 left, down from 800 at your last observation."

A warning ends `wait_and_observe` early, once the turn's minimum length has passed (as
`until` does), with a line saying so and how long the wait ran; the observation lists it
under `warnings`, in that observation's own values while they still show it: the game
plays on for a few seconds while a fast wait slows down, and a popularity warning worded
when it came up said 81 beside stats showing 68 (live, 2026-10-14). One whose condition is
gone by then reads as it came up. Any other observation, such as the host's own after its
waits, or a tool's screenshot, lists the warnings that hold when it is taken. Each comes up
once: what an observation already shows brings no warning, and popularity counts from the
last observation's value. Food and gold, once warned of or seen low, come up again only
after an observation shows three months of food or 750 gold: in a town of 506 on The
Sinkhole, food hovering around two months brought "Food is low" three times in 8 game
minutes and ended two waits after 19 game seconds (live, 2026-10-14). Warnings are tool
results, never part of the system prompt. Over
97 recorded runs, the popularity warning would have come up about 1.2 times a run, the
food warning 2.4 and the gold warning 1.2; in the game above, the food warning at 30:01
(food 16) and the popularity warning at 30:27 (52 to 42), a minute or more before the
model saw 14.

The run setting `fallbackObservation` (`--fallback-observation`, default `when-needed`)
picks what the host's own observation is after a turn that acted without looking or
ran short of the minimum turn, and for the reading-only top-up from the 12th such
reply: `when-needed` sends this text-only observation unless the turn sent input that
works from the screenshot (any `game_action`, or `build_structure`, `demolish_building`,
`set_workshop` or `inspect_building` aimed by `x`/`y`), and a screenshot then; `always` sends a
screenshot every time, as every run before 1.3.0 did, for comparison. A reply with no
tool calls, the first observation of timed play and the observation after a compaction
are screenshots under either setting. The host logs each push as a `host_observation`
event; a text-only one has `screenshot: false` and no image.

Most other tools return text only. `map_overview` returns a colour-coded map image.

## Keeping the context small

- **Screenshots stay until compaction.** Removing an old image would change the
  conversation from that point on, so everything after it would miss the provider's
  prompt cache: when only the two newest were kept, each new screenshot cost 20–47k
  uncached tokens (GLM 5.3 Flash, 2026-10-11). Images count toward the context budget
  (see Compaction), which bounds them. Only past 16 unpinned images, a safety limit for
  providers' per-request image limits, are the oldest replaced in one batch by a short
  placeholder (down to the newest 4): one cache miss instead of one per new image. Full
  images stay on disk.
- **Every request repeats the previous one.** Between compactions nothing earlier in
  the conversation changes: the system prompt and tools are fixed for the run, and new
  messages are only appended. A test (`controller.test.ts`) checks that each request
  starts with the previous one unchanged.
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
  estimate passes 65% of the budget, or earlier if that same anchored estimate, plus
  the summary request's own fixed instruction, would get too close to the limit —
  both checks read the same anchored scale, so a provider that reports low real usage
  does not compact early on a fresh byte recount of the whole conversation.
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
  the current plan, the notebook, the playbook's revision (in a learning series) and
  the handoff; the last model reply with its tool
  results; and a fresh observation. The system prompt never changed, so the rules,
  controls and objective are still there.
- **Failure.** A summary request that fails with a transient provider error (timeout,
  rate limit, overload, server error) is retried up to 5 times, as gameplay requests
  are. If it fails otherwise, is out of range, or the new conversation is still over
  65% of the budget, the run ends with an error. The previous conversation and
  checkpoint are kept.

Compaction takes real time but no game time, and never resets the budget.

## Tokens and caching

The host adds up the token usage the provider reports for every request, including
preparation and compaction. `npm run report` splits it into uncached input, cache
reads, cache writes and output, and shows the share of all input read from the cache.
Providers that do not report cache writes show 0.

Every request's cost is recorded as a `request_cost` event, and the run's total as
`cost` in `run.json`. OpenRouter is asked to report what it billed for each request,
and the host reads that from the reply's last usage chunk (`source: "billed"`), along
with which upstream provider it routed the request to (`upstream`, e.g. "DeepInfra"),
when it reports one. Other endpoints, Anthropic's and Moonshot's included, report only
token counts, so the host prices each request's tokens with the model profile's prices
(`source: "prices"`, see [model settings](harness.md#model-profiles)). A failed or
cut-off request is priced too, since its tokens count. A run cannot start on such an
endpoint until its profile has prices, so no run goes without a cost. `npm run cost`
prices earlier runs that recorded none ([Comparing runs](benchmark.md#comparing-runs)).

The post-episode [interview](benchmark.md#the-interview)'s requests repeat the run's
own conversation but are not part of any of the above: their tokens and cost live only
in `interview.json`, apart from the run's own total. `npm run report` reads them from
there into their own columns when the file is present.

OpenRouter also offers session affinity: a request carrying the same `x-session-id`
tends to be served by the upstream deployment that served the run's earlier requests,
so that deployment's own prompt cache keeps paying off. The host sends the run's id
for every OpenRouter profile — the gameplay agent and the compaction handoff,
reflection, preparation and interview requests that repeat its conversation outside
the main loop — so they all favor the same cached upstream connection. This is
separate from provider pinning (the "Providers, allow fallbacks" model setting, see
[model profiles](harness.md#model-profiles)), which restricts OpenRouter to specific
upstream providers; session affinity additionally favors the same connection among
whichever providers are allowed.

OpenRouter tries a profile's providers in their order and passes a request on to the next
when one refuses it, and each provider keeps its own prompt cache. So every request after
the first asks first for the provider that served the run's last request (the `upstream`
its cost reported), with the others behind it in the profile's order: a run that falls back
stays with the provider that answered instead of going back and forth. In a GLM 5.3 Flash
game on 2026-10-15, before this, Z.AI refused 29 of 81 requests with 429 (rate limited),
OpenRouter sent each to SiliconFlow, and the run changed provider 28 times; each change
re-read the conversation since that provider last served it, about 97,000 tokens in all,
and 93.1% of input came from the cache instead of about 95.9%. OpenRouter's generation
record for a request (`GET /api/v1/generation?id=<id>`, the id of the reply) lists each
provider it tried and the status it got.

Meta's models (model IDs starting `meta/`, such as Muse Wonder) need more: Meta keeps
the prompt cache on each of its server replicas and sends requests that share a
`prompt_cache_key` to the same replica, and without one a run's requests spread over
replicas. The host adds the run's id as the key to those requests
([`cache-key.ts`](../harness/server/cache-key.ts)); a round played on an earlier version
gets it too ([Rounds](benchmark.md#rounds)). Checked against OpenRouter on 2026-10-13:
without the key, 3 of a Muse Wonder run's first 11 requests read nothing from the cache,
and a 15-turn test conversation had 79% of its input cached; with it, every follow-up in
the same test read the cache.

Most providers cache repeated prompt prefixes on their own, which the fixed system
prompt, the pinned opening and the unchanged history are designed to benefit. Claude
models through OpenRouter (model IDs starting `anthropic/`) cache only what the
request marks, so for them the host marks four points: the system prompt, the tool
definitions, where the previous request ended (its cache entry, read back), and the
newest message (written, read by the next request). Anthropic looks for an earlier
cache entry only about 20 content blocks back from a mark, and a turn with many tool
calls has more, so the previous entry is read at a mark of its own. Before the first
reply after the guide, the end of the pinned preparation exchange takes the place of
the previous request's end.

Claude through Anthropic's own API (endpoint `https://api.anthropic.com`) caches the
same way, with the four marks spent differently: the system prompt (which covers the
tool definitions before it), the end of the pinned preparation exchange (read again
after a compaction, which keeps it), where the previous request ended, and the newest
message.
