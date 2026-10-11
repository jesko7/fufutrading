"""
INSTRUCTIONS FOR CLAUDE (read this when this file is referenced with @)

1. Immediately start this script in the BACKGROUND (Bash/PowerShell with
   run_in_background=true):

       python claude_usage.py

   It stays silent and polls `claude /usage` every minute. It only exits when
   usage reaches 95% (override: `python claude_usage.py 90`).

2. Carry on with the user's task normally.

3. When the background command exits, its output looks like:

       STOP usage=95.0% resets_at=2026-10-11T18:00:00+02:00 resume_at=2026-10-11T18:05:00+02:00

   On receiving that message: STOP working immediately. Do not start new
   tool calls or edits. Then run, in the background:

       python claude_usage.py --wait-until 2026-10-11T18:05:00+02:00

   (use the resume_at value). When that command exits, the limit has reset
   (+5 min buffer): continue the task where you stopped and restart step 1.
"""

import re
import sys
import time
import threading
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pyte
from winpty import PtyProcess

ROWS, COLS = 40, 140
THRESHOLD = 95.0
POLL_SECONDS = 60
BUFFER = timedelta(minutes=5)


def get_usage():
    """Run `claude /usage` and return (percent, reset_datetime) or None."""
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)
    lock = threading.Lock()
    proc = PtyProcess.spawn("claude /usage", dimensions=(ROWS, COLS))

    def read_output():
        while proc.isalive():
            try:
                data = proc.read(4096)
                if not data:
                    break
                with lock:
                    stream.feed(data)
            except Exception:
                break

    threading.Thread(target=read_output, daemon=True).start()

    try:
        for _ in range(200):
            time.sleep(0.05)
            with lock:
                output = "\n".join(screen.display)

            usage = re.search(r"(\d{1,3}(?:\.\d+)?)%\s*used", output, re.IGNORECASE)
            reset = re.search(
                r"Resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)(?:\s*\(([^)]+)\))?",
                output,
                re.IGNORECASE,
            )
            if usage and reset:
                hour = int(reset.group(1)) % 12
                if reset.group(3).lower() == "pm":
                    hour += 12
                minute = int(reset.group(2) or 0)
                tz = ZoneInfo(reset.group(4) or "Europe/Berlin")
                now = datetime.now(tz)
                reset_time = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
                if reset_time <= now:
                    reset_time += timedelta(days=1)
                return float(usage.group(1)), reset_time
        return None
    finally:
        try:
            proc.terminate(force=True)
        except Exception:
            pass


def sleep_until(target):
    while True:
        remaining = (target - datetime.now(target.tzinfo)).total_seconds()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 30))


def main():
    args = sys.argv[1:]

    if args and args[0] == "--wait-until":
        sleep_until(datetime.fromisoformat(args[1]))
        print("RESUME limit has reset, continue working.", flush=True)
        return

    threshold = float(args[0]) if args else THRESHOLD
    while True:
        result = get_usage()
        if result and result[0] >= threshold:
            pct, reset_time = result
            resume = reset_time + BUFFER
            print(
                f"STOP usage={pct}% resets_at={reset_time.isoformat()} "
                f"resume_at={resume.isoformat()}",
                flush=True,
            )
            return
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
