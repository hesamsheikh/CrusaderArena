#!/usr/bin/env python3
"""Local-only terminal monitor and stop latch for the game bridge."""
import fcntl
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import termios
import time
import tty
import uuid

BASE = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / 'crusader-arena'

def clean(value):
    return ''.join(c for c in str(value) if c.isprintable())[:180]

def atomic(file, data):
    tmp = file.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.chmod(0o600)
    tmp.replace(file)

def read(file):
    try:
        return json.loads(file.read_text())
    except (OSError, ValueError):
        return {}

class Monitor:
    def __init__(self):
        BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.bridge_lock = (BASE / "bridge.lock").open("a")
        try:
            fcntl.flock(self.bridge_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.bridge_lock.close()
            raise RuntimeError("Another Crusader game bridge is already connected.")
        self.session = str(uuid.uuid4())
        self.state = dict(session=self.session, connected=True, phase='IDLE', model='', run='', tokens=0, turns=0, events=[], screenshots=0, commands=0, stopped=False)
        self.last_control = None
        self.started = time.monotonic()
        self.publish()
        lock = (BASE / 'viewer.lock').open('a')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            subprocess.Popen(['xterm', '-T', 'Crusader Arena — Game control monitor', '-geometry', '94x27', '-fa', 'DejaVu Sans Mono', '-fs', '11', '-bg', '#201317', '-fg', '#eadfca', '-e', sys.executable, str(Path(__file__).resolve()), 'view'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except BlockingIOError:
            pass
        finally:
            lock.close()
    def publish(self):
        self.state['heartbeat'] = time.time()
        atomic(BASE / 'status.json', self.state)
    def event(self, text):
        events = self.state['events']
        if text.startswith('Game screenshot') and events and events[-1]['text'].startswith('Game screenshot'):
            events = events[:-1]
        self.state['events'] = (events + [{'at':time.strftime('%H:%M:%S'), 'text':clean(text)}])[-14:]
        self.publish()
    def viewer_alive(self):
        with (BASE / 'viewer.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return False
            except BlockingIOError:
                return True
    def control(self):
        if time.monotonic() - self.started > 3 and not self.viewer_alive():
            if not self.state['stopped']:
                self.state['stopped'] = True
                self.state['phase'] = 'STOPPED LOCALLY'
                self.event('Monitor closed: inputs blocked; host notified')
                return 'stop'
            return None
        request = read(BASE / 'control.json')
        if request.get('session') != self.session or request.get('id') == self.last_control:
            return None
        self.last_control = request.get('id')
        command = request.get('command')
        if command == 'stop':
            self.state['stopped'] = True
            self.state['phase'] = 'STOPPED LOCALLY'
            self.event('Local Stop: inputs blocked; host notified')
        elif command == 'resume':
            self.state['stopped'] = False
            self.state['phase'] = 'IDLE'
            self.event('Input enabled locally; start a new run from the dashboard')
        return command
    def allowed(self):
        self.control()
        if self.state['stopped']:
            raise RuntimeError('Stopped locally. Press R in the Ubuntu monitor to enable input.')
    def update(self, data):
        for key in ('model','run','phase'):
            if key in data and not (key == 'phase' and self.state['stopped']):
                self.state[key] = clean(data[key])
        for key in ('tokens','turns'):
            if isinstance(data.get(key), int):
                self.state[key] = data[key]
        if isinstance(data.get('stats'), dict):
            self.state['stats'] = {k:v for k,v in data['stats'].items() if k in ('gold','population','troops','paused') and isinstance(v,(int,bool))}
        if data.get('event'):
            self.event(data['event'])
        else:
            self.publish()

def view():
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (BASE / 'viewer.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    old = termios.tcgetattr(sys.stdin)
    tty.setcbreak(sys.stdin)
    try:
        while True:
            s = read(BASE / 'status.json')
            online = s.get('connected') and time.time()-s.get('heartbeat',0) < 4
            lines = ['CRUSADER ARENA  |  GAME-WINDOW CONTROL', '='*76,
                     f"{'CONNECTED' if online else 'DISCONNECTED'}  |  {clean(s.get('phase','')) if online else 'No live host connection'}",
                     'Model: '+clean(s.get('model') or '—'), 'Run: '+clean(s.get('run') or '—'),
                     f"Screenshots sent to host: {s.get('screenshots',0)}   Commands received: {s.get('commands',0)}",
                     f"Turns: {s.get('turns',0)}   Tokens: {s.get('tokens',0)}",
                     'Game stats: '+clean(s.get('stats',{})), '-'*76]
            lines += [f"{e['at']}  {clean(e['text'])}" for e in s.get('events',[])]
            lines += ['','S / Space: STOP and block input   R: enable input   Q: stop and close',
                      'Input delivery is not confirmation of a game effect.']
            sys.stdout.write('\x1b[H\x1b[2J'+'\n'.join(lines)+'\n');sys.stdout.flush()
            if select.select([sys.stdin],[],[],0.25)[0]:
                key = sys.stdin.read(1).lower()
                if key == 'q':
                    if online: atomic(BASE / 'control.json', {'session':s['session'],'id':str(uuid.uuid4()),'command':'stop'})
                    break
                if key in ('s',' ','r') and online:
                    atomic(BASE / 'control.json', {'session':s['session'],'id':str(uuid.uuid4()),'command':'resume' if key=='r' else 'stop'})
    finally:
        termios.tcsetattr(sys.stdin,termios.TCSADRAIN,old)
        sys.stdout.write('\x1b[0m\n')

if __name__ == '__main__':
    view()
