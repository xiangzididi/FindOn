#!/usr/bin/env python3
"""Local calibration console for guarded manual control on ESP32-S3 firmware."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = ROOT / "calibration"
CONFIG_PATH = ROOT / "config" / "motion-calibration.json"
HEADER_PATH = ROOT / "firmware" / "esp32s3_controller" / "src" / "machine_calibration.h"
X_SCALE = 20_000
X_SAFE_MIN_MM = 0.0
X_SAFE_MAX_MM = 250.0
STOP_RE = re.compile(r"STOP reason=([^ ]+) emitted_pulses=(\d+)")
REJECT_RE = re.compile(r"^REJECT ([A-Z0-9_]+)$")


def calculate_scale(pulses: int, measured_mm: float) -> int:
    if not isinstance(pulses, int) or pulses <= 0:
        raise ValueError("脉冲数必须大于 0")
    if not math.isfinite(measured_mm) or measured_mm <= 0:
        raise ValueError("实测距离必须大于 0")
    scale = round(pulses / measured_mm)
    if scale < 1 or scale > 2_000_000:
        raise ValueError("计算结果超出 1–2000000 pulse/mm")
    return scale


def validate_motion(axis: str, value: float) -> tuple[str, int]:
    if not math.isfinite(value) or value == 0:
        raise ValueError("运动量不能为 0")
    if axis == "X":
        if abs(value) < 1 or abs(value) > 20:
            raise ValueError("X 单次范围为 ±1–20 mm")
        return f"TRAVEL X {value:g}", round(abs(value) * X_SCALE)
    if axis == "E":
        if value != int(value) or abs(value) < 1 or abs(value) > 100:
            raise ValueError("E 单次范围为 ±1–100 个全步脉冲")
        return f"PULSE E {int(value)}", abs(int(value))
    raise ValueError("未知轴")


def validate_calibration(data: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    x = data.get("x", {})
    e = data.get("e", {})
    slots = data.get("slots", {})
    if not isinstance(x.get("pulses_per_mm"), int) or x["pulses_per_mm"] <= 0:
        missing.append("X pulse/mm")
    if x.get("dir_high_motion") not in ("RIGHT", "LEFT"):
        missing.append("X DIR 高电平方向")
    hook_shift = x.get("hook_shift_mm")
    if not isinstance(hook_shift, (int, float)) or not math.isfinite(hook_shift) or hook_shift <= 0 or hook_shift > 20:
        missing.append("X 取盒横移（0–20 mm）")
    if not isinstance(e.get("pulses_per_mm"), int) or e["pulses_per_mm"] <= 0:
        missing.append("E pulse/mm")
    if not isinstance(e.get("scale_divisor"), int) or not 1 <= e["scale_divisor"] <= 1000:
        missing.append("E 比例除数")
    if e.get("driver_microsteps") not in (1, 2, 4, 8, 16):
        missing.append("E 当前细分")
    if e.get("dir_high_motion") not in ("EXTEND", "RETRACT"):
        missing.append("E DIR 高电平方向")
    dock = e.get("dock_mm")
    if not isinstance(dock, (int, float)) or not math.isfinite(dock) or dock <= 0 or dock > 50:
        missing.append("E 对接行程（0–50 mm）")
    valid_hook_shift = (
        isinstance(hook_shift, (int, float))
        and math.isfinite(hook_shift)
        and 0 < hook_shift <= 20
    )
    for slot in ("S01", "S02"):
        value = slots.get(slot, {}).get("x_mm")
        valid_slot = (
            isinstance(value, (int, float))
            and math.isfinite(value)
            and X_SAFE_MIN_MM <= value <= X_SAFE_MAX_MM
        )
        if not valid_slot:
            missing.append(f"{slot} X 坐标（0–250 mm）")
        elif valid_hook_shift and value + hook_shift > X_SAFE_MAX_MM:
            missing.append(f"{slot} 挂钩终点超出 X 安全范围（≤250 mm）")
    s1 = slots.get("S01", {}).get("x_mm")
    s2 = slots.get("S02", {}).get("x_mm")
    if isinstance(s1, (int, float)) and isinstance(s2, (int, float)) and s1 == s2:
        missing.append("S01/S02 坐标必须不同")
    return missing


def millimeters_to_micrometers(value: float) -> int:
    """Use the same positive half-up conversion as the Node.js runtime."""
    return int(math.floor(float(value) * 1000 + 0.5))


def calibration_fingerprint(data: dict[str, Any]) -> str:
    missing = validate_calibration(data)
    if missing:
        raise ValueError("标定未完成：" + "、".join(missing))
    x = data["x"]
    e = data["e"]
    slots = data["slots"]
    motion = {
        "schema": 1,
        "x_pulses_per_mm": x["pulses_per_mm"],
        "x_dir_high_motion": x["dir_high_motion"],
        "x_hook_shift_um": millimeters_to_micrometers(x["hook_shift_mm"]),
        "e_scale_numerator": e["pulses_per_mm"],
        "e_scale_divisor": e["scale_divisor"],
        "e_driver_microsteps": e["driver_microsteps"],
        "e_dir_high_motion": e["dir_high_motion"],
        "e_dock_um": millimeters_to_micrometers(e["dock_mm"]),
        "s01_x_um": millimeters_to_micrometers(slots["S01"]["x_mm"]),
        "s02_x_um": millimeters_to_micrometers(slots["S02"]["x_mm"]),
    }
    canonical = json.dumps(motion, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(canonical.encode("ascii")).hexdigest()


def render_header(data: dict[str, Any]) -> str:
    missing = validate_calibration(data)
    if missing:
        raise ValueError("标定未完成：" + "、".join(missing))
    x = data["x"]
    e = data["e"]
    slots = data["slots"]
    fingerprint = calibration_fingerprint(data)
    return f"""#pragma once

