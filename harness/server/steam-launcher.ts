/**
 * Steam's launcher service for the reader, for versions made before run-proton.py found it itself.
 *
 * tools/ubuntu/run-proton.py runs the reader inside the game's Proton prefix through Steam's
 * launcher service (steam-runtime-launch-client --alongside-steam). Older Steam clients registered
 * that service under one fixed bus name. Newer ones, which run in their own container, register it
 * per instance and tell the processes they launch its name in SRT_LAUNCHER_SERVICE_ALONGSIDE_STEAM;
 * the launch client finds the service only through that variable. run-proton.py now copies it from
 * the game's environment. An earlier round's run-proton.py does not, so round-preload.ts gives its
 * host's SSH calls to the script a shell prefix that exports the variable from the running game's
 * environment first. Nothing else changes: with an older Steam client the game has no such
 * variable and the prefix exports nothing.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";

export const LAUNCHER_SERVICE_VARIABLE = "SRT_LAUNCHER_SERVICE_ALONGSIDE_STEAM";

/**
 * Exports the variable from the game's environment when the game has it. The pattern's escaped
 * dot keeps pgrep from matching this shell's own command line.
 */
export const LAUNCHER_SERVICE_PREFIX =
  `s=$(for p in $(pgrep -u "$(id -u)" -f 'Stronghold Crusader Definitive Edition\\.exe'); do ` +
  `tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null; done | sed -n 's/^${LAUNCHER_SERVICE_VARIABLE}=//p' | head -n 1); ` +
  `if [ -n "$s" ]; then export ${LAUNCHER_SERVICE_VARIABLE}="$s"; fi; `;

/** SSH arguments whose remote command runs run-proton.py, with the prefix before that command. */
export function withLauncherService(args: readonly string[]) {
  const command = args.at(-1);
  if (typeof command !== "string" || !command.includes("/tools/ubuntu/run-proton.py") || command.startsWith(LAUNCHER_SERVICE_PREFIX))
    return [...args];
  return [...args.slice(0, -1), LAUNCHER_SERVICE_PREFIX + command];
}

/** Makes child_process.spawn add the prefix to every ssh call that runs run-proton.py. */
export function launchReaderThroughSteamService() {
  const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  const spawn = childProcess.spawn;
  childProcess.spawn = function (this: unknown, command: string, args?: unknown, ...rest: unknown[]) {
    const changed = command === "ssh" && Array.isArray(args) ? withLauncherService(args) : args;
    return (spawn as (...a: unknown[]) => ReturnType<typeof spawn>).call(this, command, changed, ...rest);
  } as typeof spawn;
  syncBuiltinESMExports();
}
