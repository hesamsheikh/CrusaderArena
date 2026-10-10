"""Compacting a run's raw recording frames into frames.mp4, and rendering from them.

  python3 -m unittest discover -s tools/video
"""
import io
import json
from pathlib import Path
from runpy import run_path
import shutil
import tempfile
import unittest
from unittest import mock

from PIL import Image, ImageChops, ImageStat

from test_render_video import write_run, args, T0

compact = run_path(str(Path(__file__).with_name('compact-recording.py')))
video = run_path(str(Path(__file__).with_name('render-video.py')))

FFMPEG = shutil.which('ffmpeg')
FFPROBE = shutil.which('ffprobe')


def write_small_recording(directory, count=24, size=(160, 90)):
    """A run folder holding only its own tiny synthetic recording (frames.jsonl order 1..count)."""
    folder = directory / 'recording'
    (folder / 'frames').mkdir(parents=True)
    rows = []
    for i in range(1, count + 1):
        buffer = io.BytesIO()
        Image.new('RGB', size, (i * 7 % 255, 90, 60)).save(buffer, format='JPEG')
        name = f'{i:06d}.jpg'
        (folder / 'frames' / name).write_bytes(buffer.getvalue())
        rows.append({'i': i, 'file': name, 'at': T0 + i * 100, 't': T0 + i * 100 - 10,
                     'w': size[0], 'h': size[1], 'sw': 1920, 'sh': 1080, 'stats': {'gameTime': i}})
    (folder / 'frames.jsonl').write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
    return rows


@unittest.skipUnless(FFMPEG and FFPROBE, 'needs ffmpeg and ffprobe')
class CompactRecordingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_compacts_frames_into_a_verified_video(self):
        rows = write_small_recording(self.dir)
        result = compact['compact_run'](self.dir, FFMPEG, FFPROBE, quiet=True)
        self.assertIsInstance(result, dict)
        self.assertEqual(result['frames'], len(rows))
        self.assertEqual((result['width'], result['height']), (160, 90))
        folder = self.dir / 'recording'
        self.assertFalse((folder / 'frames').exists())
        self.assertTrue((folder / 'frames.mp4').is_file())
        # What was done is recorded, and frames.jsonl/inputs.jsonl (the video's own index) survive.
        self.assertEqual(json.loads((folder / 'frames-video.json').read_text()), result)
        self.assertEqual(len(video['read_jsonl'](folder / 'frames.jsonl')), len(rows))

    def test_verification_failure_keeps_the_jpegs_and_removes_the_partial(self):
        write_small_recording(self.dir)
        folder = self.dir / 'recording'
        with mock.patch.dict(compact['compact_run'].__globals__, {'probe_video': lambda *a, **k: (999, 1, 1)}):
            result = compact['compact_run'](self.dir, FFMPEG, FFPROBE, quiet=True)
        self.assertIsInstance(result, str)
        self.assertIn('verification failed', result)
        self.assertTrue((folder / 'frames').is_dir())
        self.assertEqual(len(list((folder / 'frames').glob('*.jpg'))), 24)
        self.assertFalse((folder / 'frames.mp4').exists())
        self.assertFalse((folder / 'frames.partial.mp4').exists())

    def test_already_compacted_and_unrecorded_runs_are_skipped(self):
        write_small_recording(self.dir)
        compact['compact_run'](self.dir, FFMPEG, FFPROBE, quiet=True)
        self.assertEqual(compact['compact_run'](self.dir, FFMPEG, FFPROBE, quiet=True), 'already compacted')
        empty = self.dir.parent / f'{self.dir.name}-no-recording'
        empty.mkdir()
        try:
            self.assertEqual(compact['compact_run'](empty, FFMPEG, FFPROBE, quiet=True), 'no recording')
        finally:
            shutil.rmtree(empty)

    def test_all_mode_skips_runs_without_frames_or_already_compacted(self):
        runs_root = self.dir / 'harness/runtime/runs'
        a, b, c = runs_root / 'a', runs_root / 'b', runs_root / 'c'
        for run_dir in (a, b, c):
            run_dir.mkdir(parents=True)
        write_small_recording(a)
        write_small_recording(b)
        compact['compact_run'](b, FFMPEG, FFPROBE, quiet=True)  # already compacted before --all runs
        # c has no recording/ at all
        targets = compact['runs_under'](self.dir)
        self.assertEqual(sorted(t.name for t in targets), ['a', 'b', 'c'])
        results = {t.name: compact['compact_run'](t, FFMPEG, FFPROBE, quiet=True) for t in targets}
        self.assertIsInstance(results['a'], dict)
        self.assertEqual(results['b'], 'already compacted')
        self.assertEqual(results['c'], 'no recording')

    def test_render_from_compacted_video_matches_the_jpeg_render(self):
        write_run(self.dir)
        frames, inputs = video['load_recording'](self.dir)
        run_jpeg = video['Run'](self.dir, video['load_events'](self.dir), frames, inputs)
        renderer_jpeg = video['Renderer'](run_jpeg, args())
        clips = video['build_timeline'](run_jpeg, args())
        samples = [(i, 0.3) for i, c in enumerate(clips) if c.kind == 'play']
        crop = lambda im: im.crop((0, 0, video['GAME_W'], video['GAME_H']))
        before = [crop(renderer_jpeg.frame(clips[i], local)[1]()) for i, local in samples]

        result = compact['compact_run'](self.dir, FFMPEG, FFPROBE, quiet=True)
        self.assertIsInstance(result, dict)
        self.assertFalse((self.dir / 'recording' / 'frames').exists())

        frames2, inputs2 = video['load_recording'](self.dir)
        run_video = video['Run'](self.dir, video['load_events'](self.dir), frames2, inputs2)
        renderer_video = video['Renderer'](run_video, args())
        clips2 = video['build_timeline'](run_video, args())
        try:
            for (i, local), image_before in zip(samples, before):
                image_after = crop(renderer_video.frame(clips2[i], local)[1]())
                diff = ImageChops.difference(image_before, image_after)
                # Only an extra JPEG -> H.264 (CRF 18) round trip separates the two renders.
                self.assertLess(max(ImageStat.Stat(diff).mean), 6)
        finally:
            for frame in frames2:
                if frame.video:
                    frame.video[0].close()


if __name__ == '__main__':
    unittest.main()
