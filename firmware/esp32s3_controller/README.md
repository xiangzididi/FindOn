# ESP32-S3 最终控制固件

这是 PartGo 本地后端配套的 USB JSONL 控制器。它与 `esp32s3_axis_test` 分开保存：测试固件用于标定，控制固件只执行有限的业务任务。

当前机械配置已经完整：

- X 轴已测得 `20000 pulse/mm`；
- E 轴已测得 `21 pulse/mm`；
- E 对接行程为 `48 mm`，取盒时 X 向右横移 `4.5 mm` 挂住盒子；
- `S01`、`S02` 的 X 坐标分别为 `30.5 mm`、`104.5 mm`；
- 没有限位开关和 Y 轴。

本地标定台已经生成 `src/machine_calibration.h`。取件顺序为“到格口、E 伸出、X 右移挂钩、E 回缩、回取物区”，回件执行逆序释放动作。上电状态为 `UNREFERENCED`，不会自动运动；人工确认原点后才接受 `FETCH/RETURN`。

最终固件同时兼容本地标定台的受限人工控制：先发送 `ARM X/E CLEAR`，再执行一次 `TRAVEL X ±1–20 mm` 或 `PULSE E ±16–320`。授权 10 秒失效且只能使用一次；人工移动会清除原点状态，之后必须重新执行人工 `REFERENCE`。存在正在取还件的任务或有盒子停在取物区时，人工移动会被拒绝。

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
& $pio run -d .\firmware\esp32s3_controller
& $pio run -d .\firmware\esp32s3_controller -t upload --upload-port COM12
```

完整消息格式见 `docs/serial-protocol-v1.md`。

