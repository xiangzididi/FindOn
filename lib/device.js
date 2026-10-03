import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

export const CONTROLLER_CONFIG_VERSION = 6;
const noMotionError = message => Object.assign(new Error(message), { motionMayHaveStarted: false });

export const PHASES = {
  HOME: ['REFERENCE_ACCEPTED', 'HOME_CONFIRMED'],
  FETCH: ['E_CLEAR', 'MOVING_TO_SLOT', 'SLOT_REACHED', 'DOCKING', 'DOCK_REACHED',
    'HOOK_SHIFTING', 'HOOK_ENGAGED', 'PULLING', 'EXTRACTION_REACHED',
    'TRANSFER_READY', 'MOVING_TO_PICKUP', 'PICKUP_REACHED'],
  RETURN: ['TRANSFER_READY', 'MOVING_TO_SLOT', 'SLOT_REACHED', 'PUSHING',
    'INSERTION_REACHED', 'UNHOOKING', 'HOOK_RELEASED', 'RETRACTING',
    'E_CLEAR', 'MOVING_TO_PICKUP', 'PICKUP_REACHED'],
};

export const PHASE_LABELS = {
  TRANSFER_READY: '盒子完全脱离柜体且已稳固承托',
  PICKUP_REACHED: '已到左侧取物区，等待确认盒子',
  E_CLEAR: '抽盒机构已让开横移路径', X_HOMING: '左右轴正在回零',
  SLOT_REACHED: '左右轴已对准目标格',
  ACCEPTED: '任务已接收', HOMING: '正在回零', HOME_CONFIRMED: '机械原点已登记',
  REFERENCE_ACCEPTED: '已接受人工原点确认',
  MOVING_TO_SLOT: '前往柜格', DOCKING: '抽盒机构正在伸出对接', DOCK_REACHED: '抽盒机构已到达对接位置', PULLING: '拉出零件盒',
  HOOK_SHIFTING: '取件头向右横移挂住盒子', HOOK_ENGAGED: '挂钩已结合',
  UNHOOKING: '取件头向左横移释放盒子', HOOK_RELEASED: '挂钩已释放',
  BOX_ON_TRAY: '盒子已完整到托盘', MOVING_TO_PICKUP: '运送到取物口',
  PRESENTED: '已送达，可取用', PUSHING: '推回零件盒', BOX_IN_SLOT: '盒子已推到位',
  RETRACTING: '取件头收回', STORED: '已归位',
  ALIGNMENT_CONFIRMED: '人工对准与挂钩已确认',
  EXTRACTION_REACHED: '抽盒轴到达目标位置',
  INSERTION_REACHED: '抽盒轴回到柜内端，等待确认归位',
  OPERATOR_CONFIRMED: '操作员已确认盒子位置',
};

// Same event contract as the future MCU adapter. These are simulated sensors.
export class SimulatedDevice {
  mode = 'simulation';
  constructor({ stepMs = 650 } = {}) { this.stepMs = stepMs; }

  async execute(command, onEvent, signal) {
    let seq = 0;
    for (const phase of PHASES[command.action]) {
      await delay(this.stepMs, undefined, { signal });
      if (command.fault_at === phase) throw new Error(`模拟故障：${PHASE_LABELS[phase]}未得到到位确认`);
      const sensors = {};
      sensors.evidence = 'simulation';
      if (phase === 'TRANSFER_READY') { sensors.box_clear_of_rack = true; sensors.box_supported = true; }
      if (phase === 'PICKUP_REACHED') { sensors.x_in_position = true; sensors.location = 'PICKUP'; }
      if (phase === 'E_CLEAR') sensors.e_clear = true;
      if (phase === 'SLOT_REACHED') { sensors.x_in_position = true; sensors.slot_id = command.slot_id; }
      if (phase === 'HOME_CONFIRMED') { sensors.homed = true; sensors.home_reference_valid = true; }
      if (phase === 'DOCK_REACHED') sensors.axis_in_position = true;
      if (phase === 'EXTRACTION_REACHED') { sensors.axis_in_position = true; sensors.axis_endpoint = 'RETRACTED'; }
      if (phase === 'INSERTION_REACHED') { sensors.axis_in_position = true; sensors.axis_endpoint = 'EXTENDED'; }
      if (phase === 'HOOK_ENGAGED') { sensors.x_in_position = true; sensors.hook_engaged = true; }
      if (phase === 'HOOK_RELEASED') { sensors.x_in_position = true; sensors.hook_released = true; }
      onEvent({ task_id: command.id, seq: ++seq, phase, sensors });
    }
  }
}

// Transport-independent JSONL adapter. Serial/TCP opening and hardware startup
// reconciliation are intentionally left to the hardware-specific integration.
export class JsonLineDevice {
  mode = 'hardware';
  constructor(stream, { timeoutMs = 30000 } = {}) {
    this.stream = stream;
    this.timeoutMs = timeoutMs;
  }

