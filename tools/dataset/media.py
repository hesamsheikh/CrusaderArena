"""Make a staged episode smaller for the dataset. The run folder keeps the originals.

- Images leave events.jsonl. Each image the log holds as base64 (screenshots, the reference
  images of the preparation message, the final frames) is written once to
  images/<hash>.webp, WebP at quality 70 and full size, or with its original bytes when those
  are smaller; the log holds the file's path instead. A tool's screenshot is logged three times
  (the tool's result, and the start and end of the message that carries it), so one file
  serves all three.
- message_update events are dropped: the token deltas of a streaming reply, which the reply's
  message_end holds in full.
- video.mp4 is scaled to 720p. The harness renders 1080p for watching runs locally.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from scrub import BASE64_BLOB

IMAGES = 'images'
WEBP_QUALITY = 70
MIME = {'jpg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp'}
VIDEO_HEIGHT = 720
# The renderer's own settings (tools/video/render-video.py): flat panels and mostly still footage.
VIDEO_CODEC = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-tune', 'animation']


def image_type(raw: bytes) -> str | None:
    """The file extension for these bytes when they are an image, else None."""
    if raw.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'webp'
    return None


def decode(value: str) -> bytes | None:
    """The image a string holds as base64 or a data: URL; None for any other string."""
    if len(value) < 512:
        return None
    if value.startswith('data:image/'):
        head, _, value = value.partition(',')
        if ';base64' not in head:
            return None
    elif not BASE64_BLOB.fullmatch(value):
        return None
    try:
        raw = base64.b64decode(value)
    except (binascii.Error, ValueError):
        return None
    return raw if image_type(raw) else None


def compress(raw: bytes) -> tuple[bytes, str]:
    """WebP at WEBP_QUALITY and the image's own size, or the original bytes when they are smaller."""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(raw)) as im:
            alpha = 'A' in im.getbands() or 'transparency' in im.info
            buffer = io.BytesIO()
            im.convert('RGBA' if alpha else 'RGB').save(buffer, 'WEBP', quality=WEBP_QUALITY, method=6)
    except (OSError, ValueError):
        return raw, image_type(raw)
    webp = buffer.getvalue()
    return (webp, 'webp') if len(webp) < len(raw) else (raw, image_type(raw))


@dataclass
class Images:
    """The images of one episode, written once each to <folder>/images/."""
    folder: Path
    references: int = 0
    _paths: dict[str, str] = field(default_factory=dict)  # SHA-256 of the original bytes -> path

    def add(self, raw: bytes) -> str:
        self.references += 1
        key = hashlib.sha256(raw).hexdigest()
        if key not in self._paths:
            data, extension = compress(raw)
            path = f'{IMAGES}/{hashlib.sha256(data).hexdigest()[:16]}.{extension}'
            (self.folder / IMAGES).mkdir(exist_ok=True)
            (self.folder / path).write_bytes(data)
            self._paths[key] = path
        return self._paths[key]

    @property
    def files(self) -> int:
        return len(set(self._paths.values()))


def without_images(value, images: Images):
    """A parsed JSON value with every embedded image replaced by its path in images/.

    An image block {"type": "image", "data": ..., "mimeType": ...} becomes
    {"type": "image", "mimeType": <the file's type>, "path": ...}; any other string that is an
    image (the final frames' "image") becomes the path itself.
    """
    if isinstance(value, dict):
        if value.get('type') == 'image' and isinstance(value.get('data'), str):
            raw = decode(value['data'])
            if raw is not None:
                path = images.add(raw)
                kept = {k: v for k, v in value.items() if k != 'data'}
                return {**kept, 'mimeType': MIME[path.rsplit('.', 1)[1]], 'path': path}
        return {k: without_images(v, images) for k, v in value.items()}
    if isinstance(value, list):
        return [without_images(item, images) for item in value]
    if isinstance(value, str):
        raw = decode(value)
        return images.add(raw) if raw is not None else value
    return value


def slim_events(events: Path) -> dict:
    """Rewrite a staged events.jsonl in place: images out to images/ beside it, token deltas
    dropped. Lines with neither are kept byte for byte."""
    images = Images(events.parent)
    deltas = 0
    partial = events.with_name(events.name + '.partial')
    with open(events, encoding='utf-8') as source, open(partial, 'w', encoding='utf-8') as out:
        for line in source:
            try:
                record = json.loads(line)
            except ValueError:
                out.write(line)
                continue
            event = record.get('event') if isinstance(record, dict) else None
            if isinstance(event, dict) and event.get('type') == 'message_update':
                deltas += 1
                continue
            before = images.references
            slim = without_images(record, images)
            out.write(json.dumps(slim, ensure_ascii=False, separators=(',', ':')) + '\n'
                      if images.references > before else line)
    os.replace(partial, events)
    return {'image_references': images.references, 'image_files': images.files, 'deltas_dropped': deltas}


def shrink_video(video: Path, height: int = VIDEO_HEIGHT) -> str | None:
    """Scale a staged video.mp4 down to `height` lines in place, keeping its chapters; an error or None."""
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        return f'ffmpeg is not on PATH, so the video cannot be scaled to {height}p'
    partial = video.with_name(video.stem + '.partial.mp4')
    result = subprocess.run(
        [ffmpeg, '-y', '-loglevel', 'error', '-i', str(video), '-map', '0:v', '-map_metadata', '0',
         '-map_chapters', '0', '-vf', f"scale=-2:'min({height},ih)':flags=lanczos", *VIDEO_CODEC,
         '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(partial)],
        capture_output=True, text=True)
    if result.returncode or not partial.is_file():
        partial.unlink(missing_ok=True)
        return f'scaling the video to {height}p failed: ' + ((result.stderr.strip().splitlines() or ['no video written'])[-1])
    os.replace(partial, video)
    return None
