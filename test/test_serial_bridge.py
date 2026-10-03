import importlib.util
import io
import sys
import threading
import time
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "serial_bridge.py"
SPEC = importlib.util.spec_from_file_location("serial_bridge", MODULE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)


class BlockingInput:
    """Model the Node stdin pipe when no command is currently being sent."""

    def __init__(self):
        self.release = threading.Event()

    def read1(self, _size):
        self.release.wait(timeout=5)
        return b""


class DisconnectingDevice:
    def __init__(self):
        self.is_open = True

    @property
    def in_waiting(self):
        return 0

    def read(self, _size):
        raise bridge.serial.SerialException("device disconnected")

    def close(self):
        self.is_open = False


class EchoDevice:
    def __init__(self):
        self.is_open = True
        self.writes = []

    @property
    def in_waiting(self):
        return 0

    def read(self, _size):
        time.sleep(0.01)
        return b""

    def write(self, data):
        self.writes.append(data)

    def flush(self):
        pass

    def close(self):
        self.is_open = False


class SerialBridgeTests(unittest.TestCase):
    def test_serial_disconnect_exits_while_stdin_is_blocked(self):
        source = BlockingInput()
        diagnostics = io.StringIO()
        started = time.monotonic()

        result = bridge.run_bridge(
            DisconnectingDevice(), source, io.BytesIO(), diagnostics, "BRIDGE_READY"
        )
        elapsed = time.monotonic() - started
        source.release.set()

        self.assertEqual(result, 1)
        self.assertLess(elapsed, 0.75)
        self.assertIn("PARTGO_BRIDGE_READ_ERROR device disconnected", diagnostics.getvalue())

    def test_normal_stdin_bytes_are_forwarded_before_eof(self):
        device = EchoDevice()
        diagnostics = io.StringIO()

        result = bridge.run_bridge(
            device, io.BytesIO(b"STATUS\n"), io.BytesIO(), diagnostics, "BRIDGE_READY"
        )

        self.assertEqual(result, 0)
        self.assertEqual(device.writes, [b"STATUS\n"])
        self.assertIn("BRIDGE_READY", diagnostics.getvalue())

    def test_long_json_is_paced_into_usb_endpoint_sized_chunks(self):
        device = EchoDevice()
        payload = b"{" + b'x' * 300 + b"}\n"

        result = bridge.run_bridge(
            device, io.BytesIO(payload), io.BytesIO(), io.StringIO(), "BRIDGE_READY"
        )

        self.assertEqual(result, 0)
        self.assertEqual(b"".join(device.writes), payload)
        self.assertTrue(all(len(chunk) <= bridge.TX_CHUNK_BYTES for chunk in device.writes))
        self.assertGreater(len(device.writes), 1)


if __name__ == "__main__":
    unittest.main()
