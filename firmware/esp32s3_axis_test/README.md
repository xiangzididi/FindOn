# 双轴无开关安全点动固件

这是 ESP32-S3-N16R8 的独立实机测试程序，尚未接入网页取回件流程。当前机构没有 X/E 原点或限位开关，因此固件不支持回零和绝对坐标；上电始终静止，位置始终显示 `UNREFERENCED`。

## 接线和计算

- X：GPIO17 → PD42S1 STP，GPIO18 → DIR。按已有共阳示例，STEP 空闲为高、低脉冲有效。
- E：GPIO15 → A4988 STEP，GPIO16 → DIR，GPIO7 → EN。STEP 高脉冲有效，EN 低有效。
- GPIO4、GPIO5 当前不连接。
- ESP32、PD42S1 信号端和 A4988 必须共地；电机电源与 USB 供电分开。
- 两台电机均为 1.8°、16 细分，丝杆导程均为 2 mm。
- X 带 1:50 减速箱：`200 × 16 × 50 ÷ 2 = 80000 pulse/mm`。
- E 直接驱动：`200 × 16 ÷ 2 = 1600 pulse/mm`。

先核对 PD42S1 面板确实设置为 16 细分。A4988 的 MS1/MS2/MS3 接 3.3 V 才是 16 细分，并按电机额定电流和载板采样电阻设置限流。X EN 未接，停止脉冲后仍可能保持励磁。

## 上电前

电机电源关闭时，将 X 人工移到左侧取物区标记，将 E 人工移到完全回缩且不干涉柜体的位置。确认滑块离两端都有余量。手动移动前必须切断电机电源。

没有开关时，控制器重启、电机掉电、堵转、丢步或人工移动后都会失去参考位置。当前程序不保存坐标，也不把人工位置声明为自动回零。

## 串口测试

打开 USB CDC 串口，115200、换行符 LF。发送：

```text
STATUS
```

应返回 `GEWU-AXIS-TEST-2.0-NO-ENDSTOPS`、`Xgear=50:1`、`Xscale=80000pulse/mm`、`Escale=1600pulse/mm`。

每次点动前检查路径和端部余量，然后单独解锁一个轴：

```text
ARM X CLEAR
JOG X 0.5
```

E 轴示例：

```text
ARM E CLEAR
JOG E -0.5
```

解锁 10 秒后失效，每次解锁只允许一次点动。单次范围为 0.1–1.0 mm。X 以 20000 pulse/s 运行，约 0.25 mm/s；E 以 2000 pulse/s 运行，约 1.25 mm/s。`+` 只表示 DIR 高电平，实际左右/伸缩方向仍需测量。

发送单字符 `!` 可立即请求停止，无需换行；也可发送 `STOP` 加换行。运动中收到其他完整命令也会停止，命令不会排队。超时或 USB 断开会停止脉冲。软件停止不能检测撞端、卡盒或丢步。

固件故意不提供 `HOME`、连续 `SPIN` 或自动 `FETCH`。先分别验证两轴 0.5 mm 的方向和实际位移，再测量 X 取物区、S01、S02、挂钩横移量，以及 E 完全回缩/挂钩深度/完全拉出位置。

## 编译与烧录

在项目根目录运行：

```powershell
& 'C:\Users\XZDD\.platformio\penv\Scripts\pio.exe' run -d firmware/esp32s3_axis_test
& 'C:\Users\XZDD\.platformio\penv\Scripts\pio.exe' run -d firmware/esp32s3_axis_test -t upload --upload-port COMx
```

如果设备重新枚举，使用设备管理器中的新 COM 口。握手失败时，按住 BOOT、短按 RESET/EN、松开 RESET/EN，再松开 BOOT，然后重试烧录。
