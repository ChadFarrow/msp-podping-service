#!/usr/bin/env python3
"""gossip-gate: run gossip-writer only while there is a podping to send.

MSP sends a couple dozen podpings a month, but an always-on gossip-writer is a
full iroh gossip node: about 4 GB a day of egress and 200 MB of memory on
Railway, about $7.50 a month. This gate takes the writer's place on the ZMQ
address that hivepinger connects to (127.0.0.1:9998). On the first podping it
starts gossip-writer on a second address (127.0.0.1:9997), holds the podping
until the writer has bound its socket and has a gossip neighbor (or a timeout
passes), then hands it over. It stops the writer again after an idle time.

hivepinger does not change: it sends one Cap'n Proto PodpingWrite per IRI over
a ZMQ PAIR socket, fire and forget, and drains any replies. The gate forwards
the frames as they are, and reads and drops the writer's replies (one per IRI,
sent after the writer has signed the batch and queued it for broadcast).

Every failure here costs gossip copies only. The Hive write already happened.
"""

import ctypes
import os
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
from collections import deque

import zmq


def env_float(name, default):
    raw = os.environ.get(name, "")
    try:
        return float(raw) if raw.strip() else default
    except ValueError:
        log(f"{name}={raw!r} is not a number; using {default}")
        return default


def log(msg):
    print(f"[gossip-gate] {msg}", flush=True)


ANSI = re.compile(r"\x1b\[[0-9;]*m")
BOUND = "ZMQ PAIR socket bound on"
NEIGHBOR_UP = "[EVENT] NeighborUp:"

MAX_HELD = 10_000  # hivepinger's own SNDHWM
MAX_FAILED_STARTS = 3


class Config:
    def __init__(self):
        self.front = os.environ.get("GOSSIP_GATE_BIND", "tcp://127.0.0.1:9998")
        self.back = os.environ.get("GOSSIP_WRITER_BIND", "tcp://127.0.0.1:9997")
        self.writer_cmd = shlex.split(os.environ.get("GOSSIP_WRITER_CMD", "gossip-writer"))
        # Stop the writer this long after the last podping, its last reply, or
        # its first neighbor, whichever is latest.
        self.idle = env_float("GOSSIP_IDLE_SECONDS", 120.0)
        # Hand the held podpings over after this long even with no neighbor:
        # iroh-gossip queues a broadcast until a first connection.
        self.peer_wait = env_float("GOSSIP_PEER_WAIT_SECONDS", 60.0)
        # A writer that has not bound its ZMQ socket by then failed to start.
        self.bind_wait = env_float("GOSSIP_BIND_WAIT_SECONDS", 60.0)
        # A writer that never found a neighbor still stops after this long.
        self.no_peer_max = env_float("GOSSIP_NO_PEER_MAX_SECONDS", 600.0)
        self.restart_backoff = env_float("GOSSIP_RESTART_BACKOFF_SECONDS", 10.0)
        self.stop_grace = env_float("GOSSIP_STOP_GRACE_SECONDS", 10.0)


# Linux: the writer gets SIGKILL when the gate dies, so no orphan writer keeps
# 9997 (every later writer would then fail to bind, and the orphan would keep
# the egress bill running). Bound here, before any fork: the child must not
# load a library between fork and exec while libzmq threads run in the gate.
PR_SET_PDEATHSIG = 1
try:
    _prctl = ctypes.CDLL("libc.so.6", use_errno=True).prctl
except OSError:
    _prctl = None  # not Linux (local tests on macOS)


def _child_setup():
    _prctl(PR_SET_PDEATHSIG, int(signal.SIGKILL))


class Writer:
    """One run of gossip-writer, with a thread that relays and watches its output."""

    def __init__(self, cfg):
        env = dict(os.environ)
        env["ZMQ_BIND_ADDR"] = cfg.back
        self.started = time.monotonic()
        self.bound = threading.Event()
        self.neighbor_at = None
        self.proc = subprocess.Popen(
            cfg.writer_cmd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            preexec_fn=_child_setup if _prctl is not None else None,
        )
        # The writer prints a line for every podping it sees on gossip, so its
        # pipe must be drained all the time or it blocks.
        self.reader = threading.Thread(target=self._relay, daemon=True)
        self.reader.start()

    def _relay(self):
        out = sys.stdout.buffer
        for raw in iter(self.proc.stdout.readline, b""):
            try:
                out.write(raw)
                out.flush()
            except Exception:
                pass
            line = ANSI.sub("", raw.decode("utf-8", "replace"))
            if BOUND in line:
                self.bound.set()
            elif NEIGHBOR_UP in line and self.neighbor_at is None:
                self.neighbor_at = time.monotonic()

    @property
    def pid(self):
        return self.proc.pid

    def exited(self):
        return self.proc.poll() is not None

    def stop(self, grace):
        if self.exited():
            return self.proc.returncode
        self.proc.send_signal(signal.SIGINT)
        try:
            return self.proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            log(f"writer pid {self.pid} ignored SIGINT for {grace:g}s; killing it")
            self.proc.kill()
            return self.proc.wait()


