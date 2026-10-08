#!/usr/bin/env bash
# Install only project-scoped control bindings. Does not launch or change the game.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -c 'from PIL import Image' || { echo 'Install python3-pil and python3-venv using your Ubuntu package manager.' >&2; exit 1; }
python3 -m venv "$project_root/.venv-control" --system-site-packages
"$project_root/.venv-control/bin/pip" install python-xlib==0.33 six==1.17.0

command -v xterm >/dev/null || { echo "Install xterm for the visible monitor: sudo apt install xterm" >&2; exit 1; }
