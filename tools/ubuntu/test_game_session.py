import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('game_session', Path(__file__).with_name('game-session.py'))
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)

STEAM = '/home/u/.local/share/Steam'
# The launch left behind on 2026-10-15, as ps showed it (pid: parent, seconds running, command).
LEFT = {
    100: (1, 200000.0, f'{STEAM}/ubuntu12_32/steam -srt-logger-opened -silent'),
    300: (100, 1050.0, f'/bin/sh -c {STEAM}/ubuntu12_32/steam-launch-wrapper -- {STEAM}/ubuntu12_32/reaper SteamLaunch AppId=3024040 -- ...'),
    301: (300, 1050.0, f'{STEAM}/ubuntu12_32/reaper SteamLaunch AppId=3024040 -- {STEAM}/steamapps/common/SteamLinuxRuntime_4/_v2-entry-point'),
    302: (301, 1050.0, f'{STEAM}/steamapps/common/SteamLinuxRuntime_4/pressure-vessel/libexec/steam-runtime-tools-0/srt-bwrap --args 26'),
    303: (302, 1049.0, f'python3 {STEAM}/steamapps/common/Proton - Experimental/proton waitforexitandrun'),
    304: (303, 1049.0, r'c:\windows\system32\steam.exe Stronghold Crusader Definitive Edition.exe'),
    305: (301, 1049.0, f'{STEAM}/steamapps/common/Proton - Experimental/files/bin/wineserver'),
    # The reader stream, started alongside Steam, and another game's launch: neither is this one.
    400: (1, 1000.0, 'python3 /home/u/CrusaderBench/tools/ubuntu/run-proton.py watch --interval-ms 100'),
    500: (100, 30.0, f'{STEAM}/ubuntu12_32/reaper SteamLaunch AppId=1234 -- other'),
}


class LaunchTreeTests(unittest.TestCase):
    def test_finds_the_games_launch_and_everything_under_it(self):
        self.assertEqual(session.launch_tree(LEFT), [300, 301, 302, 303, 304, 305])
        self.assertEqual(session.launch_age(LEFT, session.launch_tree(LEFT)), 1050.0)

    def test_no_launch(self):
        self.assertEqual(session.launch_tree({k: v for k, v in LEFT.items() if k in (100, 400, 500)}), [])


class LaunchTests(unittest.TestCase):
    def launch(self, procs):
        with patch.object(session, 'games', return_value=[]), \
                patch.object(session, 'processes', return_value=procs), \
                patch.object(session, 'end_processes', return_value=6) as end, \
                patch.object(session.subprocess, 'run') as run, \
                patch.object(session, 'status', return_value={'running': True, 'window': True}):
            result = session.launch(5)
        return result, end, run

    def test_a_launch_left_without_the_game_is_ended_before_launching(self):
        result, end, run = self.launch(LEFT)
        end.assert_called_once_with([300, 301, 302, 303, 304, 305], 15)
        self.assertIn('steam://rungameid/3024040', run.call_args.args[0])
        self.assertEqual(result['cleared_launch'], 6)

    def test_a_launch_still_starting_is_waited_for(self):
        young = {pid: (parent, 20.0, cmd) for pid, (parent, _, cmd) in LEFT.items()}
        result, end, run = self.launch(young)
        end.assert_not_called()
        run.assert_not_called()
        self.assertNotIn('cleared_launch', result)

    def test_without_a_launch_steam_is_asked_to_start_the_game(self):
        result, end, run = self.launch({100: LEFT[100]})
        end.assert_not_called()
        self.assertIn('steam://rungameid/3024040', run.call_args.args[0])


class StatusTests(unittest.TestCase):
    def test_reports_a_launch_without_the_game(self):
        with patch.object(session, 'games', return_value=[]), patch.object(session, 'processes', return_value=LEFT):
            self.assertEqual(session.status(), {'running': False, 'processes': 0, 'window': False, 'active': False,
                                                'launch': {'processes': 6, 'seconds': 1050}})


if __name__ == '__main__':
    unittest.main()
