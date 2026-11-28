"""Tests for gossip_gate.py with a fake writer, over real ZMQ sockets.

Run: python3 -m unittest discover -s gossip-gate -v   (needs pyzmq)
"""

import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import zmq

HERE = os.path.dirname(os.path.abspath(__file__))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(pred, timeout=10.0, what="condition"):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


class GateTest(unittest.TestCase):
    def start(self, **env):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake_log = os.path.join(self.tmp.name, "fake.log")
        self.gate_log = os.path.join(self.tmp.name, "gate.log")
        open(self.fake_log, "w").close()
        front = f"tcp://127.0.0.1:{free_port()}"
        e = dict(os.environ)
        e.update({
            "GOSSIP_GATE_BIND": front,
            "GOSSIP_WRITER_BIND": f"tcp://127.0.0.1:{free_port()}",
            "GOSSIP_WRITER_CMD": f"{sys.executable} -u {os.path.join(HERE, 'fake_writer.py')}",
            "FAKE_LOG": self.fake_log,
            "GOSSIP_IDLE_SECONDS": "30",
            "GOSSIP_PEER_WAIT_SECONDS": "30",
            "GOSSIP_BIND_WAIT_SECONDS": "30",
            "GOSSIP_NO_PEER_MAX_SECONDS": "30",
            "GOSSIP_RESTART_BACKOFF_SECONDS": "0.2",
            "GOSSIP_STOP_GRACE_SECONDS": "3",
        })
        e.update({k: str(v) for k, v in env.items()})
        self.gate_out = open(self.gate_log, "w")
        self.addCleanup(self.gate_out.close)
        self.gate = subprocess.Popen(
            [sys.executable, "-u", os.path.join(HERE, "gossip_gate.py")],
            env=e, stdout=self.gate_out, stderr=subprocess.STDOUT,
        )
        self.addCleanup(self.kill_all)
        wait_for(lambda: "listening on" in self.gate_text(), what="gate start")
        # The same socket set-up as hivepinger's GossipClient.
        self.ctx = zmq.Context()
        self.client = self.ctx.socket(zmq.PAIR)
        self.client.setsockopt(zmq.SNDTIMEO, 50)
        self.client.setsockopt(zmq.LINGER, 0)
        self.client.connect(front)
        self.addCleanup(self.ctx.destroy, 0)

    def kill_all(self):
        if self.gate.poll() is None:
            self.gate.kill()
            self.gate.wait()
        for pid in self.writer_pids():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def send(self, text):
        self.client.send(text.encode(), zmq.DONTWAIT)

    def gate_text(self):
        with open(self.gate_log) as f:
            return f.read()

    def events(self):
        with open(self.fake_log) as f:
            return [line.split(" ", 2) for line in f.read().splitlines()]

    def event_names(self):
        return [e[2] for e in self.events()]

    def starts(self):
        return self.event_names().count("start")

    def writer_pids(self):
        return sorted({int(e[1]) for e in self.events()})

    def received(self):
        return [n[5:] for n in self.event_names() if n.startswith("recv ")]

    def time_of(self, name):
        return next(float(t) for t, _pid, n in self.events() if n == name)

    def wait_received(self, *texts, timeout=10.0):
        wait_for(lambda: all(t in self.received() for t in texts), timeout, f"podpings {texts}")


