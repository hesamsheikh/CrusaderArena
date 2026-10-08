"""Remove secrets and machine-specific details from run files before they are published.

Three steps, applied to every text file a bundle publishes:

1. Known machine values are replaced with placeholders: the game machine's SSH target and
   source path from .env (<game-host>, <game-root>), and this machine's home directory and
   host name (<home>, <hostname>).
2. Fields that only describe the machine are dropped: the process and window IDs on captured
   frames, the system and graphics details in memory samples, and absolute paths in
   "directory" fields (the recorder logs where it kept its frames).
3. Anything else that looks private is reported as a finding and blocks the upload: saved API
   keys and other key-shaped strings, the local or game-machine user name, home paths, user
   runtime paths, IP addresses and email addresses. Findings name the file, line and kind,
   never the value.

Screenshots are base64 strings inside the logs. They are skipped by shape (long pure base64,
or data: image URLs), so random letters inside an image never count as a finding.
"""
from __future__ import annotations

import getpass
import json
import os
import re
import shutil
import socket
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Environment variables whose values are secrets. Short values (flags, ports) are ignored.
SECRET_NAME = re.compile(r'KEY|TOKEN|SECRET|PASSWORD', re.I)
MIN_SECRET_LENGTH = 12

# Dropped wherever they appear: X window and process IDs of the game on the game machine.
DROP_ALWAYS = {'pid', 'windowId'}
# Dropped from memory samples: machine-wide memory and the graphics driver and PCI device.
DROP_IN_MEMORY_SAMPLE = {'system', 'graphics'}
# A "directory" holding an absolute path (the recorder's frame folder on this machine) is dropped too.
ABSOLUTE_PATH = re.compile(r'/|[A-Za-z]:\\')

BASE64_BLOB = re.compile(r'[A-Za-z0-9+/=\r\n]{512,}')

