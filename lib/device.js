import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';

export const PHASES = {
  HOME: ['HOMING', 'E_CLEAR', 'X_HOMING', 'HOME_CONFIRMED'],
  FETCH: ['E_CLEAR', 'MOVING_TO_SLOT', 'SLOT_REACHED', 'PULLING', 'EXTRACTION_REACHED', 'TRANSFER_READY', 'MOVING_TO_PICKUP', 'PICKUP_REACHED'],
  RETURN: ['TRANSFER_READY', 'MOVING_TO_SLOT', 'SLOT_REACHED', 'PUSHING', 'INSERTION_REACHED'],
};

export const PHASE_LABELS = {
  TRANSFER_READY: '盒子完全脱离柜体且已稳固承托',
  PICKUP_REACHED: '已到左侧取物区，等待确认盒子',
  E_CLEAR: '抽盒机构已让开横移路径', X_HOMING: '左右轴正在回零',
  SLOT_REACHED: '左右轴已对准目标格',
  ACCEPTED: '任务已接收', HOMING: '正在回零', HOME_CONFIRMED: '回零完成',
  MOVING_TO_SLOT: '前往柜格', DOCKING: '对接零件盒', PULLING: '拉出零件盒',
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
      if (phase === 'TRANSFER_READY') { sensors.box_clear_of_rack = true; sensors.box_supported = true; }
      if (phase === 'PICKUP_REACHED') { sensors.x_in_position = true; sensors.location = 'PICKUP'; }
      if (phase === 'E_CLEAR') sensors.e_clear = true;
      if (phase === 'SLOT_REACHED') { sensors.x_in_position = true; sensors.slot_id = command.slot_id; }
      if (phase === 'HOME_CONFIRMED') { sensors.homed = true; sensors.home_reference_valid = true; }
      if (phase === 'EXTRACTION_REACHED') { sensors.axis_in_position = true; sensors.axis_endpoint = 'OUT'; }
      if (phase === 'INSERTION_REACHED') { sensors.axis_in_position = true; sensors.axis_endpoint = 'IN'; }
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
          cmd: command.action, slot_id: command.slot_id, config_version: 3,
          aligned_slot_id: command.aligned_slot_id, area_clear: command.area_clear }) + '\n');
      } catch (error) { finish(error); }
    });
  }
}
