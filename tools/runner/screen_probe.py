#!/usr/bin/env python3
"""Mean colour around given points of a game screenshot, for the episode runner's menu checks.

Reads a JPEG on stdin; argv[1] is a JSON list of [x, y] points in the 1920 x 1080 menu layout,
scaled to the image's own size. Prints a JSON list of [r, g, b], one per point, each the mean of
a 7 x 7 box. harness/server/menu-screen.ts decides from these which screen is showing.
"""
import io
import json
import sys

from PIL import Image

BOX = 3


def probe(image, points):
    image = image.convert("RGB")
    width, height = image.size
    colours = []
    for x, y in points:
        cx, cy = round(x * width / 1920), round(y * height / 1080)
        box = image.crop((max(0, cx - BOX), max(0, cy - BOX), min(width, cx + BOX + 1), min(height, cy + BOX + 1)))
        pixels = list(box.getdata())
        colours.append([sum(p[i] for p in pixels) // len(pixels) for i in range(3)])
    return colours


def main():
    points = json.loads(sys.argv[1])
    image = Image.open(io.BytesIO(sys.stdin.buffer.read()))
    print(json.dumps(probe(image, points)))


if __name__ == "__main__":
    main()
