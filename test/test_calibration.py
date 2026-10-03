import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "calibration_server.py"
SPEC = importlib.util.spec_from_file_location("calibration_server", MODULE_PATH)
calibration = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = calibration
SPEC.loader.exec_module(calibration)


class CalibrationMathTests(unittest.TestCase):
    def test_scale_uses_emitted_pulses_and_measured_distance(self):
        self.assertEqual(calibration.calculate_scale(320, 4.5), 71)
        self.assertEqual(calibration.calculate_scale(400000, 20), 20000)

    def test_scale_rejects_unsafe_values(self):
        for pulses, distance in ((0, 1), (100, 0), (100, -1), (3_000_000, 1)):
            with self.subTest(pulses=pulses, distance=distance):
                with self.assertRaises(ValueError):
                    calibration.calculate_scale(pulses, distance)

    def test_motion_limits_match_bench_firmware(self):
        self.assertEqual(calibration.validate_motion("X", -5), ("TRAVEL X -5", 100000))
        self.assertEqual(calibration.validate_motion("E", 320), ("PULSE E 320", 320))
        for axis, value in (("X", 0.5), ("X", 21), ("E", 15), ("E", 321), ("E", 20.5)):
            with self.subTest(axis=axis, value=value):
                with self.assertRaises(ValueError):
                    calibration.validate_motion(axis, value)


class CalibrationOutputTests(unittest.TestCase):
    def complete_config(self):
        return {
            "version": 1,
            "updated_at": None,
            "x": {"pulses_per_mm": 20000, "calibrated": True, "dir_high_motion": "RIGHT", "hook_shift_mm": 4.5},
            "e": {"pulses_per_mm": 71, "calibrated": True, "dir_high_motion": "RETRACT", "dock_mm": 18.25},
            "slots": {"S01": {"x_mm": 42.5}, "S02": {"x_mm": 112.75}},
        }

    def test_complete_config_unlocks_and_missing_slot_locks(self):
        raw = json.loads(calibration.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(calibration.validate_calibration(raw), [])
        self.assertIn("S01_X_UM = 32000", calibration.render_header(raw))
        raw["slots"]["S01"]["x_mm"] = None
        self.assertIn("S01 X 坐标（0–250 mm）", calibration.validate_calibration(raw))
        with self.assertRaises(ValueError):
            calibration.render_header(raw)

    def test_header_contains_scaled_integer_coordinates_and_direction(self):
        header = calibration.render_header(self.complete_config())
        self.assertIn("E_PULSES_PER_MM = 71", header)
        self.assertIn("E_DOCK_UM = 18250", header)
        self.assertIn("X_HOOK_SHIFT_UM = 4500", header)
        self.assertIn("S02_X_UM = 112750", header)
        self.assertIn("E_DIR_HIGH_EXTENDS = false", header)

    def test_atomic_write_replaces_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "output.txt"
            calibration.atomic_write(target, "complete\n")
            self.assertEqual(target.read_text(encoding="utf-8"), "complete\n")
            self.assertFalse(target.with_suffix(".txt.tmp").exists())


if __name__ == "__main__":
    unittest.main()
