"""Memory-limit boundary and /proc parsing checks; never signal a real process."""
from pathlib import Path
from runpy import run_path
import tempfile
import unittest

monitor = run_path(str(Path(__file__).with_name('monitor-memory.py')))


class MemoryMonitorTests(unittest.TestCase):
    def test_limits_and_boundary(self):
        limits = monitor['limits']
        self.assertEqual(limits(dict(rss_kib=8192*1024, available_kib=4096*1024), 8192, 4096), [])
        self.assertEqual(limits(dict(rss_kib=8192*1024+1, available_kib=4096*1024-1), 8192, 4096),
                         ['game_rss_limit', 'system_available_limit'])

    def test_reads_rss_not_virtual_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            (proc/'42').mkdir()
            (proc/'42/status').write_text('VmSize:\t999999 kB\nVmRSS:\t2000 kB\nVmSwap:\t12 kB\nThreads:\t7\n')
            (proc/'meminfo').write_text('MemFree: 5 kB\nMemAvailable: 6000 kB\n')
            self.assertEqual(monitor['sample'](42, proc),
                             dict(pid=42, rss_kib=2000, swap_kib=12, threads=7, available_kib=6000, system_kib={"MemFree": 5}))

    def test_shared_memory_attribution_is_separate_from_game_rss(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            (proc/'42').mkdir()
            (proc/'42/status').write_text('VmRSS: 2000 kB\nVmSwap: 0 kB\nThreads: 2\nRssAnon: 1500 kB\nRssFile: 400 kB\nRssShmem: 100 kB\n')
            (proc/'meminfo').write_text('MemAvailable: 6000 kB\nShmem: 9000 kB\nUnevictable: 8000 kB\nSwapFree: 10000 kB\n')
            row = monitor['sample'](42, proc)
            self.assertEqual(row['rss_kib'], 2000)
            self.assertEqual(row['system_kib']['Shmem'], 9000)
            self.assertEqual(row['resident_kib']['RssShmem'], 100)
            self.assertEqual(monitor['limits'](row, 8, 4), [])

    def test_graphics_clients_deduplicate_descriptors_and_keep_devices_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            fd = proc/'42/fdinfo'
            fd.mkdir(parents=True)
            text = 'drm-driver: i915\ndrm-client-id: 8\ndrm-pdev: 0000:00:02.0\ndrm-resident-system0: 3000 KiB\ndrm-total-system0: 3500 KiB\ndrm-shared-system0: 0\ndrm-engine-render: 999 ns\n'
            (fd/'1').write_text(text)
            (fd/'2').write_text(text)
            (fd/'3').write_text(text.replace('0000:00:02.0', '0000:01:00.0'))
            (fd/'4').write_text('pos: 0\nflags: 1\n')
            result = monitor['graphics_clients'](42, proc)
            self.assertEqual(len(result['clients']), 2)
            self.assertEqual(result['read_errors'], 0)
            self.assertEqual(result['clients'][0]['memory_kib'], {
                'drm-resident-system0': 3000, 'drm-total-system0': 3500,
                'drm-shared-system0': 0})

    def test_graphics_attribution_failure_does_not_break_memory_sampling(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            (proc/'42/fdinfo').mkdir(parents=True)
            (proc/'42/fdinfo/1').symlink_to(proc/'missing')
            (proc/'42/status').write_text('VmRSS: 2000 kB\nVmSwap: 0 kB\nThreads: 2\n')
            (proc/'meminfo').write_text('MemAvailable: 6000 kB\n')
            row = monitor['sample'](42, proc)
            self.assertEqual(row['rss_kib'], 2000)
            self.assertEqual(row['graphics'], {'clients': [], 'read_errors': 1})
            self.assertEqual(monitor['limits'](row, 1, 0), ['game_rss_limit'])

    def test_invalid_or_missing_memory_is_not_zero(self):
        for value in ['123 MB', '123', '-1 kB', 'bad kB']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                monitor['kib'](value)
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(FileNotFoundError):
            monitor['sample'](42, Path(directory))

    def test_dying_process_without_rss_is_reported_as_exited(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            (proc/'42').mkdir()
            (proc/'42/status').write_text('State:\tZ (zombie)\nThreads:\t1\n')
            with self.assertRaises(ProcessLookupError):
                monitor['sample'](42, proc)

    def test_memory_map_groups_files_and_ranks_anonymous_regions(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            (proc/'42').mkdir()
            (proc/'42/smaps').write_text(
                '00400000-00500000 r-xp 00000000 08:01 12 /opt/game/libfoo.so\n'
                'Rss:                 512 kB\nAnonymous:             0 kB\n'
                '7f0000000000-7f0040000000 rw-p 00000000 00:00 0\n'
                'Rss:             1048576 kB\nAnonymous:       1048576 kB\n'
                '7f1000000000-7f1000100000 rw-p 00000000 00:00 0 [heap]\n'
                'Rss:                1024 kB\nAnonymous:          1024 kB\n')
            summary = monitor['memory_map'](42, proc)
            self.assertEqual(summary['mapping_count'], 3)
            self.assertEqual(summary['groups']['[anonymous]']['anonymous_kib'], 1048576)
            self.assertEqual(summary['groups']['libfoo.so']['rss_kib'], 512)
            self.assertEqual(summary['largest_anonymous'][0]['range'], '7f0000000000-7f0040000000')
            self.assertEqual(summary['largest_anonymous'][0]['size_kib'], 1048576)

    def test_thread_cpu_names_and_busiest_deltas(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            for tid, name, ticks in [('42', 'Main (x)', 100), ('43', 'UnityGfx', 50)]:
                (proc/'42/task'/tid).mkdir(parents=True)
                fields = ['S'] + ['0'] * 10 + [str(ticks), '5'] + ['0'] * 30
                (proc/'42/task'/tid/'stat').write_text(f'{tid} ({name}) ' + ' '.join(fields))
            after = monitor['thread_cpu'](42, proc)
            self.assertEqual(after['42'], ('Main (x)', 105))
            self.assertEqual(monitor['busiest']({'42': ('Main (x)', 100)}, after),
                             [dict(tid='43', name='UnityGfx', ticks=55), dict(tid='42', name='Main (x)', ticks=5)])


if __name__ == '__main__':
    unittest.main()
