"""Raw stdin/stdout bridge for a USB serial port.

stdout is reserved for bytes received from the controller. Lifecycle messages go
to stderr so the Node JSONL parser never sees bridge diagnostics.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from typing import BinaryIO, TextIO

import serial

TX_CHUNK_BYTES = 64
TX_INTER_CHUNK_SECONDS = 0.005


def run_bridge(
    device: serial.Serial,
    source: BinaryIO,
    sink: BinaryIO,
    diagnostics: TextIO,
    ready_message: str,
) -> int:
    """Forward bytes until stdin closes or either serial direction fails.

    stdin is read on a daemon thread because a pipe read cannot be interrupted
    reliably on Windows.  Keeping the coordinator on the main thread lets a
    serial read failure end the process immediately instead of waiting for the
    parent process to write again or close stdin.
    """

    stopped = threading.Event()
    failed = threading.Event()

    def report_failure(prefix: str, error: Exception) -> None:
        # The other worker can fail as a consequence of an intentional close;
        # only the first, initiating failure should become the diagnostic.
        if stopped.is_set():
            return
        failed.set()
        print(f"{prefix} {error}", file=diagnostics, flush=True)

    def receive() -> None:
        try:
            while not stopped.is_set():
                data = device.read(max(1, device.in_waiting))
                if data:
                    sink.write(data)
                    sink.flush()
        except Exception as error:  # surfaced to Node via stderr + exit code
            report_failure("PARTGO_BRIDGE_READ_ERROR", error)
        finally:
            stopped.set()

    def transmit() -> None:
        try:
            while not stopped.is_set():
                data = source.read1(1024) if hasattr(source, "read1") else source.read(1024)
                if not data:
                    break
                # ESP32-S3 USB CDC can drop the tail of a long host burst even
                # though the firmware line buffer is large enough.  Pace writes
                # into endpoint-sized chunks so business JSON remains intact.
                for offset in range(0, len(data), TX_CHUNK_BYTES):
                    if stopped.is_set():
                        break
                    device.write(data[offset : offset + TX_CHUNK_BYTES])
                    device.flush()
                    if offset + TX_CHUNK_BYTES < len(data):
                        time.sleep(TX_INTER_CHUNK_SECONDS)
        except (BrokenPipeError, OSError, serial.SerialException) as error:
            report_failure("PARTGO_BRIDGE_WRITE_ERROR", error)
        finally:
            stopped.set()

    reader = threading.Thread(target=receive, name="partgo-serial-reader", daemon=True)
    writer = threading.Thread(target=transmit, name="partgo-stdin-reader", daemon=True)
    reader.start()
    print(ready_message, file=diagnostics, flush=True)
    writer.start()

    stopped.wait()
    if device.is_open:
        device.close()

    # The serial timeout keeps the receiver bounded.  The stdin worker is
    # deliberately not joined: on Windows it may remain blocked in ReadFile,
    # but as a daemon it cannot hold the bridge process open.
    reader.join(timeout=0.5)
    return 1 if failed.is_set() else 0


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

    try:
        return run_bridge(
            device,
            sys.stdin.buffer,
            sys.stdout.buffer,
            sys.stderr,
            f"PARTGO_BRIDGE_READY {args.port} {args.baud}",
        )
    finally:
        if device.is_open:
            device.close()


if __name__ == "__main__":
    raise SystemExit(main())