  execute(command, onEvent, signal) {
    if (this.busy) return Promise.reject(new Error('设备适配器忙'));
    if (signal.aborted) return Promise.reject(new Error('任务已停止'));
    this.busy = true;
    return new Promise((resolve, reject) => {
      let buffer = '', timer;
      const decoder = new StringDecoder('utf8');
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.stream.off('data', onData);
        this.stream.off('error', onError);
        this.stream.off('close', onClose);
        signal.removeEventListener('abort', onAbort);
        this.busy = false;
        error ? reject(error) : resolve();
      };
      const sendStop = () => {
        try { this.stream.write(JSON.stringify({ type: 'stop', task_id: command.id }) + '\n'); } catch {}
      };
      const fail = (error) => { sendStop(); finish(error); };
      const onError = error => finish(error);
      const onClose = () => finish(new Error('设备连接断开，位置待核对'));
      const onAbort = () => fail(new Error('任务已停止，位置待核对'));
      const onData = chunk => {
        buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 16384) return fail(new Error('设备消息超出长度限制'));
        let end;
        while (!finished && (end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line);
            if (!message || typeof message !== 'object') throw new Error('无效设备消息');
            if (message.task_id !== command.id) continue;
            if (message.type === 'ack' && message.accepted !== true) throw new Error(message.error || '设备拒绝任务');
            if (message.type === 'event') onEvent(message);
            if (message.type === 'result') {
              if (message.success !== true) throw new Error(message.error || '设备执行失败');
              finish();
            }
          } catch (error) { fail(error); }
        }
      };
      this.stream.on('data', onData);
      this.stream.on('error', onError);
      this.stream.on('close', onClose);
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => fail(new Error('设备任务超时')), this.timeoutMs);
      try {
        this.stream.write(JSON.stringify({ type: 'command', task_id: command.id,
          cmd: command.action, slot_id: command.slot_id, config_version: CONTROLLER_CONFIG_VERSION,
          aligned_slot_id: command.aligned_slot_id, area_clear: command.area_clear }) + '\n');
      } catch (error) { finish(error); }
    });
  }
}

// Persistent USB adapter. It owns line parsing so idle hello/status messages and
// active task events can share one serial stream without competing listeners.
export class UsbSerialDevice {
  mode = 'hardware';

