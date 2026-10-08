import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('control_status', Path(__file__).with_name('control-status.py'))
status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(status)

class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = patch.object(status, 'BASE', Path(self.tmp.name))
        self.base.start();self.addCleanup(self.base.stop)
        with patch.object(status.subprocess, 'Popen'):
            self.monitor = status.Monitor()
        self.addCleanup(self.monitor.bridge_lock.close)
    def command(self, value, session=None):
        status.atomic(status.BASE/'control.json', dict(session=session or self.monitor.session,id=value,command=value))
    def test_stop_is_latched_and_old_session_cannot_resume(self):
        self.command('stop');self.assertEqual(self.monitor.control(),'stop')
        with self.assertRaises(RuntimeError):self.monitor.allowed()
        self.monitor.update({'phase':'AGENT RUNNING'})
        self.assertEqual(self.monitor.state['phase'],'STOPPED LOCALLY')
        self.command('resume','old-session');self.monitor.control()
        self.assertTrue(self.monitor.state['stopped'])
        self.command('resume');self.monitor.control();self.monitor.allowed()
    def test_capture_activity_does_not_erase_commands(self):
        self.monitor.event('Input delivered')
        for _ in range(50):self.monitor.event('Game screenshot sent to host: 1920x1080')
        self.assertEqual(len(self.monitor.state['events']),2)
    def test_only_one_bridge_can_own_monitor(self):
        with self.assertRaisesRegex(RuntimeError, 'already connected'):
            status.Monitor()
    def test_closing_monitor_stops_input(self):
        self.monitor.started -= 10
        self.assertEqual(self.monitor.control(), 'stop')
        with self.assertRaises(RuntimeError): self.monitor.allowed()
    def test_status_is_private_and_filters_unrelated_fields(self):
        self.monitor.update({'apiKey':'secret','model':'test\x1b\nmodel','stats':{'gold':5,'apiKey':'secret'}})
        data=status.read(status.BASE/'status.json')
        self.assertNotIn('secret',str(data));self.assertNotIn('\x1b',data['model'])
        self.assertEqual((status.BASE/'status.json').stat().st_mode & 0o777,0o600)

if __name__=='__main__':unittest.main()
