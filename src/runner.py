"""Stream foreground output without inheriting background processes' pipes.

The SDK command execs this process, so SIGTERM can terminate the shell's
entire process group. A normal foreground exit leaves background jobs alive.
"""
import os
import signal
import subprocess
import sys
import tempfile
import time

command, timeout = sys.argv[1], float(sys.argv[2])
child = None
cancelled = False


def cancel(_signum, _frame):
    global cancelled
    cancelled = True


signal.signal(signal.SIGTERM, cancel)
signal.signal(signal.SIGINT, cancel)

with tempfile.TemporaryFile() as output:
    child = subprocess.Popen(
        ['bash', '-c', command], stdin=subprocess.DEVNULL,
        stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
    )
    started = time.monotonic()
    position = 0
    timed_out = False
    while True:
        timed_out = timeout > 0 and time.monotonic() - started >= timeout
        if cancelled or timed_out:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        # pread leaves the shared write offset unchanged.
        status = child.poll()
        size = os.fstat(output.fileno()).st_size
        while position < size:
            data = os.pread(output.fileno(), min(65536, size - position), position)
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            position += len(data)
        if status is not None:
            break
        time.sleep(0.03)
    sys.exit(130 if cancelled else 124 if timed_out else status if status >= 0 else 128 - status)
