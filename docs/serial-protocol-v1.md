# PartGo USB 串口协议 v1

本协议用于本机 Node.js 服务与 ESP32-S3 控制器之间的 USB CDC 通信。浏览器只访问本机 HTTP API，不直接打开串口，也不向控制器发送脉冲数、速度或方向。

## 传输格式

- 串口：`115200 8N1`，UTF-8。
- 每条消息是一个 JSON 对象，以 `\n` 结束（JSON Lines）。
- 单行最长 768 字节；超长、无效 JSON、未知字段值均拒绝。
- 协议号字段为 `"v":1`，协议名称为 `partgo-serial-v1`。
- `task_id`、`request_id` 仅允许字母、数字、下划线和连字符，最长 64 字符。
- 任意时刻收到单字节 `!`，控制器立即停止 STEP 输出并关闭可控的电机使能。它是 JSON 解析之外的紧急软件停止通道。

## 状态

| 状态 | 含义 | 允许的操作 |
| --- | --- | --- |
| `CONFIG_LOCKED` | 缺少 E 轴比例或格口坐标 | `hello`、`status`、`stop` |
| `UNREFERENCED` | 配置完整，但本次上电尚未人工确认原点 | `hello`、`status`、`REFERENCE`、`stop` |
| `READY` | 原点有效，空闲 | 业务命令、查询、停止 |
| `PRESENTED` | 一个料盒位于左侧取物口 | 只允许对应格口的 `RETURN`、查询、停止 |
| `BUSY` | 正在执行任务 | 查询、停止 |
| `RECOVERY_REQUIRED` | 停止、超时、通信异常或动作未完整结束 | 查询、停止；断电检查后重新人工置零 |

控制器上电绝不自动运动。当前机构没有限位开关，因此 `REFERENCE` 不是自动回零：操作员必须先断开运动、把 X 平台放到左侧取物原点、把 E 轴置于完全收回位置并清空运动区域，再在页面中确认。

## 主机发往 ESP32-S3

### 握手

```json
{"v":1,"type":"hello","request_id":"boot-01"}
```

控制器返回同一 `request_id` 的 `hello`。本机只有在节点、协议号和固件信息均有效后才显示“控制器已验证”。

### 查询状态

```json
{"v":1,"type":"status","request_id":"status-01"}
```

### 人工建立原点

```json
{"v":1,"type":"command","task_id":"task-ref-01","cmd":"REFERENCE","config_version":5,"manual_reference_confirmed":true,"area_clear":true}
```

控制器不执行电机动作，只把当前位置登记为 `X=0 mm`、`E=0 mm`。缺少两个确认字段时必须拒绝。

### 取件

```json
{"v":1,"type":"command","task_id":"task-fetch-01","cmd":"FETCH","slot_id":"S01","config_version":5,"area_clear":true}
```

### 回件

```json
{"v":1,"type":"command","task_id":"task-return-01","cmd":"RETURN","slot_id":"S01","config_version":5,"area_clear":true}
```

### 停止

```json
{"v":1,"type":"stop","task_id":"task-fetch-01"}
```

本机服务同时发送单字节 `!`，不等待一整行 JSON 被解析。网页停止按钮只是软件停止请求，实体设备仍应设置独立断电急停。

## ESP32-S3 发往主机

### 握手与状态

```json
{"v":1,"type":"hello","request_id":"boot-01","protocol":"partgo-serial-v1","node":"ESP32-S3","firmware":"PARTGO-CONTROLLER-1.2.2","state":"CONFIG_LOCKED","motion_configured":false,"referenced":false,"busy":false,"config_version":5,"layout":{"rows":2,"columns":2,"has_y_axis":false},"calibration":{"x_pulse_per_mm":20000,"e_pulse_per_mm":21,"e_dock_um":48000,"x_hook_shift_um":4500},"slots":[{"id":"S01","enabled":true,"calibrated":false},{"id":"S02","enabled":true,"calibrated":false},{"id":"S03","enabled":false,"calibrated":false},{"id":"S04","enabled":false,"calibrated":false}]}
```

`status` 响应字段相同，只把 `type` 改为 `status`。`motion_configured=false` 时，本机页面显示“待标定”，并禁用自动取还件。

## 标定台人工控制兼容层