class TestGossipGate(GateTest):
    def test_starts_writer_on_first_podping_and_waits_for_a_neighbor(self):
        self.start(FAKE_BIND_DELAY=0.5, FAKE_NEIGHBOR_DELAY=0.7)
        time.sleep(0.5)
        self.assertEqual(self.starts(), 0, "no writer before the first podping")
        self.send("p1")
        self.wait_received("p1")
        self.assertEqual(self.starts(), 1)
        self.assertGreaterEqual(self.time_of("recv p1"), self.time_of("neighbor"))
        # Once the writer is ready, a podping goes straight through.
        self.send("p2")
        self.wait_received("p2", timeout=2)
        self.assertEqual(self.starts(), 1)
        self.assertIn("(first neighbor)", self.gate_text())
        # The writer's own output reaches the log.
        self.assertIn("[EVENT] NeighborUp: fake-peer", self.gate_text())

    def test_podpings_during_the_start_share_one_writer(self):
        self.start(FAKE_BIND_DELAY=0.3, FAKE_NEIGHBOR_DELAY=1.0)
        self.send("p1")
        time.sleep(0.4)
        self.send("p2")
        time.sleep(0.4)
        self.send("p3")
        self.wait_received("p1", "p2", "p3")
        self.assertEqual(self.starts(), 1)
        self.assertEqual(self.received(), ["p1", "p2", "p3"])

    def test_idle_writer_gets_sigint_and_the_next_podping_starts_it_again(self):
        self.start(GOSSIP_IDLE_SECONDS=1)
        self.send("p1")
        self.wait_received("p1")
        wait_for(lambda: "sigint" in self.event_names(), 5, "idle stop")
        wait_for(lambda: "writer stopped (idle 1s)" in self.gate_text(), 5, "stop log")
        self.assertIn("1 podping(s), 1 confirmed, exit code 0", self.gate_text())
        self.send("p2")
        self.wait_received("p2")
        self.assertEqual(self.starts(), 2)

    def test_hands_over_without_a_neighbor_after_the_peer_wait(self):
        self.start(FAKE_NEIGHBOR_DELAY="never", GOSSIP_PEER_WAIT_SECONDS=0.5,
                   GOSSIP_NO_PEER_MAX_SECONDS=2, GOSSIP_IDLE_SECONDS=0.2)
        self.send("p1")
        self.wait_received("p1")
        self.assertIn("no neighbor after 0.5s", self.gate_text())
        # With no neighbor the idle time does not apply: it runs to the limit.
        time.sleep(0.8)
        self.assertNotIn("sigint", self.event_names())
        wait_for(lambda: "writer stopped (no neighbor in 2s)" in self.gate_text(), 5, "no-peer stop")

    def test_a_writer_that_cannot_start_is_retried_then_its_podpings_dropped(self):
        self.start(FAKE_FAIL_START=1)
        self.send("p1")
        wait_for(lambda: "dropping 1 podping(s)" in self.gate_text(), 5, "drop after 3 tries")
        self.assertEqual(self.starts(), 3)
        time.sleep(0.5)
        self.assertEqual(self.starts(), 3, "no retries with nothing held")
        self.assertIsNone(self.gate.poll(), "the gate keeps running")

    def test_a_writer_that_never_binds_is_stopped(self):
        self.start(FAKE_BIND_DELAY=5, GOSSIP_BIND_WAIT_SECONDS=0.5)
        self.send("p1")
        wait_for(lambda: "did not bind" in self.gate_text(), 5, "bind timeout")
        self.assertIsNone(self.gate.poll())

    def test_a_writer_that_crashes_is_reported_and_started_again_later(self):
        self.start(FAKE_EXIT_AFTER=1)
        self.send("p1")
        self.wait_received("p1")
        wait_for(lambda: "1 podping(s) may not have reached gossip" in self.gate_text(), 5, "crash log")
        self.send("p2")
        self.wait_received("p2")
        self.assertEqual(self.starts(), 2)

    def test_sigterm_to_the_gate_stops_the_writer(self):
        self.start()
        self.send("p1")
        self.wait_received("p1")
        self.gate.send_signal(signal.SIGTERM)
        self.assertEqual(self.gate.wait(5), 0)
        self.assertIn("sigint", self.event_names())
        self.assertIn("writer stopped (gate shutting down)", self.gate_text())

    def test_a_writer_that_ignores_sigint_is_killed(self):
        self.start(FAKE_IGNORE_SIGINT=1, GOSSIP_IDLE_SECONDS=0.3, GOSSIP_STOP_GRACE_SECONDS=0.5)
        self.send("p1")
        self.wait_received("p1")
        wait_for(lambda: "ignored SIGINT for 0.5s; killing it" in self.gate_text(), 5, "kill")
        wait_for(lambda: "writer stopped (idle 0.3s)" in self.gate_text(), 5, "stop log")
        pid = self.writer_pids()[0]
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)


if __name__ == "__main__":
    unittest.main()