#include <stdint.h>

// Generated by the PartGo calibration console. Do not edit by hand.
constexpr char CALIBRATION_ID[] = "{fingerprint}";
constexpr uint32_t X_PULSES_PER_MM = {x['pulses_per_mm']};
constexpr uint32_t E_PULSES_PER_MM = {e['pulses_per_mm']};
constexpr uint32_t E_SCALE_DIVISOR = {e['scale_divisor']};
constexpr int32_t E_DOCK_UM = {millimeters_to_micrometers(e['dock_mm'])};
constexpr int32_t X_HOOK_SHIFT_UM = {millimeters_to_micrometers(x['hook_shift_mm'])};
constexpr int32_t S01_X_UM = {millimeters_to_micrometers(slots['S01']['x_mm'])};
constexpr int32_t S02_X_UM = {millimeters_to_micrometers(slots['S02']['x_mm'])};

// Logical positive X is right; logical positive E is extension toward a box.
constexpr bool X_DIR_HIGH_MOVES_RIGHT = {'true' if x['dir_high_motion'] == 'RIGHT' else 'false'};
constexpr bool E_DIR_HIGH_EXTENDS = {'true' if e['dir_high_motion'] == 'EXTEND' else 'false'};
"""


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8", newline="\n")
    os.replace(temporary, path)


class CalibrationService:
    def __init__(self, port: str, baud: int, simulate: bool = False):
        self.port = port
        self.baud = baud
        self.simulate = simulate
        self.token = secrets.token_urlsafe(24)
        self.lock = threading.RLock()
        self.logs: deque[dict[str, Any]] = deque(maxlen=250)
        self.serial = None
        self.connected = simulate
        self.error = None
        self.running = True
        self.moving = False
        self.last_move: dict[str, Any] | None = None
        self.calibration = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        self._log("SYSTEM", "模拟串口已就绪" if simulate else f"等待连接 {port} @ {baud}")
        if not simulate:
            threading.Thread(target=self._serial_loop, daemon=True).start()

    def _log(self, source: str, line: str) -> None:
        with self.lock:
            self.logs.append({"time": datetime.now().astimezone().strftime("%H:%M:%S"), "source": source, "line": line})

    def _serial_loop(self) -> None:
        try:
            import serial  # type: ignore
        except ImportError:
            self.error = "未安装 pyserial，请运行 pip install -r requirements.txt"
            self._log("ERROR", self.error)
            return
        while self.running:
            if self.serial is None:
                try:
                    self.serial = serial.Serial(self.port, self.baud, timeout=0.2, write_timeout=1)
                    # Opening the ESP32-S3 USB serial port can reset the board.
                    # Wait for setup() before sending the first command and drop
                    # boot fragments so STATUS is not parsed as a partial line.
                    time.sleep(1.2)
                    self.serial.reset_input_buffer()
                    self.connected = True
                    self.error = None
                    self._log("SYSTEM", f"已连接 {self.port}")
                    self._write("STATUS")
                except Exception as exc:
                    self.connected = False
                    self.error = str(exc)
                    time.sleep(1.5)
                    continue
            try:
                raw = self.serial.readline()
                if raw:
                    self._handle_line(raw.decode("utf-8", errors="replace").strip())
            except Exception as exc:
                self._log("ERROR", f"串口断开：{exc}")
                try:
                    self.serial.close()
                except Exception:
                    pass
                self.serial = None
                self.connected = False
                self.error = str(exc)

    def _write(self, command: str) -> None:
        self._log("TX", command)
        if self.simulate:
            return
        if not self.serial or not self.connected:
            raise RuntimeError("测试控制器尚未连接")
        self.serial.write((command + "\n").encode("ascii"))
        self.serial.flush()

    def _handle_line(self, line: str) -> None:
        if not line:
            return
        self._log("RX", line)
        rejection = REJECT_RE.match(line)
        if rejection:
            with self.lock:
                self.moving = False
                if self.last_move and not self.last_move.get("complete"):
                    self.last_move["emitted_pulses"] = 0
                    self.last_move["stop_reason"] = "CONTROLLER_REJECTED"
                    self.last_move["error"] = rejection.group(1)
                    self.last_move["complete"] = True
            return
        match = STOP_RE.search(line)
        if match:
            with self.lock:
                self.moving = False
                if self.last_move:
                    self.last_move["emitted_pulses"] = int(match.group(2))
                    self.last_move["stop_reason"] = match.group(1)
                    self.last_move["complete"] = True

    def state(self) -> dict[str, Any]:
        with self.lock:
            missing = validate_calibration(self.calibration)
            preview = None
            if not missing:
                preview = render_header(self.calibration)
            return {
                "token": self.token,
                "mode": "simulation" if self.simulate else "hardware",
                "device": {"port": self.port, "baud": self.baud, "connected": self.connected, "error": self.error},
                "moving": self.moving,
                "last_move": self.last_move,
                "calibration": self.calibration,
                "missing": missing,
                "header_preview": preview,
                "logs": list(self.logs),
            }

    def action(self, body: dict[str, Any]) -> None:
        action = body.get("action")
        if action == "STATUS":
            self._write("STATUS")
            if self.simulate:
                self._handle_line("GEWU-AXIS-TEST-3.0-X-TRAVEL-20MM mode=BENCH Escale=UNCALIBRATED")
            return
        if action == "STOP":
            if self.simulate:
                self._handle_line("STOP reason=HOST_STOP emitted_pulses=0 position=UNREFERENCED")
            else:
                if not self.serial or not self.connected:
                    raise RuntimeError("测试控制器尚未连接")
                self.serial.write(b"!")
                self.serial.flush()
                self._log("TX", "! 立即停止")
            return
        if action not in ("X_TRAVEL", "E_PULSE"):
            raise ValueError("未知操作")
        if body.get("confirmed") is not True:
            raise ValueError("必须确认运动方向、距离和机械余量")
        axis = "X" if action == "X_TRAVEL" else "E"
        value = float(body.get("value"))
        command, pulses = validate_motion(axis, value)
        with self.lock:
            if self.moving:
                raise RuntimeError("上一个动作尚未结束")
            self.last_move = {
                "axis": axis,
                "command": command,
                "requested_value": value,
                "planned_pulses": pulses,
                "complete": False,
                "emitted_pulses": None,
            }
            self.moving = True
        try:
            self._write(f"ARM {axis} CLEAR")
            self._write(command)
        except Exception:
            with self.lock:
                self.moving = False
            raise
        if self.simulate:
            self._handle_line(f"START {axis} simulated pulses={pulses}")
            self._handle_line(f"STOP reason=PULSE_SEQUENCE_DONE_NOT_POSITION_FEEDBACK emitted_pulses={pulses} position=UNREFERENCED")

    def measurement(self, body: dict[str, Any]) -> int:
        measured_mm = float(body.get("measured_mm"))
        with self.lock:
            move = self.last_move
            if not move or not move.get("complete"):
                raise ValueError("请先完成一次有限运动")
            pulses = move.get("emitted_pulses")
            if not isinstance(pulses, int) or pulses <= 0:
                raise ValueError("控制器未报告有效脉冲数")
            axis = str(move["axis"]).upper()
            if axis == "E":
                e = self.calibration["e"]
                pulses = round(pulses * e["scale_divisor"])
            scale = calculate_scale(pulses, measured_mm)
            axis_key = axis.lower()
            self.calibration[axis_key]["pulses_per_mm"] = scale
            self.calibration[axis_key]["calibrated"] = True
            move["measured_mm"] = measured_mm
            effective_scale = scale / self.calibration[axis_key].get("scale_divisor", 1)
            move["calculated_scale"] = effective_scale
            return effective_scale

    def geometry(self, body: dict[str, Any]) -> None:
        def number(name: str, minimum: float, maximum: float) -> float:
            value = float(body.get(name))
            if not math.isfinite(value) or value < minimum or value > maximum:
                raise ValueError(f"{name} 超出范围 {minimum}–{maximum}")
            return value
        x_direction = body.get("x_dir_high_motion")
        e_direction = body.get("e_dir_high_motion")
        if x_direction not in ("RIGHT", "LEFT") or e_direction not in ("EXTEND", "RETRACT"):
            raise ValueError("方向配置无效")
        with self.lock:
            self.calibration["x"]["dir_high_motion"] = x_direction
            self.calibration["x"]["hook_shift_mm"] = number("x_hook_shift_mm", 0.001, 20)
            self.calibration["e"]["dir_high_motion"] = e_direction
            self.calibration["e"]["dock_mm"] = number("e_dock_mm", 0.001, 50)
            self.calibration["slots"]["S01"]["x_mm"] = number("s01_x_mm", 0, 250)
            self.calibration["slots"]["S02"]["x_mm"] = number("s02_x_mm", 0, 250)

    def apply(self) -> None:
        if self.simulate:
            raise RuntimeError("模拟模式禁止写入正式标定配置和固件头文件")
        with self.lock:
            missing = validate_calibration(self.calibration)
            if missing:
                raise ValueError("标定未完成：" + "、".join(missing))
            self.calibration["updated_at"] = datetime.now(timezone.utc).isoformat()
            self.calibration["calibration_id"] = calibration_fingerprint(self.calibration)
            header = render_header(self.calibration)
            config = json.dumps(self.calibration, ensure_ascii=False, indent=2) + "\n"
            atomic_write(CONFIG_PATH, config)
            atomic_write(HEADER_PATH, header)
            self._log("SYSTEM", "标定结果已写入配置和最终固件头文件")


class CalibrationHandler(SimpleHTTPRequestHandler):
    service: CalibrationService

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _local_request(self) -> bool:
        host = self.headers.get("Host", "").split(":", 1)[0].strip("[]").lower()
        return self.client_address[0] in ("127.0.0.1", "::1") and host in ("127.0.0.1", "localhost")

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if not self._local_request():
            self._json(HTTPStatus.FORBIDDEN, {"error": "仅允许本机访问"})
            return
        if urlparse(self.path).path == "/api/state":
            self._json(HTTPStatus.OK, self.service.state())
            return
        super().do_GET()

    def do_POST(self) -> None:
        if not self._local_request():
            self._json(HTTPStatus.FORBIDDEN, {"error": "仅允许本机访问"})
            return
        if not secrets.compare_digest(self.headers.get("X-Calibration-Token", ""), self.service.token):
            self._json(HTTPStatus.FORBIDDEN, {"error": "请求令牌无效，请刷新页面"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 16_384:
                raise ValueError("请求过大")
            body = json.loads(self.rfile.read(length) or b"{}")
            path = urlparse(self.path).path
            result: dict[str, Any] = {"ok": True}
            if path == "/api/action":
                self.service.action(body)
            elif path == "/api/measurement":
                result["pulses_per_mm"] = self.service.measurement(body)
            elif path == "/api/geometry":
                self.service.geometry(body)
            elif path == "/api/apply":
                self.service.apply()
            else:
                self._json(HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
                return
            result["state"] = self.service.state()
            self._json(HTTPStatus.OK, result)
        except (ValueError, TypeError, RuntimeError, json.JSONDecodeError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc), "state": self.service.state()})


def main() -> None:
    parser = argparse.ArgumentParser(description="PartGo 本地标定台")
    parser.add_argument("--serial-port", default="COM9")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--http-port", type=int, default=3212)
    parser.add_argument("--simulate", action="store_true", help="不打开串口，仅用于界面验证")
    args = parser.parse_args()
    service = CalibrationService(args.serial_port, args.baud, args.simulate)
    CalibrationHandler.service = service
    server = ThreadingHTTPServer(("127.0.0.1", args.http_port), CalibrationHandler)
    print(f"PartGo calibration console: http://127.0.0.1:{args.http_port}")
    print(f"Mode: {'SIMULATION' if args.simulate else args.serial_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.running = False
        server.server_close()


if __name__ == "__main__":
    main()
