"""The background render queue: render, then compact, one run at a time.

  python3 -m unittest discover -s tools/video
"""
import fcntl
import json
from pathlib import Path
from runpy import run_path
import tempfile
import unittest
from unittest import mock

queue = run_path(str(Path(__file__).with_name('render-queue.py')))


class RenderQueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.run_dir = self.root / 'runs' / 'run-1'
        self.run_dir.mkdir(parents=True)
        self.lock = self.root / 'render.lock'
        self.lines = []

    def tearDown(self):
        self.tmp.cleanup()

    def process(self, step):
        return queue['process'](self.run_dir, self.lines.append, step=step, lock_path=self.lock)

    def test_renders_then_compacts_holding_the_lock_and_clears_pending(self):
        steps = []

        def step(script, run_dir):
            steps.append(script)
            self.assertTrue((run_dir / 'render.pending').exists(), 'pending while it works')
            # Another render on this machine has to wait: the lock is held.
            with open(self.lock, 'a') as other:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if script == 'render-video.py':
                return {'output': f'{run_dir}/video.mp4', 'seconds': 1406.4, 'turns': 71, 'frames': 12401}, ''
            return {'run-1': {'source_bytes': 5_075_000_000, 'video_bytes': 506_000_000}}, ''

        summary = self.process(step)
        self.assertEqual(steps, ['render-video.py', 'compact-recording.py'])
        self.assertEqual(self.lines, [f'Video saved: {self.run_dir}/video.mp4 (23:26).',
                                      'Recording compacted: 5075 MB -> 506 MB.'])
        self.assertEqual(summary['compaction'], {'source_bytes': 5_075_000_000, 'video_bytes': 506_000_000})
        self.assertFalse((self.run_dir / 'render.pending').exists())

    def test_a_failed_render_skips_compaction_and_still_clears_pending(self):
        steps = []

        def step(script, run_dir):
            steps.append(script)
            return None, 'Nothing to render: the recording holds no footage.'

        summary = self.process(step)
        self.assertEqual(steps, ['render-video.py'])
        self.assertEqual(self.lines, ['Video render failed: Nothing to render: the recording holds no footage.'])
        self.assertIsNone(summary['video'])
        self.assertFalse((self.run_dir / 'render.pending').exists())

    def test_a_skipped_or_failed_compaction_is_reported(self):
        def skipped(script, run_dir):
            return ({'output': 'v.mp4', 'seconds': 59.0}, '') if script == 'render-video.py' else ({'run-1': 'already compacted'}, '')

        self.process(skipped)
        self.assertEqual(self.lines[-1], 'Recording not compacted: already compacted.')

        def failed(script, run_dir):
            return ({'output': 'v.mp4', 'seconds': 59.0}, '') if script == 'render-video.py' else (None, 'ffmpeg failed.')

        self.process(failed)
        self.assertEqual(self.lines[-1], 'Recording compaction failed: ffmpeg failed.')

    def test_main_appends_prefixed_lines_to_the_log_and_ends_with_a_summary(self):
        log = self.root / 'runner.log'
        printed = []

        def step(script, run_dir):
            return ({'output': 'v.mp4', 'seconds': 61.0}, '') if script == 'render-video.py' else ({'run-1': {'source_bytes': 2e6, 'video_bytes': 1e6}}, '')

        with mock.patch.dict(queue['process'].__globals__, {'run_step': step, 'LOCK': self.lock}), \
                mock.patch('builtins.print', side_effect=lambda *a, **k: printed.append(a[0])):
            code = queue['main']([str(self.run_dir), '--log', str(log), '--prefix', 'Episode 2: '])
        self.assertEqual(code, 0)
        lines = log.read_text().splitlines()
        self.assertRegex(lines[0], r'^\[\d\d:\d\d:\d\d\] Episode 2: Video saved: v\.mp4 \(1:01\)\.$')
        self.assertRegex(lines[1], r'Episode 2: Recording compacted: 2 MB -> 1 MB\.$')
        self.assertEqual(json.loads(printed[-1])['video']['output'], 'v.mp4')


if __name__ == '__main__':
    unittest.main()
