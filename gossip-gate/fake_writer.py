"""A stand-in for gossip-writer in the gate's tests.

It binds a ZMQ PAIR socket on ZMQ_BIND_ADDR, prints the same lines the real
writer prints when it binds and when it gets a neighbor, answers each message
with a reply, and shuts down on SIGINT. Every step is written to FAKE_LOG as
"<monotonic time> <pid> <event>".

  FAKE_BIND_DELAY      seconds before the bind (default 0)
  FAKE_NEIGHBOR_DELAY  seconds after the bind before NeighborUp, or "never" (default 0)
  FAKE_FAIL_START      exit with code 3 at once
  FAKE_EXIT_AFTER      exit with code 4 after this many messages, without a reply
  FAKE_IGNORE_SIGINT   ignore SIGINT
"""

import os
import signal
import sys
import time

import zmq

LOG = os.environ["FAKE_LOG"]


def note(event):
    with open(LOG, "a") as f:
        f.write(f"{time.monotonic():.3f} {os.getpid()} {event}\n")


note("start")
if os.environ.get("FAKE_FAIL_START"):
    note("fail")
    sys.exit(3)

stop = False


def on_sigint(*_):
    global stop
    stop = True


if os.environ.get("FAKE_IGNORE_SIGINT"):
    signal.signal(signal.SIGINT, signal.SIG_IGN)
else:
    signal.signal(signal.SIGINT, on_sigint)

time.sleep(float(os.environ.get("FAKE_BIND_DELAY", "0")))
addr = os.environ["ZMQ_BIND_ADDR"]
sock = zmq.Context.instance().socket(zmq.PAIR)
sock.setsockopt(zmq.LINGER, 0)
sock.bind(addr)
print(f"  ZMQ PAIR socket bound on {addr}", flush=True)
note("bound")

delay = os.environ.get("FAKE_NEIGHBOR_DELAY", "0")
neighbor_at = None if delay == "never" else time.monotonic() + float(delay)
exit_after = int(os.environ.get("FAKE_EXIT_AFTER", "0"))
received = 0

while not stop:
    if neighbor_at is not None and time.monotonic() >= neighbor_at:
        print("\x1b[32m[EVENT] NeighborUp: fake-peer\x1b[0m", flush=True)
        note("neighbor")
        neighbor_at = None
    if sock.poll(20):
        msg = sock.recv()
        received += 1
        note("recv " + msg.decode())
        if exit_after and received >= exit_after:
            note("crash")
            sys.exit(4)
        sock.send(b"reply")

note("sigint")
print("  ZMQ thread: shutdown signal received.", flush=True)
