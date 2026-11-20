"""How the retrain process and its gate workers end: together, never one without the other.

The gate (db.backtest.map_origins) forks worker processes. A forked worker
holds copies of the parent's stdout and stderr, so a worker that outlives
its parent keeps the web app's pipes open, and it never exits on its own
(it waits for work on a queue it also holds the writing end of). Three
rules keep that from happening:

    bind_to_parent(parent_pid, signum)   Linux: the kernel sends `signum` to
                                         this process the moment its parent
                                         ends, however it ends (kill -9
                                         included). Workers bind with SIGKILL.
    stop_on_signals()                    SIGTERM, SIGINT and SIGHUP kill every
                                         child at once and raise Stopped in the
                                         main thread, so the run unwinds (an open
                                         write transaction rolls back) and ends;
                                         restore_signals(previous) undoes it.
    kill_children()                      SIGKILL to every direct child.

Nothing here changes what a run computes.
"""

from __future__ import annotations

import ctypes
import os
import signal
from pathlib import Path

# <linux/prctl.h>
PR_SET_PDEATHSIG = 1
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
PROC = Path("/proc")


class Stopped(BaseException):
    """A stop signal arrived. BaseException, like KeyboardInterrupt, so no
    `except Exception` on the way up mistakes it for a failure of its own."""

    def __init__(self, signum: int):
        self.signum = signum
        self.name = signal.Signals(signum).name
        super().__init__(f"stopped by {self.name}")


def bind_to_parent(parent_pid: int, signum: int = signal.SIGKILL) -> bool:
    """Have the kernel send `signum` to this process when its parent ends.

    `parent_pid` is the parent it was started by: if that one is already
    gone (it ended before the request was in place), the signal is sent now.
    Returns False where the kernel has no such request (not Linux)."""
    try:
        prctl = ctypes.CDLL(None, use_errno=True).prctl
    except (OSError, AttributeError):
        return False
    if prctl(PR_SET_PDEATHSIG, int(signum), 0, 0, 0) != 0:
        return False
    if os.getppid() != parent_pid:
        os.kill(os.getpid(), signum)
    return True


def _children(pid: int) -> list[int]:
    """Direct children of `pid`, from /proc (empty where there is no /proc)."""
    found = []
    try:
        entries = [entry for entry in PROC.iterdir() if entry.name.isdigit()]
    except OSError:
        return found
    for entry in entries:
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue  # ended while we looked
        # "pid (command) state ppid ...": the command may hold spaces and parentheses.
        fields = stat[stat.rfind(")") + 2:].split()
        if len(fields) > 1 and int(fields[1]) == pid:
            found.append(int(entry.name))
    return found


def kill_children() -> list[int]:
    """SIGKILL every direct child of this process. Returns their pids."""
    killed = []
    for child in _children(os.getpid()):
        try:
            os.kill(child, signal.SIGKILL)
            killed.append(child)
        except ProcessLookupError:
            pass
    return killed


def _on_stop(signum, _frame) -> None:
    # A second signal while this one unwinds ends the process at once.
    signal.signal(signum, signal.SIG_DFL)
    kill_children()
    raise Stopped(signum)


def stop_on_signals() -> dict:
    """Turn SIGTERM, SIGINT and SIGHUP into Stopped in the main thread. A
    signal the caller already ignores (nohup, a background job) stays ignored.
    Returns the handlers it replaced, for restore_signals."""
    previous = {}
    for signum in STOP_SIGNALS:
        handler = signal.getsignal(signum)
        if handler is not signal.SIG_IGN:
            previous[signum] = handler
            signal.signal(signum, _on_stop)
    return previous


def restore_signals(previous: dict) -> None:
    for signum, handler in previous.items():
        signal.signal(signum, handler)


def end_by(signum: int) -> None:
    """End this process the way `signum` ends it by default, so whoever
    started it sees that signal, not an exit code."""
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)
    os._exit(128 + signum)  # only if the signal did not end it
