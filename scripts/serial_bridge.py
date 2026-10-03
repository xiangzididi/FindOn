"""Raw stdin/stdout bridge for a USB serial port.

stdout is reserved for bytes received from the controller. Lifecycle messages go
to stderr so the Node JSONL parser never sees bridge diagnostics.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time

import serial


def main() -> int:
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    args = parser.parse_args()

    device = serial.Serial()
    device.port = args.port
    device.baudrate = args.baud
    device.timeout = 0.1
    device.write_timeout = 1
    device.dtr = False
    device.rts = False
    device.open()

    stopped = threading.Event()

    def receive() -> None:
        try:
            while not stopped.is_set():
                data = device.read(max(1, device.in_waiting))
                if data:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
        except Exception as error:  # surfaced to Node via process exit
            print(f"PARTGO_BRIDGE_READ_ERROR {error}", file=sys.stderr, flush=True)
        finally:
            stopped.set()

    reader = threading.Thread(target=receive, name="partgo-serial-reader", daemon=True)
    reader.start()
    print(f"PARTGO_BRIDGE_READY {args.port} {args.baud}", file=sys.stderr, flush=True)

    try:
        source = sys.stdin.buffer
        while not stopped.is_set():
            data = source.read1(1024) if hasattr(source, "read1") else source.read(1024)
            if not data:
                break
            device.write(data)
            device.flush()
    except (BrokenPipeError, OSError, serial.SerialException) as error:
        print(f"PARTGO_BRIDGE_WRITE_ERROR {error}", file=sys.stderr, flush=True)
    finally:
        stopped.set()
        time.sleep(0.05)
        if device.is_open:
            device.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

