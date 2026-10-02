# 2026-10-02 两格两轴更新

- npm test：15/15 通过；npm run check：通过。
- 浏览器：两轴模拟回零、B02 取件、人工位置确认、回件、再次确认；最终 READY、两盒在库。
- 原六格 B03 历史记录仍可查看；不在新布局中可选。
- STL 原始模型四视图已查看，原 STL 未修改；尺寸按 mm 假定。
- 板端协议演练未接入真实运动；无开关点动固件需重新编译、烧录并实测。
- 截图：two-slot-preview.jpg。

## 2026-10-02 无开关硬件修订

- 用户确认 X 带 1:50 减速箱，X/E 均没有微动开关；配置按两轴 1.8°、16 细分、2 mm 导程更新。
- X 计算比例为 80000 pulse/mm，E 为 1600 pulse/mm；尚未做实际位移复核。
- `GEWU-AXIS-TEST-2.0-NO-ENDSTOPS` 已用 PlatformIO / Espressif32 6.3.1 编译通过，RAM 20044 B，固件 291597 B。
- npm test：17/17 通过；npm run check：通过。
- ESP32-S3 重新连接为 COM12（USB VID:PID 303A:1001），`GEWU-AXIS-TEST-2.0-NO-ENDSTOPS` 已烧录且写入校验通过。
- 烧录复位后通过 COM12 / 115200 读取 `STATUS` 成功：`endstops=NONE`、`homing=UNAVAILABLE`、`Xgear=50:1`、`Xscale=80000pulse/mm`、`Escale=1600pulse/mm`、`position=UNREFERENCED`。
- 验证只发送了 `STATUS`，未发送 ARM/JOG，电机未被命令运动。

## 2026-10-02 E 轴 5 mm 点动

- 固件更新为 `GEWU-AXIS-TEST-2.1-NO-ENDSTOPS`：X 单次最大 1 mm，E 单次最大 5 mm。
- COM12 预检通过后发送 `ARM E CLEAR` 和 `JOG E 5.0`。
- 板端返回 `START E pulses=8000 DIR=HIGH`，随后返回 `STOP reason=PULSE_SEQUENCE_DONE_NOT_POSITION_FEEDBACK emitted_pulses=8000`，最终 `moving=-`。
- 以上只证明 8000 个脉冲已发送并自动停机；实际方向、位移、抖动和堵转仍待操作者观察确认。
- 操作者观察：DIR=HIGH 时 E 轴向回缩方向平稳运动，实际距离约 30 mm，而配置距离为 5 mm。
- 由单次粗测得到约 267 pulse/mm，与 1600 pulse/mm 配置不符；在测量 MS1/MS2/MS3 电压和丝杆每圈实际位移前，不修改正式比例。
- 随后发送完全相同的 8000 脉冲、DIR=LOW 反向运动命令，板端正常完成；实际是否回到原位置待操作者确认。

以下为上一版本记录：

# 验证记录

日期：2026-10-02。环境：Windows，Node.js 24.13.0。

- `npm.cmd test`：12 项通过，0 失败。
- `npm.cmd run check`：服务端、业务状态机、设备适配器和前端脚本语法检查通过。
- 浏览器实际操作：模拟回零 → “拿三号盒”解析到 B03 杜邦线 → 确认取件 → 已送达 → 勾选操作区确认 → 回件 → 已归位，完整通过。
- 浏览器歧义验证：“拿螺丝”显示 M3 与 M4 两个候选，不自动执行。
- 当前浏览器 error/warn 日志为空。
- 窄屏布局检查：仍保持上排 S04–S06、下排 S01–S03 的二维位置，预览见 `demo-preview.jpg`。

测试只覆盖软件与模拟设备。未验证：实际麦克风转写、真实串口闭环、驱动器、电机位移比例、人工基准、软限位及机械取放。
