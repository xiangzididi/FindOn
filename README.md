# PartGo · 桌面智能零件调度系统

PartGo 是桌面二维抽屉阵列式零件柜的 48 小时演示项目。电脑上的本地服务管理零件名称、盒位和任务历史，通过 USB 串口向 ESP32-S3 发送 `REFERENCE / FETCH / RETURN / STOP` 业务命令；ESP32-S3 控制 PD42S1 X 轴和 A4988 E 轴完成选格与抽盒。

当前演示配置启用同一层的 `S01/B01`、`S02/B02`，界面同时显示第二层 `S03/S04` 扩展位。加入 Y 轴并标定之前，第二层明确显示为不可用。

## 当前完成状态

- 新 PartGo 响应式前端已接入真实后端状态，支持搜索、浏览器语音、BOM 导入、格口编辑和批量顺序取料。
- Node.js 本地服务只监听 `127.0.0.1`，用 SQLite 保存盒位、任务、阶段事件和人工确认。
- USB 串口桥支持自动重连、控制器握手、JSONL 分片、任务超时和立即停止。
- ESP32-S3 最终固件已编译通过；上电不运动，未标定时报告 `CONFIG_LOCKED`。
- 取件送达和回件结束都要求操作员确认盒子实际位置。当前没有限位、编码器或盒体传感器，界面只显示真实存在的“开环脉冲计数”。
- 1×2 当前硬件与 2×2/Y 轴扩展共用一套格口协议和前端布局。

## 安全模拟演示

要求 Node.js 24 或更新版本。前端无需构建，也无需安装 npm 包。

```powershell
cd D:\ProgramStudy\Geek\Hackathon1st
node server.js
```

打开 <http://127.0.0.1:3210>：

1. 点击“确认机械原点”，勾选确认项。模拟模式只登记坐标，不驱动硬件。
2. 选择 `S01` 或 `S02`，确认运动区域清空后开始取件。
3. 等待页面进入“已到取物口”，取用零件并勾选取物口已清空。
4. 点击归还；模拟动作结束后目视确认提示，再点击“确认料盒已完整归位”。
5. 可导入 `.xlsx / .xls / .csv / .txt` 清单并按顺序处理已匹配的格口。

数据库保存在 `data/cabinet.sqlite`。不应同时启动多个服务进程打开同一数据库。

## USB 串口模式

Python 只用于打开串口和解析 Excel：

```powershell
python -m pip install -r requirements.txt
.\start-hardware.ps1 -Port COM12
```

也可直接设置环境变量：

```powershell
$env:PARTGO_DEVICE_MODE = "hardware"
$env:PARTGO_SERIAL_PORT = "COM12"
$env:PARTGO_SERIAL_BAUD = "115200"
node server.js
```

服务会自动重连，但只有收到 `partgo-serial-v1` 的 ESP32-S3 握手后才显示“已验证”。旧的轴测试固件会显示未验证，不会被当成最终控制器。

## 固件

- `firmware/esp32s3_axis_test`：人工标定专用。保留受限点动/脉冲测试，不执行自动任务。
- `firmware/esp32s3_controller`：最终 USB 业务控制固件。

编译最终固件：

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
& $pio run -d .\firmware\esp32s3_controller
```

当前最终固件故意保持配置锁定：X 比例已测得 `20000 pulse/mm`，E 比例、E 对接行程和 `S01/S02` X 坐标仍为空。完成标定并填写 `firmware/esp32s3_controller/src/main.cpp` 的“待标定配置”后再刷入控制板。完整协议见 [USB 串口协议 v1](docs/serial-protocol-v1.md)。

## 验证

```powershell
node --test
node --check server.js
node --check lib/cabinet.js
node --check lib/device.js
node --check lib/serial-transport.js
node --check public/app.js
```

固件验证：

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -d .\firmware\esp32s3_controller
```

自动化测试覆盖完整取回闭环、任务互斥与幂等、阶段顺序、人工盒位确认、故障/停止/超时、重启恢复、USB 握手、串口分片、HTTP 接口和数据库持久化。

## 目录

```text
server.js                         本机 HTTP 服务、静态资源与 BOM 接口
lib/cabinet.js                    SQLite、库存和任务状态机
lib/device.js                     模拟设备、JSONL 与 USB 设备适配器
lib/serial-transport.js           自动重连的 Python 串口桥进程
scripts/serial_bridge.py          pyserial 原始字节桥
scripts/parse_bom.py              本地 BOM 文件解析
public/                           PartGo 前端，无构建步骤
firmware/esp32s3_axis_test/       标定测试固件
firmware/esp32s3_controller/      最终控制固件
docs/serial-protocol-v1.md        主机与 ESP32-S3 指令集合
config/cabinet.json               1×2 启用格与 2×2 扩展配置
test/cabinet.test.js              状态机、串口与 HTTP 测试
```

## 本机 API

`GET /api/state` 返回界面状态和临时请求令牌。所有写请求携带 `X-Cabinet-Token`；服务不对局域网或公网开放。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/state` | 布局、设备、盒位和任务状态 |
| `PATCH` | `/api/boxes/{id}` | 更新零件名称和别名 |
| `POST` | `/api/tasks` | 提交取件或回件任务 |
| `POST` | `/api/tasks/{id}/confirm` | 人工确认盒子实际位置 |
| `POST` | `/api/device/reference` | 人工登记 X/E 原点 |
| `POST` | `/api/device/stop` | 软件停止并进入待恢复状态 |
| `POST` | `/api/device/recover` | 真实设备人工检查后恢复盒位记录 |
| `POST` | `/api/simulation/reset` | 仅模拟模式恢复初始状态 |
| `POST` | `/api/bom/import` | 本地解析 BOM 文件，最大 5 MB |

软件停止不能代替实体断电急停。没有限位开关时，断线、停止或动作不完整都必须先检查机械位置，再执行人工恢复和原点确认。
