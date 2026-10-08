#!/usr/bin/env bash
# Run on Ubuntu. Installs compiler tools only when --install is explicit.
set -euo pipefail
if [[ $(uname -s) != Linux || ! -r /etc/os-release ]]; then
  echo 'Run this script on the Ubuntu development machine.' >&2
  exit 1
fi
. /etc/os-release
if [[ ${ID:-} != ubuntu ]]; then
  echo 'This setup currently supports Ubuntu only.' >&2
  exit 1
fi
case ${1:-} in
  --install)
    sudo apt-get update
    sudo apt-get install -y build-essential cmake ninja-build git python3 python3-venv g++-mingw-w64-x86-64
    ;;
  '') ;;
  *) echo 'Usage: bash tools/ubuntu/setup-dev.sh [--install]' >&2; exit 2 ;;
esac
for tool in cmake ninja c++ python3 x86_64-w64-mingw32-g++ x86_64-w64-mingw32-windres; do
  command -v "$tool" >/dev/null || { echo "Missing $tool; rerun with --install." >&2; exit 1; }
done
project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cmake -S "$project_root" -B "$project_root/build/ubuntu-native" -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=ON
cmake --build "$project_root/build/ubuntu-native" --parallel 2
ctest --test-dir "$project_root/build/ubuntu-native" --output-on-failure
python3 -m unittest discover -s "$project_root/tests" -p 'test_*.py'
cmake -S "$project_root" -B "$project_root/build/ubuntu-windows" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$project_root/cmake/windows-mingw.cmake" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build "$project_root/build/ubuntu-windows" --parallel 2
echo 'Native tests and Windows cross-build completed. Proton runtime tests are separate and still required.'
