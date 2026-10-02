# 格物 · 桌面智能零件柜

可直接运行的第一阶段软件 Demo。单层两格柜管理、取回件任务、状态回执、故障演练、SQLite 持久化已经实现。主控确定为 ESP32-S3，当前 Web 服务运行的是 PC 模拟设备，尚未连接真实电机。

## 启动

要求 Node.js 24 或更新版本。当前已在 Windows / Node.js 24.13.0 验证。无需 `npm install`，无第三方运行依赖。

```powershell
cd D:\ProgramStudy\Geek\Hackathon1st
npm.cmd start
```

打开 http://127.0.0.1:3210 。在终端按 Ctrl+C 停止。SQLite 在此版本 Node 中可能输出 ExperimentalWarning，不影响当前演示。

数据库首次启动自动创建在 `data/cabinet.sqlite`，后续启动保留零件名称、盒子状态、任务及事件。不应同时用多个服务进程打开同一数据库。

## 第一次演示

1. 展开页面底部“设备调试与模拟验证”，点击“模拟回零”。
2. 输入“拿 M3 螺母”并解析，确认取件；也可直接点盒子的“取到手边”。
3. 确认路径清空，观察两轴模拟阶段；轴到位后点击“确认盒子位置”。
4. 勾选“取用完成，手已离开取物口”，点击归还当前盒，到位后再次确认实际位置。
5. 输入“拿二号盒”，验证第二格选取。
6. 在调试区勾选故障注入，再取一盒。系统进入待恢复；点击“恢复模拟初始位置”并重新回零后继续。

模拟恢复保留日志和名称，不代表真实设备可按此方式恢复。真实机构中断后必须核对物理位置。

## 已实现

- 1 × 2 阵列，S01/B01 与 S02/B02；盒号与位置分开管理。
- 零件名称与别名编辑；中文/数字盒号、名称、别名匹配；歧义候选选择。
- 网页取件、回件、回零、软件停止、模拟故障与模拟恢复。
- 单任务互斥、单盒在外、request_id 去重、回件操作区确认。
- 独立设备/盒子/任务状态；只有全部阶段和到位确认齐全才显示完成。
- 异常保留最后确认位置；服务重启不重放未决动作。
- 本地 SQLite 持久化，任务阶段及模拟传感器快照日志。
- JSONL 双工流适配器及对应测试，可作为后续 USB 串口适配的基础。
- ESP32-S3 板端协议演练源码，详见 `docs/esp32s3-integration.md`。

语音入口使用浏览器 SpeechRecognition，识别结果先展示并由用户确认。部分浏览器不支持，部分依赖在线服务；文字输入始终可用。当前完成的是语音 API 接入，未做真实麦克风及现场噪声验收。[浏览器兼容与服务说明](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)

## 验证

```powershell
npm.cmd test
npm.cmd run check
```

自动化测试覆盖取回闭环、回零约束、幂等/互斥、故障/停止/超时、持久化/中断恢复、语义匹配、JSONL 分片/断连和 HTTP 接口。板端源码尚未编译或刷板，真实电机、传感器及机械结构尚未验收。

## 目录

```text
server.js                    本机 HTTP 服务与 API
lib/cabinet.js               SQLite、任务与盒子状态机、指令解析
lib/device.js                PC 模拟器、JSONL 双工流适配器
public/                     管理界面，无构建步骤
test/cabinet.test.js         行为与接口测试
firmware/esp32s3_protocol_demo/ 板端串口协议演练（无电机输出）
docs/esp32s3-integration.md  刷板说明、协议、硬件待确认项
research/                   项目方案和 48h 计划
data/                       运行时数据库（不纳入版本管理）
```

## API

`GET /api/state` 返回界面状态及本机请求 token；写请求携带 `X-Cabinet-Token`，JSON 内容类型。服务仅监听 127.0.0.1，不对公网开放。

| 方法 | 路径 | 输入 |
|---|---|---|
| GET | /api/state | 无 |
| PATCH | /api/boxes/B01 | name, aliases 数组 |
| POST | /api/interpret | text；只解析，不触发动作 |
| POST | /api/tasks | action, box_id, request_id；FETCH/RETURN 另需 area_clear=true |
| GET | /api/tasks/{id} | 无 |
| POST | /api/tasks/{id}/confirm | confirmed=true，确认实际盒子位置 |
| POST | /api/device/home | request_id |
| POST | /api/device/stop | 空对象 |
| POST | /api/simulation/reset | confirmed=true |

同一 request_id 重试同一任务会返回原任务；更改动作或盒号返回冲突。失败动作不得通过换一个 request_id 直接重试，必须先核对/恢复。名称和别名都作为文本渲染，不生成 HTML。

## 当前硬件方案

PD42S1 TTL STEP/DIR 经 1:50 减速箱和 2 mm 导程丝杆驱动 X 左右选格；三星光驱拆机微型步进电机 + A4988 直接驱动约 50 mm 的 T4 E 轴丝杆抽盒。E 电机步距角、丝杆导程和脉冲比例尚未标定，当前只允许小批量原始脉冲测试。X/E 均没有原点/限位开关，网页仍使用模拟设备。取用位置为导轨最左侧固定取物区，回件先返回原格。见 [接线、行程校核与标定步骤](docs/two-axis-hardware.md)。原六格数据库记录保留，只启用两格。

## 下一步

先在实机验证 X/E 方向和实际位移比例，再制作人工基准标记并标定取物区、S01/S02、挂钩横移和 E 轴伸缩坐标。单格分步动作通过后，再把真实运动状态机接入 COM 口。