class Gate:
    def __init__(self, cfg, ctx=None):
        self.cfg = cfg
        self.ctx = ctx or zmq.Context.instance()
        self.front = self.ctx.socket(zmq.PAIR)
        self.front.setsockopt(zmq.LINGER, 0)
        self.front.bind(cfg.front)
        self.back = None
        self.writer = None
        self.held = deque()
        self.handed_over = False  # held podpings sent to the current writer
        self.last_activity = 0.0
        self.sent = 0
        self.replies = 0
        self.failed_starts = 0
        self.next_start_at = 0.0
        self.running = True

    # --- writer lifecycle -------------------------------------------------

    def _start_writer(self):
        try:
            self.writer = Writer(self.cfg)
        except OSError as exc:
            log(f"cannot start {self.cfg.writer_cmd[0]}: {exc}")
            self._failed_start()
            return
        self.handed_over = False
        self.sent = 0
        self.replies = 0
        log(f"writer started (pid {self.writer.pid}) for {len(self.held)} podping(s)")

    def _connect_back(self):
        self.back = self.ctx.socket(zmq.PAIR)
        self.back.setsockopt(zmq.LINGER, 0)
        self.back.setsockopt(zmq.SNDHWM, MAX_HELD)
        self.back.connect(self.cfg.back)

    def _close_back(self):
        if self.back is not None:
            self.back.close(linger=0)
            self.back = None

    def _failed_start(self):
        self.writer = None
        self._close_back()
        self.failed_starts += 1
        self.next_start_at = time.monotonic() + self.cfg.restart_backoff
        if self.failed_starts >= MAX_FAILED_STARTS:
            if self.held:
                log(f"writer failed to start {self.failed_starts} times; dropping {len(self.held)} podping(s)")
            self.held.clear()
            self.failed_starts = 0

    def _writer_gone(self):
        code = self.writer.proc.returncode
        unconfirmed = self.sent - self.replies
        if not self.handed_over:
            log(f"writer exited with code {code} before it was ready; retrying in {self.cfg.restart_backoff:g}s")
            self._failed_start()
            return
        msg = f"writer exited with code {code}"
        if unconfirmed > 0:
            msg += f"; {unconfirmed} podping(s) may not have reached gossip"
        log(msg)
        self.writer = None
        self._close_back()
        self.next_start_at = time.monotonic() + self.cfg.restart_backoff

    def _stop_writer(self, reason):
        ran = time.monotonic() - self.writer.started
        code = self.writer.stop(self.cfg.stop_grace)
        log(f"writer stopped ({reason}) after {ran:.0f}s, {self.sent} podping(s), "
            f"{self.replies} confirmed, exit code {code}")
        self.writer = None
        self._close_back()

    # --- main loop ----------------------------------------------------------

    def _send(self, frames):
        try:
            self.back.send_multipart(frames, zmq.NOBLOCK)
            self.sent += 1
        except zmq.Again:
            log("writer queue full; dropping one podping")

    def _on_podping(self, frames):
        if self.writer is not None and self.handed_over:
            self._send(frames)
            self.last_activity = time.monotonic()
            return
        if len(self.held) >= MAX_HELD:
            self.held.popleft()
            log("too many held podpings; dropping the oldest")
        self.held.append(frames)

    def _tick(self):
        now = time.monotonic()
        w = self.writer

        if w is None:
            if self.held and now >= self.next_start_at:
                self._start_writer()
            return

        if w.exited():
            self._writer_gone()
            return

        if not self.handed_over:
            if not w.bound.is_set():
                if now - w.started >= self.cfg.bind_wait:
                    log(f"writer did not bind {self.cfg.back} in {self.cfg.bind_wait:g}s; stopping it")
                    w.stop(self.cfg.stop_grace)
                    self._failed_start()
                return
            if self.back is None:
                self._connect_back()
            peer = w.neighbor_at is not None
            if peer or now - w.started >= self.cfg.peer_wait:
                waited = now - w.started
                note = "first neighbor" if peer else f"no neighbor after {self.cfg.peer_wait:g}s"
                log(f"handing {len(self.held)} podping(s) to the writer after {waited:.1f}s ({note})")
                while self.held:
                    self._send(self.held.popleft())
                self.handed_over = True
                self.failed_starts = 0
                self.last_activity = now
            return

        if w.neighbor_at is None:
            if now - w.started >= self.cfg.no_peer_max:
                self._stop_writer(f"no neighbor in {self.cfg.no_peer_max:g}s")
            return
        if now - max(self.last_activity, w.neighbor_at) >= self.cfg.idle:
            self._stop_writer(f"idle {self.cfg.idle:g}s")

    def run(self):
        log(f"listening on {self.cfg.front}; writer on demand at {self.cfg.back}, "
            f"stops after {self.cfg.idle:g}s idle")
        while self.running:
            poller = zmq.Poller()
            poller.register(self.front, zmq.POLLIN)
            if self.back is not None:
                poller.register(self.back, zmq.POLLIN)
            timeout = 1000 if self.writer is None and not self.held else 200
            try:
                events = dict(poller.poll(timeout))
            except zmq.ZMQError as exc:
                if exc.errno == zmq.EINTR:
                    continue
                raise
            if self.front in events:
                while True:
                    try:
                        self._on_podping(self.front.recv_multipart(zmq.NOBLOCK))
                    except zmq.Again:
                        break
            if self.back is not None and self.back in events:
                while True:
                    try:
                        self.back.recv(zmq.NOBLOCK)
                        self.replies += 1
                        self.last_activity = time.monotonic()
                    except zmq.Again:
                        break
            self._tick()
        self.shutdown()

    def shutdown(self):
        if self.writer is not None:
            self._stop_writer("gate shutting down")
        self.front.close(linger=0)


def main():
    gate = Gate(Config())

    def on_signal(signum, _frame):
        gate.running = False

    # bash starts background jobs with SIGINT ignored, and an ignored signal
    # stays ignored across exec. The writer shuts down cleanly (flushing its
    # batch) only on SIGINT. A caught signal is reset to the default on exec,
    # so these handlers also give the writer a working SIGINT.
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    gate.run()


if __name__ == "__main__":
    main()
