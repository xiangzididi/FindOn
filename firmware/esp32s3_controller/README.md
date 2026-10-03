# ESP32-S3 最终控制固件

这是 PartGo 本地后端配套的 USB JSONL 控制器。它与 `esp32s3_axis_test` 分开保存：测试固件用于标定，控制固件只执行有限的业务任务。

当前源码故意处于 `CONFIG_LOCKED`：

- X 轴已测得 `20000 pulse/mm`；
- E 轴 `pulse/mm` 尚未标定；
- `S01`、`S02` 的 X 坐标尚未测量；
- 没有限位开关和 Y 轴。

在 `src/main.cpp` 的“待标定配置”区填写 E 轴比例、E 对接行程以及两个格口 X 坐标后，固件才接受 `REFERENCE/FETCH/RETURN`。上电不会运动，人工确认原点前也不会运动。

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
& $pio run -d .\firmware\esp32s3_controller
& $pio run -d .\firmware\esp32s3_controller -t upload --upload-port COM12
```

完整消息格式见 `docs/serial-protocol-v1.md`。

