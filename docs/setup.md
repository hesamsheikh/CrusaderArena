# Setup

[← Documentation](README.md)

Crusader Arena has been built and tested on one setup: a Mac as the host and an
Ubuntu laptop running the game. Other setups may work but are untested.

## What you need

- **The game.** Your own Steam copy of Stronghold Crusader: Definitive Edition (Steam
  app `3024040`). The reader was mapped against one game build (Steam build
  24816905): it checks four game files against fingerprints in
  `src/windows/probe.cpp` and refuses anything else. After a game update it stops
  working until it is re-verified.
- **A game machine** with Steam and Proton. Tested: Ubuntu 26.04 with GNOME on
  Wayland (the game runs under Xwayland), Proton Experimental, Steam from the Snap
  and from the regular package. The window bridge needs X11 access to the game window,
  so other desktops and native-Wayland setups need their own bridge.
- **A host machine** with Node.js 22.12 or newer (tested with 24.4.1), Python 3 and
  OpenSSH. Tested on macOS. Run videos also need Pillow and ffmpeg with libx264.
  Generating the guide images needs macOS.
- **SSH key login** from the host to the game machine.
- **A model API key**: Moonshot, OpenRouter or another OpenAI-compatible provider
  whose model accepts images and tool calls.
- **A 16:9 game window.** Menu positions were measured at 1920 × 1080; tools that
  click menus refuse other aspect ratios.

## 1. Prepare the game machine

Put a copy of this repository on the game machine. Any path works; this guide uses
`~/codebox/CrusaderBench`.

```bash
cd ~/codebox/CrusaderBench
bash tools/ubuntu/setup-dev.sh --install
```

This installs the compilers (including the MinGW cross-compiler for the Windows
reader), CMake and Python with `apt` (asks for `sudo`), runs the native tests and
builds the reader and its test programs. Later builds can drop `--install`. It does
not touch Steam, the game or its Proton prefix.

```bash
sudo apt install python3-pil xterm
bash tools/ubuntu/setup-control.sh
```

This creates `.venv-control` with a pinned Python X11 binding for the window bridge.
`xterm` is for the control monitor.

In Steam, start the game once through Proton and set a 16:9 window, ideally
1920 × 1080.

**Check the reader.** Start the game, load a single-player map, then run:

```bash
python3 tools/ubuntu/run-proton.py probe            # finds the game and checks the build fingerprints
python3 tools/ubuntu/run-proton.py watch --samples 5  # five readings as JSON lines
```

See [The reader](reader.md) for what the readings contain.

## 2. Prepare the host

```bash
npm ci --ignore-scripts
cp .env.example .env
```

Fill in `.env`:

| Variable | Example | Meaning |
| --- | --- | --- |
| `GAME_SSH_HOST` | `player@192.168.1.20` | SSH login for the game machine |
| `GAME_REMOTE_ROOT` | `/home/player/codebox/CrusaderBench` | The repository's absolute path on the game machine |
| `MOONSHOT_API_KEY` | | Key for the default Kimi K3 profile (optional if you add profiles in the dashboard) |
| `MOONSHOT_MODEL`, `MOONSHOT_BASE_URL` | `kimi-k3`, `https://api.moonshot.ai/v1` | Override the default profile's model and endpoint |
| `OPENROUTER_API_KEY` | | Key for profiles set to read it |
| `GAME_READER_INTERVAL_MS` | `100` | Reader sampling interval, 50 to 5000 |
| `PORT` | `4317` | Dashboard port |

The harness uses SSH in batch mode and refuses unknown hosts, so connect once by hand
and accept the game machine's host key after checking its fingerprint:

```bash
ssh player@192.168.1.20 true
```

For run videos, install Pillow and ffmpeg on the host (on macOS:
`brew install ffmpeg` and `python3 -m pip install pillow`).

## 3. Guide images

Before timed play, the agent studies a guide to the construction menus. The button
names and roles are part of the code, so **runs work without any images**: the agent
then gets the guide as text. The image version shows what the buttons look like and
was used for all recorded runs, but it is made from game screenshots, so it is **not
included**. The files live in `.internal/ui-reference/`, which git ignores:

| File | Used for | Without it |
| --- | --- | --- |
| `construction-trays.png` | The combined image guide in the preparation message | The guide is sent as text only |
| `trays/<page>.png` | Single pages for `guide_page` | `guide_page` reports the page unavailable |
| `example-settlement.jpg` | A developed settlement shown once for scale | Skipped |

To make them, create one source image per menu page in
`.internal/ui-reference/legends/`, named after the `file` of each page in
`harness/server/visual-atlas.ts` (ten pages). Each source is 2620 × 1080: a
1920 × 1080 game screenshot with that menu page open, at the left, with red boxes
numbered in the order of that page's `labels`, at their `box` positions. The rest of
the width is ignored. Then run, on macOS:

```bash
node --import tsx tools/make-construction-trays.mjs
```

It crops the menu tray (the bottom 230 pixels from x 795 to 1575) from each source
into `trays/`, and lays out all ten crops with their labels in
`construction-trays.png`.

## 4. First run

1. Start the game on the game machine and load a single-player map.
2. On the host, from a terminal: `npm run dev`, then open http://127.0.0.1:4317.
3. Click **Connect game**. The live view, stats and `MEMORY GUARD ON` should appear,
   and the control monitor opens on the game machine.
4. Add or test a model under **Home → Configure**, then start a run. See
   [The harness](harness.md).

For unattended benchmark episodes, see [The benchmark](benchmark.md#running-episodes).

## Known issues

- **Start the host from a terminal on macOS.** Started inside another app, it can be
  denied local network access and fail with "No route to host".
- **NVIDIA graphics on hybrid laptops.** On the test laptop (Intel and NVIDIA RTX 2060
  graphics, NVIDIA driver 610.57.04, GNOME Wayland), the game often stalled on its
  loading screen when it ran on the NVIDIA GPU, with both OpenGL and Vulkan. Running
  it on the Intel GPU with Vulkan worked. The test used Mesa's
  [device selection variables](https://docs.mesa3d.org/envvars.html#vulkan-mesa-device-select-layer-environment-variables)
  (`MESA_VK_DEVICE_SELECT=<vendor>:<device>` and
  `MESA_VK_DEVICE_SELECT_FORCE_DEFAULT_DEVICE=1`) with that laptop's Intel IDs.
- **Memory growth during long pauses.** The game can start leaking memory at about
  400 MiB per minute while paused, with or without the reader loaded. The dashboard
  always runs the memory guard. For manual sessions, run
  `python3 tools/ubuntu/monitor-memory.py --terminate-on-limit` yourself, and close the
  game rather than leaving it paused.
- **Restarting the reader.** If a reader call is interrupted, restart the game before
  trying again; the reader leaves a marker and refuses to reattach to that game
  process.