  constructor(transport, { timeoutMs = 180000, probeMs = 500, staleMs = 2000,
    heartbeatAckMs = 1500,
    expectedCalibrationId = null } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.probeMs = probeMs;
    this.staleMs = staleMs;
    this.heartbeatAckMs = heartbeatAckMs;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.status = null;
    this.lastSeenAt = 0;
    this.protocolError = null;
    this.expectedCalibrationId = expectedCalibrationId;
    this.hostSessionId = randomUUID();
    transport.on('data', chunk => this.#onData(chunk));
    transport.on('open', () => { this.protocolError = null; this.probe(); });
    transport.on('close', () => this.#disconnect('串口桥已断开'));
    transport.on('offline', error => this.#disconnect(error.message));
    transport.on('error', error => this.#disconnect(error.message));
  }

  start() {
    this.transport.start();
    this.probeTimer = setInterval(() => this.probe(), this.probeMs);
    this.probeTimer.unref?.();
  }

  close() {
    clearInterval(this.probeTimer);
    this.#disconnect('设备连接已关闭');
    this.transport.close();
  }

  info() {
    const transport = this.transport.info?.() || {};
    const fresh = this.lastSeenAt > 0 && Date.now() - this.lastSeenAt <= this.staleMs;
    const verified = fresh && this.status?.protocol === 'partgo-serial-v1' &&
      this.status?.node === 'ESP32-S3' && this.status?.v === 1;
    const configVersionMatch = Boolean(verified && this.status?.config_version === CONTROLLER_CONFIG_VERSION);
    const calibrationMatch = Boolean(verified && (!this.expectedCalibrationId ||
      this.status?.calibration_id === this.expectedCalibrationId));
    const compatible = Boolean(verified && configVersionMatch && calibrationMatch);
    return { mode: 'hardware', connected: Boolean(transport.bridge_connected && fresh),
      verified, compatible, config_version_match: configVersionMatch,
      calibration_match: calibrationMatch,
      expected_calibration_id: this.expectedCalibrationId,
      calibration_id: verified ? this.status.calibration_id || null : null,
      state: verified ? this.status.state : 'OFFLINE',
      motion_configured: Boolean(verified && this.status.motion_configured),
      referenced: Boolean(verified && this.status.referenced),
      presented_slot_id: verified ? this.status.presented_slot_id || null : null,
      node: verified ? this.status.node : 'ESP32-S3', firmware: verified ? this.status.firmware : null,
      protocol: verified ? this.status.protocol : null, config_version: verified ? this.status.config_version : null,
      layout: verified ? this.status.layout : null, calibration: verified ? this.status.calibration : null,
      slots: verified ? this.status.slots : [], last_seen_at: this.lastSeenAt ? new Date(this.lastSeenAt).toISOString() : null,
      reason: !transport.bridge_connected ? (transport.bridge_error || 'serial_disconnected')
        : !fresh ? (this.protocolError || 'controller_no_response')
          : !verified ? 'handshake_invalid'
            : !configVersionMatch ? 'controller_config_version_mismatch'
              : !calibrationMatch ? 'controller_calibration_mismatch' : null,
      ...transport };
  }

  probe() {
    if (!this.transport.info?.().bridge_connected) return;
    if (this.pending && this.lastSeenAt > 0 && Date.now() - this.lastSeenAt > this.heartbeatAckMs) {
      this.stop();
      this.pending.finish(new Error('控制器心跳响应超时，位置待核对'));
      return;
    }
    const requestId = `status-${Date.now()}`;
    try { this.transport.write(`${JSON.stringify({ v: 1, type: 'status', request_id: requestId,
      host_session_id: this.hostSessionId })}\n`); }
    catch (error) { this.protocolError = error.message; }
  }

  stop() {
    try { this.transport.write('!\n'); } catch {}
  }

  execute(command, onEvent, signal) {
    if (this.pending) return Promise.reject(noMotionError('设备适配器忙'));
    const info = this.info();
    if (!info.connected || !info.verified) return Promise.reject(noMotionError('ESP32-S3 USB 串口未通过握手'));
    if (!info.compatible) return Promise.reject(noMotionError(
      info.calibration_match === false ? '控制器标定与本机配置不一致，请重新编译烧录并读回确认'
        : '控制器协议配置版本不匹配，请烧录当前固件'));
    if (!info.motion_configured) return Promise.reject(noMotionError('控制器配置锁定：请先完成 E 轴和格口坐标标定'));
    if (signal.aborted) return Promise.reject(noMotionError('任务已停止'));

    return new Promise((resolve, reject) => {
      let timer;
      const finish = error => {
        if (!this.pending || this.pending.taskId !== command.id) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.pending = null;
        error ? reject(error) : resolve();
        setTimeout(() => this.probe(), 20).unref?.();
      };
      const abort = () => {
        this.stop();
        finish(new Error('任务已停止，位置待核对'));
      };
      this.pending = { taskId: command.id, onEvent, finish, acked: false };
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        this.stop();
        finish(new Error('设备任务超时，位置待核对'));
      }, this.timeoutMs);
      const cmd = command.action === 'HOME' ? 'REFERENCE' : command.action;
      const message = { v: 1, type: 'command', task_id: command.id, cmd,
        config_version: CONTROLLER_CONFIG_VERSION,
        calibration_id: this.expectedCalibrationId,
        host_session_id: this.hostSessionId,
        area_clear: command.area_clear === true };
      if (command.slot_id) message.slot_id = command.slot_id;
      if (cmd === 'REFERENCE') message.manual_reference_confirmed = command.manual_reference_confirmed === true;
      if (cmd === 'RECOVER') message.confirmed_all_stored = command.confirmed_all_stored === true;
      try { this.transport.write(`${JSON.stringify(message)}\n`); }
      catch (error) { finish(error); }
    });
  }

  #disconnect(message) {
    this.status = null;
    this.lastSeenAt = 0;
    if (this.pending) this.pending.finish(new Error(`${message}，位置待核对`));
  }

  #onData(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > 32768) {
      this.buffer = '';
      this.protocolError = 'controller_message_overflow';
      if (this.pending) this.pending.finish(new Error('控制器消息超出长度限制'));
      return;
    }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.protocolError = 'controller_non_json_response';
        continue;
      }
      if (!message || typeof message !== 'object' || message.v !== 1) continue;
      this.lastSeenAt = Date.now();
      if (message.type === 'hello' || message.type === 'status') {
        this.status = message;
        this.protocolError = null;
        continue;
      }
      const pending = this.pending;
      if (!pending || message.task_id !== pending.taskId) continue;
      if (message.type === 'ack') {
        if (message.accepted !== true) pending.finish(noMotionError(message.error || '控制器拒绝任务'));
        else pending.acked = true;
      } else if (message.type === 'event') {
        try { pending.onEvent(message); }
        catch (error) { this.stop(); pending.finish(error); }
      } else if (message.type === 'result') {
        if (message.success === true) pending.finish();
        else pending.finish(new Error(message.error || '控制器执行失败'));
      }
    }
  }
}
