import io
import json
import subprocess
import sys
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from screen_probe import probe  # noqa: E402

SCRIPT = Path(__file__).resolve().parent / "screen_probe.py"


class ScreenProbeTest(unittest.TestCase):
    def test_means_scaled_from_the_1920_layout(self):
        # A 960 x 540 image: the point (100, 100) in the 1920 layout is (50, 50) here.
        image = Image.new("RGB", (960, 540), (200, 150, 100))
        ImageDraw.Draw(image).rectangle((40, 40, 60, 60), fill=(10, 20, 30))
        self.assertEqual(probe(image, [[100, 100], [1800, 1000]]), [[10, 20, 30], [200, 150, 100]])

    def test_box_at_the_edge_stays_inside_the_image(self):
        image = Image.new("RGB", (1920, 1080), (5, 6, 7))
        self.assertEqual(probe(image, [[0, 0], [1919, 1079]]), [[5, 6, 7], [5, 6, 7]])

    def test_command_line_reads_a_jpeg_on_stdin(self):
        data = io.BytesIO()
        Image.new("RGB", (1920, 1080), (0, 0, 0)).save(data, format="JPEG", quality=90)
        out = subprocess.run([sys.executable, str(SCRIPT), json.dumps([[960, 540]])], input=data.getvalue(),
                             capture_output=True, check=True)
        self.assertEqual(json.loads(out.stdout), [[0, 0, 0]])


if __name__ == "__main__":
    unittest.main()
