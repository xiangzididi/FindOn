# PartGo · 桌面智能零件调度系统

PartGo 是桌面二维抽屉阵列式零件柜的 48 小时演示项目。电脑上的本地服务管理零件名称、盒位和任务历史，通过 USB 串口向 ESP32-S3 发送 `REFERENCE / FETCH / RETURN / STOP / RECOVER` 业务命令；ESP32-S3 控制 PD42S1 X 轴和 A4988 E 轴完成选格与抽盒。

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
cd D:\Hackathon1st\Hackathon1st
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

Windows 下可直接双击项目根目录的 `启动管理系统.bat`。它只会关闭由本项目启动、身份核验一致且已确认空闲的旧进程；存在运动、待确认盒子、待恢复状态或无法读取旧服务状态时，会拒绝强制切换。如果 `COM9` 被其他程序占用，也会明确报错而不会结束未知进程。双击 `启动标定台.bat` 可切换到标定台；两个启动器默认使用 `COM9`，也可在命令行把其他串口作为第一个参数传入。

Python 只用于打开串口和解析 Excel：

```powershell
python -m pip install -r requirements.txt
.\start-hardware.ps1 -Port COM9
```

也可直接设置环境变量：

```powershell
$env:PARTGO_DEVICE_MODE = "hardware"
$env:PARTGO_SERIAL_PORT = "COM9"
$env:PARTGO_SERIAL_BAUD = "115200"
node server.js
```

服务会自动重连，但只有同时通过 `partgo-serial-v1` 握手、配置版本和标定指纹校验后才允许运动。旧轴测试固件、旧业务固件或参数不一致的固件只显示诊断状态，不会被当成可用控制器。任务进行时，主机每 500 ms 续租；控制器连续 2 s 收不到同一主机会话的心跳就停止输出并将任务判为失败。

## 固件

- `firmware/esp32s3_axis_test`：人工标定专用。保留受限点动/脉冲测试，不执行自动任务。
- `firmware/esp32s3_controller`：最终 USB 业务控制固件，同时兼容标定台的一次性受限人工移动。

编译最终固件：

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
& $pio run -d .\firmware\esp32s3_controller
```

最终固件的机械参数已经完整：X 比例为 `20000 pulse/mm`，E 根据带载实测“100 脉冲 = 19.6 mm”采用 `250/49 pulse/mm`（约 `5.1020 pulse/mm`）；48 mm 对接行程发送 245 个全步脉冲，相对 51 mm 实测可用行程保留约 3 mm 机械余量。`S01/S02` 的格口对位坐标分别为 `29.8 mm / 105 mm`，挂取动作再向右横移 `5.2 mm`。编译后的控制器不再处于 `CONFIG_LOCKED`，但每次上电仍必须把 X 放在最左侧取物处、E 完全回缩并由操作员确认原点后，才接受取回任务。完整协议见 [USB 串口协议 v1](docs/serial-protocol-v1.md)。

## 本地标定台

需要重新标定时，先烧录 `esp32s3_axis_test` 测试固件，把 X/E 滑块放在行程中间并打开电机电源。标定工具默认连接 `COM9`：

```powershell
.\start-calibration.ps1 -Port COM9
```

打开 <http://127.0.0.1:3212>。工具每次只发送一次 `ARM` 和一次有限运动，不提供连续转动；X 单次限制为 1–20 mm，E 在当前全步模式下单次限制为 1–100 脉冲。运动完成后填入卡尺实测距离，工具按当前实测比例换算标定基准。随后录入 E 对接行程、S01/S02 相对取物区的 X 坐标和方向，点击“写入最终固件配置”。

标定结果保存到 `config/motion-calibration.json`，同时生成 `firmware/esp32s3_controller/src/machine_calibration.h`。两者包含同一份安全参数指纹，上位机启动和控制器握手都会核对。缺少任何必需参数时不会写入，最终固件继续保持 `CONFIG_LOCKED`。无硬件时可验证界面：

```powershell
.\start-calibration.ps1 -Simulate
```

模拟模式会生成虚拟回执，不能作为实机标定结果，也不能写入或覆盖生产标定文件。

## 验证

```powershell
node --test
node --check server.js
node --check lib/cabinet.js
node --check lib/device.js
node --check lib/serial-transport.js
node --check public/app.js
node --check calibration/app.js
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" -m unittest discover -s test -p "test_*.py"
```

固件验证：

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -d .\firmware\esp32s3_controller
```

自动化测试覆盖完整取回闭环、任务互斥与幂等、阶段顺序、人工盒位确认、故障/停止/超时、重启恢复、USB 握手、固件版本与标定指纹、任务心跳、受控恢复、串口分片与断线、HTTP 接口和数据库持久化。

## 目录

```text
server.js                         本机 HTTP 服务、静态资源与 BOM 接口
lib/cabinet.js                    SQLite、库存和任务状态机
lib/device.js                     模拟设备、JSONL 与 USB 设备适配器
lib/serial-transport.js           自动重连的 Python 串口桥进程
scripts/serial_bridge.py          pyserial 原始字节桥
scripts/parse_bom.py              本地 BOM 文件解析
scripts/calibration_server.py     有限运动、测量与固件参数生成
calibration/                      本地标定台网页
start-calibration.ps1             标定台启动入口
public/                           PartGo 前端，无构建步骤
firmware/esp32s3_axis_test/       标定测试固件
firmware/esp32s3_controller/      最终控制固件
docs/serial-protocol-v1.md        主机与 ESP32-S3 指令集合
config/cabinet.json               1×2 启用格与 2×2 扩展配置
config/motion-calibration.json    机械标定数据
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

软件停止不能代替实体断电急停。当前设备没有实体急停和限位开关，调试时必须有人全程看护，并确保能立即切断 12 V 电机电源。ESP32 由 USB 独立供电，无法感知 12 V 是否断过；所以断线、停止、控制器复位、12 V 断电/重上电或动作不完整后，都必须先检查机械位置，再执行人工恢复和原点确认。
