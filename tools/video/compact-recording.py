#!/usr/bin/env python3
"""Compact a recorded run's raw JPEG frames into one small H.264 video.

  python3 tools/video/compact-recording.py harness/runtime/runs/<run folder> [<run folder> ...]
  python3 tools/video/compact-recording.py --all   # every run under harness/runtime/runs

Encodes recording/frames/*.jpg, in recording/frames.jsonl order, into recording/frames.mp4
(one video frame per recorded frame, constant rate; libx264, CRF 18, yuv420p). ffprobe then
checks the result holds exactly as many frames, at the same size, as frames.jsonl recorded;
only once that holds does it write recording/frames-video.json (what was encoded) and delete
the JPEGs. A run with no recording, or already compacted (no frames/ left), is skipped; a run
whose verification fails keeps its JPEGs and the partial file is removed — nothing is ever
deleted on a failure. tools/video/render-video.py reads frames.mp4 once the JPEGs are gone.

Needs Pillow and ffmpeg with libx264, plus ffprobe (both come with an ffmpeg install).
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ENCODE_FPS = 10  # nominal only: render-video.py times playback from frames.jsonl, not this rate
CRF = 18
PRESET = "medium"


def read_jsonl(path):
    rows = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except (TypeError, ValueError):
                continue
            if isinstance(row, dict):
                rows.append(row)
    return rows


def recorded_frame_rows(frames_jsonl):
    """Rows render-video.py's load_recording() would use, in the order it assigns video indices."""
    return [r for r in read_jsonl(frames_jsonl)
            if isinstance(r.get("t"), (int, float)) and isinstance(r.get("at"), (int, float)) and r.get("file")]


def frame_size(rows):
    """The run's recorded frame size: the most common (w, h) in frames.jsonl."""
    sizes = [(r["w"], r["h"]) for r in rows if isinstance(r.get("w"), int) and isinstance(r.get("h"), int)]
    return max(set(sizes), key=sizes.count) if sizes else None


def frame_bytes(path, size):
    """Raw RGB24 bytes for one frame, resized to `size` on the rare mismatch (a resized window)."""
    with Image.open(path) as im:
        im = im.convert("RGB")
        if im.size != size:
            im = im.resize(size, Image.BILINEAR)
        return im.tobytes()


def encode(ffmpeg, rows, frames_dir, size, output):
    """Pipe every frame's RGB bytes into ffmpeg, in frames.jsonl order; True if it exits clean."""
    w, h = size
    command = [ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
               "-r", str(ENCODE_FPS), "-i", "-", "-c:v", "libx264", "-preset", PRESET, "-crf", str(CRF),
               "-pix_fmt", "yuv420p", str(output)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        for row in rows:
            process.stdin.write(frame_bytes(frames_dir / row["file"], size))
        process.stdin.close()
    except BrokenPipeError:
        pass
    return process.wait() == 0


def probe_video(ffprobe, path):
    """(frame count, width, height) ffprobe decodes from `path`, or None if it cannot read it."""
    result = subprocess.run([ffprobe, "-v", "error", "-count_frames", "-select_streams", "v:0",
                             "-show_entries", "stream=nb_read_frames,width,height", "-of", "json", str(path)],
                            capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        s = json.loads(result.stdout)["streams"][0]
        return int(s["nb_read_frames"]), int(s["width"]), int(s["height"])
    except (KeyError, IndexError, ValueError, TypeError):
        return None


def compact_run(run_dir, ffmpeg, ffprobe, quiet=False):
    """Compact one run's recording. Returns the frames-video.json dict on success, or a skip/failure reason."""
    folder = run_dir / "recording"
    frames_dir = folder / "frames"
    video_path = folder / "frames.mp4"
    if not folder.is_dir():
        return "no recording"
    if not frames_dir.is_dir():
        return "already compacted" if video_path.is_file() else "no frames to compact"
    rows = recorded_frame_rows(folder / "frames.jsonl")
    if not rows:
        return "frames.jsonl has no frames"
    missing = [r["file"] for r in rows if not (frames_dir / r["file"]).is_file()]
    if missing:
        return f"{len(missing)} frame(s) listed in frames.jsonl are missing on disk"
    size = frame_size(rows)
    if size is None:
        return "frames.jsonl has no frame dimensions"
    source_bytes = sum((frames_dir / r["file"]).stat().st_size for r in rows)
    partial = video_path.with_name("frames.partial.mp4")
    partial.unlink(missing_ok=True)
    if not quiet:
        print(f"{run_dir.name}: encoding {len(rows)} frames at {size[0]}x{size[1]}", file=sys.stderr)
    if not encode(ffmpeg, rows, frames_dir, size, partial):
        partial.unlink(missing_ok=True)
        return "ffmpeg failed"
    probe = probe_video(ffprobe, partial)
    expected = (len(rows), *size)
    if probe != expected:
        partial.unlink(missing_ok=True)
        return f"verification failed (ffprobe read {probe}, expected {expected})"
    video_bytes = partial.stat().st_size
    info = {"codec": "libx264", "preset": PRESET, "crf": CRF, "pix_fmt": "yuv420p", "width": size[0], "height": size[1],
            "frames": len(rows), "source_bytes": source_bytes, "video_bytes": video_bytes,
            "compacted_at": int(time.time() * 1000)}
    # Only now, with the video verified, publish it, record what was done, and drop the JPEGs.
    os.replace(partial, video_path)
    (folder / "frames-video.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    shutil.rmtree(frames_dir)
    return info


def runs_under(root):
    base = root / "harness/runtime/runs"
    return sorted(p for p in base.iterdir() if p.is_dir()) if base.is_dir() else []


def resolve(name):
    run_dir = Path(name)
    if not (run_dir / "run.json").is_file() and not (run_dir / "recording").is_dir():
        candidate = ROOT / "harness/runtime/runs" / name
        if candidate.is_dir():
            run_dir = candidate
    return run_dir


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("runs", nargs="*", help="run folder(s) (harness/runtime/runs/<folder>, or a path)")
    parser.add_argument("--all", action="store_true", help="every run under harness/runtime/runs")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    if args.all and args.runs:
        parser.error("give run folders or --all, not both")
    if not args.all and not args.runs:
        parser.error("give one or more run folders, or --all")
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        sys.exit("ffmpeg and ffprobe both needed on PATH (macOS: brew install ffmpeg).")
    targets = runs_under(ROOT) if args.all else [resolve(name) for name in args.runs]
    results = {}
    for run_dir in targets:
        outcome = compact_run(run_dir, ffmpeg, ffprobe, quiet=args.quiet)
        results[run_dir.name] = outcome
        if not args.quiet:
            if isinstance(outcome, dict):
                mb = lambda k: outcome[k] / 1e6
                print(f"{run_dir.name}: compacted ({mb('source_bytes'):.0f} MB -> {mb('video_bytes'):.0f} MB)", file=sys.stderr)
            else:
                print(f"{run_dir.name}: skipped ({outcome})", file=sys.stderr)
    print(json.dumps(results))


if __name__ == "__main__":
    main()
