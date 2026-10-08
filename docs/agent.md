# The agent

[← Documentation](README.md)

The agent is a language model with image input and tool calling, plus the system
prompt and the 27 tools the harness gives it. It runs on the
[Pi](https://github.com/earendil-works/pi) agent runtime inside the host server
(`harness/server/model.ts`). This page explains how it plays. [Context](context.md)
covers exactly what it is sent, and the [tool reference](tools.md) lists every tool.

## A turn

A turn is one model reply plus the tool calls in it.

1. **The game is paused while the model thinks.** Before every model request the host
   pauses the game and waits for the reader to confirm the pause. Thinking costs no
   play time.
2. **The model replies** with text and tool calls.
3. **Tools run one at a time, in order.** Reading tools (`status`, `get_inventory`,
   `find_sites`, `map_overview`, `flat_view`, the lookup tools and the memory tools)
   run with the game still paused. At the first tool that acts, waits or takes a
   screenshot, the host unpauses the game and waits for the reader to confirm it; the
   game then keeps running for the rest of the reply. So a reply should read first and
   act after.
4. **The host makes sure the model sees the result.** If the turn acted without
   observing afterwards, or called no tools at all, the host lets the default wait
   pass (5 game seconds) and sends a fresh screenshot. A turn that ends with a fresh
   observation, or only read, goes straight to the next request.
5. **A turn that runs the game lasts a minimum time.** If the game ran for less than
   the minimum turn length (8 game seconds by default) between the start of the
   request and the end of the turn's tools, the host lets the rest pass and sends a
   fresh screenshot; a turn that acted without looking waits for the longer of the two.
   This caps the number of model requests per game minute, and so the cost of a run:
   at 8 seconds, a 20-game-minute run has at most 150 turns that run the game. Turns
   that only read stay free and are limited separately (see [Stuck loops](#when-things-go-wrong)).

Each reply can take **at most 8 actions**. An action is anything that sends input to
the game: a click or key (`game_action`), each building placed by `build_structure`,
or a camera, panel, tax or trade tool. Looking, waiting, reading stats, looking things
up and taking notes are free. The [tool reference](tools.md) marks which tools count.

## What the model sees

- **Screenshots** of the game window only, as JPEG at the window's own size (tested at
  1920 × 1080).
- **A JSON summary** with each screenshot: the game clock and budget, the date, gold,
  population and housing, popularity in the game's own points, tax level, food,
  stored goods, placement mode, camera position, any open building panel, troops (in
  military benchmarks only), and game messages since the previous screenshot.
- **Tool results**, mostly text. Placement tools report what happened to each building
  instead of returning a screenshot.

See [Context](context.md) for the full layout and how old images are dropped.

## What the model can do

| Group | Tools | For |
| --- | --- | --- |
| Look | `observe`, `wait_and_observe`, `flat_view` | Fresh screenshot now, after letting time pass, or with buildings flattened |
| Build | `build_structure`, `place_near`, `expand_storage`, `find_sites` | Placing buildings and finding space for them |
| Move the camera | `center_on`, `map_overview`, `go_to_tile`, `save_view`, `go_to_view`, `navigate_minimap` | Finding places on the map |
| Run the economy | `status`, `get_inventory`, `inspect_building`, `set_tax`, `market_trade` | Reading the settlement, taxes and trade |
| Look things up | `building_info`, `list_buildings`, `guide_page` | Building costs, roles and menu positions from the game reference |
| Raw input | `game_action` | Any single click, drag, scroll or key |
| Memory | `update_plan`, `notebook_read`, `notebook_write`, `notebook_edit`, `notification_history`; in a learning series also `playbook_read`, `playbook_write`, `playbook_edit` | Plans, notes, past game messages and lessons for later episodes |

The higher-level tools exist because raw clicking is slow and error-prone for a model.
For example, `build_structure` opens the right menu, selects the building, clicks the
target, checks with the reader whether the building was actually placed, and tries
nearby spots if it was silently blocked.

## Rules the harness enforces

- **No pausing or game menu.** `P` and `Escape` are refused. `Space` (flatten the
  landscape) is not offered; `flat_view` uses it and restores the view.
- **Game window only.** Every input goes to the game window, at pixel coordinates in
  the latest screenshot. The bridge checks the game is the active window and has not
  changed size.
- **Fresh images only.** Input based on a screenshot more than 30 seconds old is
  refused. Time the game spent paused by the host does not count, so slow thinking
  does not expire a screenshot.
- **Camera guards.** Placement and inspection tools stop if the camera moved since the
  screenshot they target.
- **Single-player only.** See [the harness](harness.md#safety-boundaries).

Benchmark rules such as "no soldiers or defences" are instructions in the prompt, not
blocked in code. `build_structure` only offers economic buildings, but `game_action`
can click anything a player could.

## Memory

The model's conversation is trimmed as it grows (see [Context](context.md)), so the
agent has memory it controls:

- **Plan** (`update_plan`): a checklist of up to 20 steps, each pending, in progress
  or completed. Each call replaces the whole plan.
- **Notebook** (`notebook_read`, `notebook_write`, `notebook_edit`): free text up to
  8 KB. Writes must quote the current revision number, so the agent cannot overwrite
  notes it has not read.
- **Notification history** (`notification_history`): every message the reader saw on
  screen during the run, up to 50 per call.
- **Playbook** (`playbook_read`, `playbook_write`, `playbook_edit`), in the episodes of
  a learning series only: notes up to 8 KB that, unlike everything else, carry over to
  the next episode. After each episode the host shows the agent its final result and
  asks for the playbook's next version (see
  [Benchmark](benchmark.md#learning-series)).

The plan and notebook survive context compaction. The model sees them when it reads
or changes them and in the summary after a compaction; they are not repeated every
turn. The dashboard shows both to the operator live.

## When things go wrong

- **Provider errors.** Timeouts, rate limits, overloads, server errors and empty
  replies are retried up to 5 times, waiting 2, 4, 8, 16 and 30 seconds. Other errors
  end the run.
- **Cut-off replies.** A reply that hits the profile's output limit (8,192 tokens by
  default) is discarded and retried up to twice per turn with a reminder to think
  briefly.
- **No `BEGIN`.** A preparation reply without `BEGIN`, or cut off at the output limit,
  is retried; after three replies the run fails with the game still paused.
- **Failed tool calls** are not retried by the host. The model gets the error and
  decides what to do.
- **Stuck loops.** Four replies in a row with no tool calls, or twelve in a row that
  only read (no action, wait or screenshot), end the run with an error. Reading costs
  no play time, so without this a model could stall the budget forever.
- **Host shutdown.** Stopping the host (Ctrl-C or a terminate signal) ends a run as
  `stopped` but, unlike the dashboard's Stop, still pauses the game and takes the final
  reading, waiting up to 10 seconds; a second Ctrl-C exits at once. An unexpected host
  error ends the run the same way. A failed background task is only logged.
- **Run setup.** If a run cannot be set up, it is recorded as `error` and the host
  stays ready for the next one.

## Models

The model must accept images and tool calls through an OpenAI-compatible chat
completions endpoint. The default profile is Moonshot's Kimi K3. Moonshot and
OpenRouter endpoints are tested; other endpoints are handled like Moonshot's and are
untested. Each profile sets its reasoning level, its output limit per reply (8,192
tokens by default) and, on OpenRouter, which upstream providers may serve it; every
run records these. Requests time out after 90 seconds. See
[the harness](harness.md#model-profiles) for adding and configuring models.