PATTERNS = [
    ('API key', re.compile(r'\bsk-[A-Za-z0-9_-]{20,}')),
    ('API key', re.compile(r'\bhf_[A-Za-z0-9]{30,}')),
    ('API key', re.compile(r'\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}')),
    ('API key', re.compile(r'\bAKIA[0-9A-Z]{16}\b')),
    ('API key', re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}')),
    ('bearer token', re.compile(r'\bBearer\s+[A-Za-z0-9._~+/=-]{20,}', re.I)),
    ('private key', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
    ('home path', re.compile(r'/(?:home|Users)/(?!<)[^/\s"\'<>]+')),
    # Windows paths inside the Proton prefix; steamuser is Proton's generic user.
    ('home path', re.compile(r'\b[A-Za-z]:\\+(?:Users|home)\\+(?!steamuser\b)[^\\\s"\'<>]+', re.I)),
    ('user runtime path', re.compile(r'/run/user/\d+|/var/folders/')),
    ('email address', re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}')),
]
IPV4 = re.compile(r'(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])')


def read_env(path: Path) -> dict[str, str]:
    """KEY=VALUE lines of a .env file; comments and blank lines skipped, quotes removed."""
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip().removeprefix('export ').strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        values[key] = value
    return values


@dataclass
class Machine:
    """What identifies the machines that made the runs."""
    # (value, placeholder), longest value first so a path is replaced before its parts.
    replace: list[tuple[str, str]] = field(default_factory=list)
    secrets: list[str] = field(default_factory=list)
    # (word, kind): user and host names. Replacing a plain word could rewrite ordinary text
    # ("game", "desktop"), so a match is reported instead.
    names: list[tuple[str, str]] = field(default_factory=list)


def _distinctive(value: str) -> bool:
    """Paths, dotted names and addresses: safe to replace wherever they appear."""
    return any(c in value for c in './@:')


def machine_values(root: Path = ROOT, environ: dict[str, str] | None = None) -> Machine:
    """Values from .env, the saved model profiles and this machine."""
    env = read_env(root / '.env')
    environ = dict(os.environ) if environ is None else environ
    replace: dict[str, str] = {}
    names: dict[str, str] = {}

    def host_value(value: str, placeholder: str):
        if _distinctive(value):
            replace[value] = placeholder
        elif len(value) >= 2:
            names[value] = 'host name'

    host = env.get('GAME_SSH_HOST') or environ.get('GAME_SSH_HOST') or ''
    game_root = (env.get('GAME_REMOTE_ROOT') or environ.get('GAME_REMOTE_ROOT') or '').rstrip('/')
    if host:
        user, _, address = host.rpartition('@')
        host_value(host, '<game-host>')
        host_value(address, '<game-host>')
        if user:
            names[user] = 'user name'
    if len(game_root) > 1:
        replace[game_root] = '<game-root>'
    home = str(Path.home())
    if len(home) > 1:
        replace[home] = '<home>'
    hostname = socket.gethostname()
    host_value(hostname, '<hostname>')
    host_value(hostname.split('.')[0], '<hostname>')
    try:
        names[getpass.getuser()] = 'user name'
    except Exception:
        pass
    names.pop('root', None)

    secrets = {value for source in (env, environ) for key, value in source.items()
               if SECRET_NAME.search(key) and len(value) >= MIN_SECRET_LENGTH}
    try:
        profiles = json.loads((root / 'harness/runtime/config/models.json').read_text(encoding='utf-8'))
        secrets |= {p['apiKey'] for p in profiles if isinstance(p, dict) and isinstance(p.get('apiKey'), str)
                    and len(p['apiKey']) >= MIN_SECRET_LENGTH}
    except (OSError, ValueError, TypeError):
        pass
    return Machine(
        replace=sorted(replace.items(), key=lambda item: -len(item[0])),
        secrets=sorted(secrets),
        names=sorted(names.items()),
    )


@dataclass(frozen=True)
class Finding:
    file: str
    where: str
    kind: str

    def __str__(self):
        return f'{self.file} {self.where}: {self.kind}'


class Scrubber:
    def __init__(self, machine: Machine):
        self.machine = machine
        self.name_patterns = [(kind, re.compile(rf'(?<![A-Za-z0-9_.-]){re.escape(word)}(?![A-Za-z0-9_-])'))
                              for word, kind in machine.names]
        self.replaced: Counter[tuple[str, str]] = Counter()
        self.dropped: Counter[str] = Counter()
        self.findings: list[Finding] = []
        self._seen: set[Finding] = set()
        self._changed = False

    def _find(self, file: str, where: str, kind: str):
        finding = Finding(file, where, kind)
        if finding not in self._seen:
            self._seen.add(finding)
            self.findings.append(finding)

    def text(self, value: str, file: str, where: str) -> str:
        """One string: placeholders for known values, findings for anything else private."""
        if len(value) >= 512 and (value.startswith('data:image/') or BASE64_BLOB.fullmatch(value)):
            return value
        for known, placeholder in self.machine.replace:
            if known in value:
                self.replaced[(file, placeholder)] += value.count(known)
                value = value.replace(known, placeholder)
                self._changed = True
        for secret in self.machine.secrets:
            if secret in value:
                self._find(file, where, 'saved secret')
        for kind, pattern in PATTERNS:
            if pattern.search(value):
                self._find(file, where, kind)
        for match in IPV4.finditer(value):
            octets = [int(part) for part in match.groups()]
            if max(octets) <= 255 and octets[0] != 127 and octets != [0, 0, 0, 0]:
                self._find(file, where, 'IP address')
                break
        for kind, pattern in self.name_patterns:
            if pattern.search(value):
                self._find(file, where, kind)
        return value

    def value(self, value, file: str, where: str):
        """A parsed JSON value, walked recursively; machine-only fields are dropped."""
        if isinstance(value, str):
            return self.text(value, file, where)
        if isinstance(value, list):
            return [self.value(item, file, where) for item in value]
        if isinstance(value, dict):
            memory = value.get('type') == 'memory_sample'
            out = {}
            for key, item in value.items():
                if key in DROP_ALWAYS or (memory and key in DROP_IN_MEMORY_SAMPLE) or (
                        key == 'directory' and isinstance(item, str) and ABSOLUTE_PATH.match(item)):
                    self.dropped[key] += 1
                    self._changed = True
                    continue
                out[key] = self.value(item, file, where)
            return out
        return value

    def file(self, src: Path, dst: Path, name: str):
        """Copy one file, scrubbed. Lines and files that need no change are copied byte for byte."""
        dst.parent.mkdir(parents=True, exist_ok=True)
        suffix = src.suffix.lower()
        if suffix == '.jsonl':
            with open(src, encoding='utf-8') as source, open(dst, 'w', encoding='utf-8') as out:
                for number, line in enumerate(source, 1):
                    if not line.strip():
                        out.write(line)
                        continue
                    try:
                        record = json.loads(line)
                    except ValueError:
                        # A half-written last line: an unfinished run. Not published as is.
                        self._find(name, f'line {number}', 'unreadable line')
                        continue
                    self._changed = False
                    cleaned = self.value(record, name, f'line {number}')
                    out.write(json.dumps(cleaned, ensure_ascii=False, separators=(',', ':')) + '\n'
                              if self._changed else line)
        elif suffix == '.json':
            raw = src.read_text(encoding='utf-8')
            try:
                record = json.loads(raw)
            except ValueError:
                self._find(name, 'file', 'unreadable JSON')
                return
            self._changed = False
            cleaned = self.value(record, name, 'file')
            dst.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2) + '\n' if self._changed else raw,
                           encoding='utf-8')
        elif suffix in ('.md', '.txt'):
            dst.write_text(self.text(src.read_text(encoding='utf-8'), name, 'file'), encoding='utf-8')
        else:
            shutil.copyfile(src, dst)

    def replaced_in(self, *names: str) -> int:
        return sum(count for (file, _), count in self.replaced.items() if file in names)

    def summary(self) -> dict:
        return {
            'replaced': {f'{file}: {placeholder}': n for (file, placeholder), n in sorted(self.replaced.items())},
            'dropped_fields': dict(sorted(self.dropped.items())),
            'findings': [str(f) for f in self.findings],
        }
