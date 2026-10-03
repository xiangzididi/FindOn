import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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
        self.assertEqual(calibration.validate_motion("E", 100), ("PULSE E 100", 100))
        for axis, value in (("X", 0.5), ("X", 21), ("E", 0), ("E", 101), ("E", 20.5)):
            with self.subTest(axis=axis, value=value):
                with self.assertRaises(ValueError):
                    calibration.validate_motion(axis, value)

    def test_controller_rejection_clears_pending_motion(self):
        service = calibration.CalibrationService("SIMULATED", 115200, simulate=True)
        service.moving = True
        service.last_move = {
            "axis": "X",
            "command": "TRAVEL X -5",
            "planned_pulses": 100000,
            "complete": False,
            "emitted_pulses": None,
        }

        service._handle_line("REJECT BOX_PRESENTED_MANUAL_DISABLED")

        self.assertFalse(service.moving)
        self.assertTrue(service.last_move["complete"])
        self.assertEqual(service.last_move["emitted_pulses"], 0)
        self.assertEqual(service.last_move["stop_reason"], "CONTROLLER_REJECTED")
        self.assertEqual(service.last_move["error"], "BOX_PRESENTED_MANUAL_DISABLED")


class CalibrationOutputTests(unittest.TestCase):
    def complete_config(self):
        return {
            "version": 1,
            "updated_at": None,
            "x": {"pulses_per_mm": 20000, "calibrated": True, "dir_high_motion": "RIGHT", "hook_shift_mm": 4.5},
            "e": {"pulses_per_mm": 71, "scale_divisor": 4, "driver_microsteps": 1,
                  "calibrated": True, "dir_high_motion": "RETRACT", "dock_mm": 18.25},
            "slots": {"S01": {"x_mm": 42.5}, "S02": {"x_mm": 112.75}},
        }

    def test_complete_config_unlocks_and_missing_slot_locks(self):
        raw = json.loads(calibration.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(calibration.validate_calibration(raw), [])
        self.assertEqual(raw["calibration_id"], calibration.calibration_fingerprint(raw))
        self.assertEqual(raw["x"]["pulses_per_mm"], 20000)
        self.assertEqual(raw["e"]["pulses_per_mm"], 250)
        self.assertEqual(raw["e"]["scale_divisor"], 49)
        self.assertEqual(raw["e"]["dock_mm"], 48.0)
        self.assertEqual(raw["x"]["hook_shift_mm"], 5.2)
        self.assertEqual(raw["slots"]["S01"]["x_mm"], 29.8)
        self.assertEqual(raw["slots"]["S02"]["x_mm"], 105.0)
        self.assertIn("S01_X_UM = 29800", calibration.render_header(raw))
        self.assertIn("S02_X_UM = 105000", calibration.render_header(raw))
        self.assertIn("X_HOOK_SHIFT_UM = 5200", calibration.render_header(raw))
        self.assertIn(raw["calibration_id"], calibration.render_header(raw))
        generated_header = calibration.HEADER_PATH.read_text(encoding="utf-8")
        self.assertIn(raw["calibration_id"], generated_header)
        self.assertIn("S01_X_UM = 29800", generated_header)
        self.assertIn("S02_X_UM = 105000", generated_header)
        self.assertIn("X_HOOK_SHIFT_UM = 5200", generated_header)
        cabinet = json.loads(
            (calibration.ROOT / "config" / "cabinet.json").read_text(encoding="utf-8")
        )
        enabled_slots = {slot["id"]: slot for slot in cabinet["slots"] if slot.get("enabled")}
        self.assertEqual(enabled_slots["S01"]["x_mm"], raw["slots"]["S01"]["x_mm"])
        self.assertEqual(enabled_slots["S02"]["x_mm"], raw["slots"]["S02"]["x_mm"])
        raw["slots"]["S01"]["x_mm"] = None
        self.assertIn("S01 X 坐标（0–250 mm）", calibration.validate_calibration(raw))
        with self.assertRaises(ValueError):
            calibration.render_header(raw)

    def test_slot_and_hook_endpoint_must_stay_inside_x_safe_range(self):
        raw = self.complete_config()
        raw["slots"]["S02"]["x_mm"] = 246
        self.assertIn(
            "S02 挂钩终点超出 X 安全范围（≤250 mm）",
            calibration.validate_calibration(raw),
        )
        with self.assertRaises(ValueError):
            calibration.render_header(raw)

        raw["slots"]["S02"]["x_mm"] = 245.5
        self.assertEqual(calibration.validate_calibration(raw), [])

    def test_validation_does_not_assume_a_fixed_e_dock_pulse_count(self):
        raw = self.complete_config()
        raw["e"]["pulses_per_mm"] = 250
        raw["e"]["scale_divisor"] = 49
        raw["e"]["dock_mm"] = 47.5
        self.assertEqual(calibration.validate_calibration(raw), [])
        self.assertIn("E_DOCK_UM = 47500", calibration.render_header(raw))

    def test_header_contains_scaled_integer_coordinates_and_direction(self):
        header = calibration.render_header(self.complete_config())
        self.assertIn("E_PULSES_PER_MM = 71", header)
        self.assertIn("E_SCALE_DIVISOR = 4", header)
        self.assertIn("E_DOCK_UM = 18250", header)
        self.assertIn("X_HOOK_SHIFT_UM = 4500", header)
        self.assertIn("S02_X_UM = 112750", header)
        self.assertIn("E_DIR_HIGH_EXTENDS = false", header)

    def test_calibration_fingerprint_changes_with_motion_geometry(self):
        first = self.complete_config()
        second = self.complete_config()
        second["slots"]["S02"]["x_mm"] += 0.5
        self.assertRegex(calibration.calibration_fingerprint(first), r"^sha256:[0-9a-f]{64}$")
        self.assertNotEqual(
            calibration.calibration_fingerprint(first),
            calibration.calibration_fingerprint(second),
        )

    def test_atomic_write_replaces_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "output.txt"
            calibration.atomic_write(target, "complete\n")
            self.assertEqual(target.read_text(encoding="utf-8"), "complete\n")
            self.assertFalse(target.with_suffix(".txt.tmp").exists())

    def test_simulation_mode_cannot_write_production_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "motion-calibration.json"
            header_path = Path(directory) / "machine_calibration.h"
            original_config = json.dumps(self.complete_config(), ensure_ascii=False, indent=2) + "\n"
            config_path.write_text(original_config, encoding="utf-8")
            header_path.write_text("// existing production header\n", encoding="utf-8")

            with (
                mock.patch.object(calibration, "CONFIG_PATH", config_path),
                mock.patch.object(calibration, "HEADER_PATH", header_path),
            ):
                service = calibration.CalibrationService("SIMULATED", 115200, simulate=True)
                service.calibration["slots"]["S01"]["x_mm"] = 50
                with self.assertRaisesRegex(RuntimeError, "模拟模式禁止写入"):
                    service.apply()

            self.assertEqual(config_path.read_text(encoding="utf-8"), original_config)
            self.assertEqual(
                header_path.read_text(encoding="utf-8"),
                "// existing production header\n",
            )


if __name__ == "__main__":
    unittest.main()
