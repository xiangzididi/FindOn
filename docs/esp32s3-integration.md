> 硬件更新：主控为 ESP32-S3-N16R8，X 为丝杆/导轨。用户示例采用 PD42S1 STP/DIR 脉冲控制；不再默认使用 PD42S1 UART。USB JSONL 是 PC 与 ESP32 的通信，与电机脉冲接口不同。详见 two-axis-hardware.md。

# 两轴协议 v3 更新

当前硬件与行程校核以 [two-axis-hardware.md](two-axis-hardware.md) 为准：PD42S1 TTL STEP/DIR 经 1:50 减速箱驱动 X，A4988 驱动 E，仅启用 S01/S02。两轴均无原点/限位开关；板端协议文件依旧只做模拟，独立点动固件用于实机低速标定。

# ESP32-S3 联调与下一阶段实现

主控为 ESP32-S3-N16R8；驱动、候选引脚和名义行程已记录。当前没有限位输入，实际方向、可用行程和各坐标尚未标定。

## 当前代码边界

- `lib/device.js`：PC 内存模拟器，以及接收 Node.js 双工流的 JSONL 设备适配器。适配器已用假流验证分片、ACK、结果、断连、停止和超时。
- `firmware/esp32s3_protocol_demo/esp32s3_protocol_demo.ino`：ESP32-S3 串口协议演练程序，所有传感器值均由模拟阶段生成。没有 GPIO 操作，不会输出电机脉冲。
- Web 服务当前仅使用 PC 模拟器。尚未接入 COM 口，也没有把板端演练程序接成网页设备。
- 板端源码尚未编译/刷板验证。本机未检测到 Arduino CLI 或 PlatformIO；不能把源码存在视为固件验证通过。

## 刷板联调步骤

1. 在 Arduino IDE 中安装 Espressif 的 ESP32 板卡包及 ArduinoJson 7，选择板子的准确型号及 Flash/PSRAM 配置。
2. 打开同名目录里的 `.ino`。使用原生 USB 接口时，按实际开发板选择 USB CDC；若插的是 CP210x/CH340 转串口口，应使用对应 UART 配置，二者不能混淆。
3. ESP32-S3 原生 USB CDC 的官方示例设置为 `USB CDC On Boot: Enabled`、`Upload Mode: UART0 / Hardware CDC`。具体菜单随板卡与核心版本不同，以实际板卡配置为准。
4. 上传后，串口监视器选择 115200 和换行符。依次发送下面的 JSON，每次等待上一条 `result`。

```json
{"type":"status"}
{"type":"command","task_id":"bench-home-1","cmd":"HOME","slot_id":null,"config_version":3}
{"type":"command","task_id":"bench-fetch-1","cmd":"FETCH","slot_id":"S02","area_clear":true,"config_version":3}
{"type":"command","task_id":"bench-return-1","cmd":"RETURN","slot_id":"S02","area_clear":true,"config_version":3}
```

所有返回都带 `"mode":"protocol_simulation"`。这只能证明通信和流程演练，不能证明真实取放。

运行中停止：

```json
{"type":"stop","task_id":"bench-fetch-1"}
```

停止后先查询状态；仅在此无电机的演练固件里，可以发送以下命令重置模拟位置，再用新 task_id 回零。

```json
{"type":"reset_simulation","confirmed":true}
```

## 通信契约 v3

USB 串口，115200、8N1（原生 USB CDC 的实际传输不依赖传统 UART 位速率），UTF-8，每条 JSON 以 `\n` 结束。发送方逐任务执行，不在 PC 上堆积运动队列。

| 类型 | 必需字段 | 含义 |
|---|---|---|
| command | task_id, cmd, slot_id, config_version | 动作请求，cmd 为 HOME/FETCH/RETURN |
| ack | task_id, accepted, error（拒绝时） | 接收/拒绝，不表示完成 |
| event | task_id, seq, phase, sensors | 单调递增阶段事件；seq 从 1 开始 |
| result | task_id, success, error（失败时） | 任务结果，成功前必须收到完整阶段及传感器确认 |
| status | state, task_id, presented_slot | 重新连接后的状态核对 |
| stop | task_id | 停止请求；不替代实体急停 |

回零：HOMING → E_CLEAR → X_HOMING → HOME_CONFIRMED。

取件：E_CLEAR → MOVING_TO_SLOT → SLOT_REACHED → PULLING → EXTRACTION_REACHED → TRANSFER_READY → MOVING_TO_PICKUP → PICKUP_REACHED。

回件：TRANSFER_READY → MOVING_TO_SLOT → SLOT_REACHED → PUSHING → INSERTION_REACHED。

E_CLEAR 要求 e_clear=true；SLOT_REACHED 要求 x_in_position=true 且 slot_id 等于目标格；HOME_CONFIRMED 要求 homed=true、home_reference_valid=true；E 端点事件要求 axis_in_position=true 和 axis_endpoint=OUT/IN。这些都是模拟值。A4988 没有真实位置反馈，实际驱动不得将发完脉冲等同传感器到位。

板端 result 仅结束运动流程；服务端取回件进入 AWAITING_CONFIRMATION，通过 POST /api/tasks/{id}/confirm、confirmed=true 完成人工盒子确认。直接串口演练不包含该管理端步骤。

PC 对异常阶段、序号、缺少传感器回执均拒绝认定完成。真实固件应独立完成互锁，不能依赖 PC 的事后校验避免碰撞。

板端演练仅缓存最近 16 个 task_id 并拒绝重复，缓存重启即失效。正式固件必须补充持久化任务身份、上电位置核对和断线恢复。PC 不应自动重发未决动作，先发 status 查询；已经完成的任务应取回缓存结果，不能重新运动。

## 接真实硬件前待补齐

请记录以下信息，之后才能选择驱动方式、分配 GPIO、写脉冲和回零逻辑：

| 信息 | 示例（不是当前选型） |
|---|---|
| ESP32-S3 板子完整型号 | 模组 Flash/PSRAM、开发板照片/丝印、USB 口用途 |
| X/Z/E 电机与驱动型号 | STEP/DIR 驱动或其他控制方式、额定电流、使能电平 |
| 拉钩机构 | 舵机型号、电压、开合角度、推回脱钩方式 |
| 传动参数 | 同步带齿距/齿数、丝杆每圈导程、细分设置 |
| 传感器 | 当前无传感器；后续若增加，记录类型、电压、电平和机械触发位置 |
| 行程与重量 | X/Z/E 有效行程、盒子尺寸、移动总成重量 |
| 安全回路 | 实体急停、垂直轴失电防坠、逻辑电源与电机电源 |

实现顺序：单轴低速点动 → 人工基准和软限位标定 → 单格分步对接 → 人工确认取出与回柜 → 两格标定 → 串口实际闭环。

真实运动阶段必须由“运动完成＋传感器条件”推进，不能沿用演练程序里的 650 ms 定时推进。标定配置须包含版本、各格坐标、速度、加速度、软限位和取物口位置。启用 COM 口前还要添加连接握手、设备模式核验、启动状态核对；网页应明确显示真实设备或板端模拟，不能静默切换模式。

参考：[Espressif USB CDC 官方说明](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html)、[ArduinoJson 7 JsonDocument](https://arduinojson.org/v7/api/jsondocument/)。

协议 v3：TRANSFER_READY 必须带 box_clear_of_rack=true、box_supported=true；PICKUP_REACHED 必须带 x_in_position=true、location=PICKUP。目前只模拟，不代表真实传感器验证。
