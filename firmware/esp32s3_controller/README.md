# ESP32-S3 最终控制固件

这是 PartGo 本地后端配套的 USB JSONL 控制器。它与 `esp32s3_axis_test` 分开保存：测试固件用于标定，控制固件只执行有限的业务任务。

当前机械配置已经完整：

- X 轴已测得 `20000 pulse/mm`；
- A4988 的 MS1/MS2/MS3 均接地，E 轴处于全步模式；带载实测100脉冲移动19.6mm，比例为 `250/49 pulse/mm`（约 `5.1020 pulse/mm`）；
- E 轴真实可用行程为 `51 mm`，对接命令取 `48 mm`，保留约 `3 mm` 机械余量；
- `S01`、`S02` 的格口对位坐标分别为 `29.8 mm`、`105 mm`，挂取时再向右横移 `5.2 mm`；
- 没有限位开关和 Y 轴。

本地标定台已经生成 `src/machine_calibration.h`。取件顺序为“到格口、E 伸出、X 右移挂钩、E 回缩、回取物区”，回件执行逆序释放动作。上电状态为 `UNREFERENCED`，不会自动运动；把 X 放在最左侧取物处、E 完全回缩并人工确认原点后才接受 `FETCH/RETURN`。

E轴由独立的 `e_axis.cpp/.h` 控制器管理，不再复用X轴运动结构。控制器单独维护A4988的STEP/DIR/EN时序、按比例换算得到的245脉冲对接行程、方向、超时和位置可信状态；伸出后保持使能，完成挂钩或脱钩横移后再执行负方向回缩并释放使能。

业务协议当前为配置版本 `6`。主机和控制器必须持有同一标定指纹；任务期间还必须维持同一主机会话的心跳租约，连续2秒失联会关断运动输出并报错。`RECOVER` 只清除逻辑状态，不产生电机脉冲，且要求操作员确认所有盒子都在柜内、运动区域已清空。当前没有实体急停，实机运行时必须有人能直接切断12V电机电源。

最终固件同时兼容本地标定台的受限人工控制：先发送 `ARM X/E CLEAR`，再执行一次 `TRAVEL X ±1–20 mm` 或 `PULSE E ±1–100`。授权 10 秒失效且只能使用一次；人工移动会清除原点状态，之后必须重新执行人工 `REFERENCE`。存在正在取还件的任务或有盒子停在取物区时，人工移动会被拒绝。

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
& $pio run -d .\firmware\esp32s3_controller
& $pio run -d .\firmware\esp32s3_controller -t upload --upload-port COM9
```

完整消息格式见 `docs/serial-protocol-v1.md`。