最终固件也接受标定台使用的受限纯文本命令：`STATUS`、`ARM X CLEAR`、`ARM E CLEAR`、`TRAVEL X ±1–20`、`PULSE E ±16–320`、`STOP` 和单字节 `!`。每次 `ARM` 在 10 秒内只允许一次移动。人工移动会清除绝对原点并返回 `position=UNREFERENCED`；必须重新确认 X 位于取物区、E 完全回缩并执行 `REFERENCE`，才能恢复自动任务。正在执行任务或取物区存在盒子时拒绝人工移动。

### 接受或拒绝

```json
{"v":1,"type":"ack","task_id":"task-fetch-01","accepted":true}
```

```json
{"v":1,"type":"ack","task_id":"task-fetch-01","accepted":false,"error":"CONFIG_LOCKED"}
```

常见错误码：`INVALID_MESSAGE`、`PROTOCOL_VERSION`、`CONFIG_VERSION`、`CONFIG_LOCKED`、`REFERENCE_REQUIRED`、`BUSY`、`UNKNOWN_SLOT`、`SLOT_DISABLED`、`Y_AXIS_REQUIRED`、`AREA_NOT_CLEAR`、`MANUAL_REFERENCE_REQUIRED`、`DUPLICATE_TASK_ID`。

### 阶段事件

```json
{"v":1,"type":"event","task_id":"task-fetch-01","seq":3,"phase":"SLOT_REACHED","sensors":{"slot_id":"S01","x_in_position":true,"evidence":"open_loop_pulse_count"}}
```

当前硬件没有限位开关、编码器和盒体传感器，因此 `sensors` 字段描述的是开环脉冲计数结果，不能伪装成真实传感器。后端只在完整收到所有阶段后进入“待人工确认”；盒子位置由操作员确认后才写入库存状态。

阶段顺序：

- `REFERENCE`：`REFERENCE_ACCEPTED` → `HOME_CONFIRMED`
- `FETCH`：`E_CLEAR` → `MOVING_TO_SLOT` → `SLOT_REACHED` → `DOCKING` → `DOCK_REACHED` → `HOOK_SHIFTING` → `HOOK_ENGAGED` → `PULLING` → `EXTRACTION_REACHED` → `TRANSFER_READY` → `MOVING_TO_PICKUP` → `PICKUP_REACHED`
- `RETURN`：`TRANSFER_READY` → `MOVING_TO_SLOT` → `SLOT_REACHED` → `PUSHING` → `INSERTION_REACHED` → `UNHOOKING` → `HOOK_RELEASED` → `RETRACTING` → `E_CLEAR` → `MOVING_TO_PICKUP` → `PICKUP_REACHED`

机械动作固定为：取件时到达格口基准坐标，E 伸出 `48 mm`，X 向右 `4.5 mm` 挂住盒子，E 回缩 `48 mm`，再回到左侧取物区。回件执行逆序动作：到达格口右偏 `4.5 mm` 的坐标，E 伸出 `48 mm`，X 向左 `4.5 mm` 释放盒子，E 回缩后返回取物区。

### 最终结果

```json
{"v":1,"type":"result","task_id":"task-fetch-01","success":true,"state":"READY"}
```

```json
{"v":1,"type":"result","task_id":"task-fetch-01","success":false,"state":"RECOVERY_REQUIRED","error":"MOTION_TIMEOUT"}
```

## 1×2 与 2×2 扩展

固件始终使用 `slot_id` 查表，不接收行列坐标。当前配置启用 `S01`、`S02`，两格都位于同一行；`S03`、`S04` 为第二行预留。加入 Y 轴并完成标定前，第二行格口返回 `Y_AXIS_REQUIRED`。本机后端可以在同一页面显示这些扩展格，但会明确标成不可用。

## 断线和幂等规则

- 本机数据库用 `request_id` 防止网页重复提交。
- 控制器同一时刻只接受一个 `task_id`；重复或冲突 ID 被拒绝。
- 执行中串口断开、服务超时或 ESP32 重启时，后端把盒位标为未知并进入恢复状态，不自动重放任务。
- 任务成功只说明预定脉冲序列完整结束。是否真正抓住、抽出或归位零件盒，仍由操作员确认。
