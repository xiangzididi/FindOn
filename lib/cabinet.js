import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PHASES, PHASE_LABELS, SimulatedDevice } from './device.js';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const assert = (condition, message, status = 400) => { if (!condition) throw new AppError(message, status); };
const now = () => new Date().toISOString();
const normalize = value => value.toLowerCase().replace(/[\s，。！？、,.!?]/g, '');
export const DEFAULT_LAYOUT = JSON.parse(readFileSync(new URL('../config/cabinet.json', import.meta.url), 'utf8'));

export class Cabinet {
  constructor(path = ':memory:', { device = new SimulatedDevice(), timeoutMs = 30000, layout = DEFAULT_LAYOUT } = {}) {
    this.device = device;
    this.timeoutMs = timeoutMs;
    this.layout = layout;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS boxes (
        id TEXT PRIMARY KEY, slot_id TEXT UNIQUE NOT NULL, row INTEGER NOT NULL,
        col INTEGER NOT NULL, name TEXT NOT NULL, aliases TEXT NOT NULL,
        state TEXT NOT NULL, last_location TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, action TEXT NOT NULL,
        box_id TEXT REFERENCES boxes(id), status TEXT NOT NULL, phase TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        seq INTEGER NOT NULL, phase TEXT NOT NULL, sensors TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(task_id, seq));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES ('device_state', 'UNHOMED');`);
    // Old six-slot records and their task history remain in SQLite. Only the
    // configured slots are selectable; uncertain archived boxes still block work.
    this.transaction(() => this.activeSlots().forEach(slot => {
      this.db.prepare('INSERT OR IGNORE INTO boxes VALUES (?,?,?,?,?,?,?,?)').run(
        slot.box_id, slot.id, slot.row, slot.column, slot.name, JSON.stringify(slot.aliases), 'STORED', slot.id);
    }));
    this.transaction(() => {
      const interrupted = this.db.prepare("SELECT * FROM tasks WHERE status IN ('RUNNING','AWAITING_CONFIRMATION')").all();
      for (const task of interrupted) {
        this.db.prepare("UPDATE tasks SET status='INTERRUPTED', error=?, finished_at=? WHERE id=?")
          .run('服务重启，执行结果未确认', now(), task.id);
        if (task.box_id) this.db.prepare("UPDATE boxes SET state='UNKNOWN' WHERE id=?").run(task.box_id);
      }
      const uncertain = this.db.prepare("SELECT id FROM boxes WHERE state!='STORED'").get();
      if (interrupted.length || uncertain || this.deviceState === 'RECOVERY_REQUIRED') this.deviceState = 'RECOVERY_REQUIRED';
      else this.deviceState = 'UNHOMED';
    });
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get deviceState() { return this.db.prepare("SELECT value FROM settings WHERE key='device_state'").get().value; }
  set deviceState(value) { this.db.prepare("UPDATE settings SET value=? WHERE key='device_state'").run(value); }
  activeSlots() { return this.layout.slots.filter(slot => slot.enabled !== false); }
  boxes(activeOnly = true) {
    const all = this.db.prepare('SELECT * FROM boxes ORDER BY row DESC, col').all().map(b => ({ ...b, aliases: JSON.parse(b.aliases) }));
    if (!activeOnly) return all;
    return this.activeSlots().map(slot => ({ ...all.find(b => b.id === slot.box_id), slot_id: slot.id, row: slot.row, col: slot.column }));
  }
  pendingTask() { return this.db.prepare("SELECT * FROM tasks WHERE status='AWAITING_CONFIRMATION' ORDER BY rowid DESC LIMIT 1").get(); }
  getTask(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    assert(task, '任务不存在', 404);
    return { ...task, phase_label: PHASE_LABELS[task.phase] || task.phase,
      events: this.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY seq').all(id)
        .map(e => ({ ...e, sensors: JSON.parse(e.sensors), phase_label: PHASE_LABELS[e.phase] || e.phase })) };
  }
  snapshot() {
    const tasks = this.db.prepare('SELECT id FROM tasks ORDER BY rowid DESC LIMIT 30').all().map(t => this.getTask(t.id));
    return { mode: this.device.mode, device: this.device.info?.() || { mode: this.device.mode, connected: true, verified: this.device.mode === 'simulation', state: this.deviceState },
      device_state: this.deviceState, boxes: this.boxes(), tasks,
      layout: this.layout, archived_box_count: this.boxes(false).length - this.activeSlots().length,
      active_slot_count: this.activeSlots().length,
      active_task_id: this.active?.id || null, pending_task_id: this.pendingTask()?.id || null,
      phases: PHASES, phase_labels: PHASE_LABELS };
  }
  editBox(id, { name, aliases }) {
    assert(!this.active && !this.pendingTask(), '执行任务期间不能编辑零件', 409);
    assert(this.boxes().some(b => b.id === id), '该盒子不在当前两格配置中', 404);
    assert(typeof name === 'string' && name.trim().length > 0 && name.length <= 60, '名称需为 1–60 字');
    assert(Array.isArray(aliases) && aliases.length <= 12 && aliases.every(x => typeof x === 'string' && x.trim() && x.length <= 40), '别名格式无效');
    const result = this.db.prepare('UPDATE boxes SET name=?, aliases=? WHERE id=?')
      .run(name.trim(), JSON.stringify([...new Set(aliases.map(x => x.trim()))]), id);
    assert(result.changes, '盒子不存在', 404);
    return this.boxes().find(b => b.id === id);
  }

  submit({ action, box_id = null, request_id, area_clear = false, aligned_slot_id = null,
    manual_reference_confirmed = false, fault_at = null }) {
    assert(Object.hasOwn(PHASES, action), '不支持的动作');
    assert(typeof request_id === 'string' && /^[\w-]{1,100}$/.test(request_id), '缺少有效 request_id');
    const existing = this.db.prepare('SELECT * FROM tasks WHERE request_id=?').get(request_id);
    if (existing) {
      assert(existing.action === action && existing.box_id === box_id, 'request_id 已用于不同任务', 409);
      return this.getTask(existing.id);
    }
    assert(!this.active, '设备正在执行任务', 409);
    assert(!this.pendingTask(), '请先确认上一个任务的盒子实际位置', 409);
    assert(this.deviceState !== 'RECOVERY_REQUIRED', '需要先核对并恢复设备状态', 409);
    const boxes = this.boxes();
    const box = boxes.find(b => b.id === box_id);
    const deviceInfo = this.device.info?.();
    if (this.device.mode === 'hardware') {
      assert(deviceInfo?.connected && deviceInfo?.verified, 'ESP32-S3 USB 串口未通过握手', 503);
      assert(deviceInfo.motion_configured, '控制器仍处于配置锁定：请先完成 E 轴和格口坐标标定', 409);
    }
    if (action === 'HOME') {
      assert(box_id === null, '回零不接受盒号');
      assert(this.boxes(false).every(b => b.state === 'STORED'), '盒子未全部归位，不能登记原点', 409);
      if (this.device.mode === 'hardware') {
        assert(manual_reference_confirmed === true && area_clear === true,
          '无行程开关：请先把 X/E 轴放到规定原点并确认运动区域已清空');
      }
    } else {
      assert(this.deviceState === 'READY', '请先确认机械原点', 409);
      assert(box, '盒子不存在', 404);
      if (action === 'FETCH') {
        assert(this.boxes(false).every(b => b.state === 'STORED'), '请先归还当前盒子', 409);
        assert(area_clear === true, '请确认手已离开抽盒区域');
      }
      else {
        assert(box.state === 'PRESENTED', '该盒子不在取物口', 409);
        assert(area_clear === true, '请确认手已离开取物口');
      }
    }
    assert(!fault_at || (this.device.mode === 'simulation' && PHASES[action].includes(fault_at)), '故障注入参数无效');
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, request_id, action, box_id, 'RUNNING', 'ACCEPTED', null, now(), null);
      this.deviceState = action === 'HOME' ? 'HOMING' : 'BUSY';
      if (box) this.db.prepare("UPDATE boxes SET state='IN_TRANSIT' WHERE id=?").run(box_id);
    });
    const controller = new AbortController();
    this.active = { id, controller };
    this.running = this.run({ id, action, box_id, slot_id: box?.slot_id || null,
      aligned_slot_id, area_clear, manual_reference_confirmed, fault_at }, controller);
    return this.getTask(id);
  }

  async run(command, controller) {
    const expected = PHASES[command.action];
    let count = 0;
    let timer;
    try {
      const execution = this.device.execute(command, event => {
        assert(!controller.signal.aborted, '任务已停止');
        assert(event.task_id === command.id && event.seq === count + 1 && event.phase === expected[count], '设备阶段或序号不一致');
        const s = event.sensors || {};
        if (event.phase === 'TRANSFER_READY') assert(
          (s.box_clear_of_rack === true && s.box_supported === true) ||
          (s.motion_complete === true && s.e_clear === true && s.evidence === 'open_loop_pulse_count'),
          '载盒横移条件不足：抽盒动作未完整结束');
        if (event.phase === 'PICKUP_REACHED') assert(s.x_in_position === true && s.location === 'PICKUP', '左侧取物区到位确认不足');
        if (event.phase === 'E_CLEAR') assert(s.e_clear === true, '横移前抽盒机构未确认让开');
        if (event.phase === 'SLOT_REACHED') assert(s.x_in_position === true && s.slot_id === command.slot_id, '目标柜格到位确认不足');
        if (event.phase === 'DOCK_REACHED') assert(s.axis_in_position === true, '抽盒机构对接位置确认不足');
        if (event.phase === 'EXTRACTION_REACHED') assert(s.axis_in_position === true && s.axis_endpoint === 'RETRACTED', '抽盒轴回缩到位确认不足');
        if (event.phase === 'INSERTION_REACHED') assert(s.axis_in_position === true && s.axis_endpoint === 'EXTENDED', '回盒轴伸出到位确认不足');
        if (event.phase === 'HOME_CONFIRMED') assert(s.homed === true && s.home_reference_valid === true, '回零确认不足');
        this.transaction(() => {
          this.db.prepare('INSERT INTO events(task_id,seq,phase,sensors,created_at) VALUES (?,?,?,?,?)')
            .run(command.id, event.seq, event.phase, JSON.stringify(s), now());
          this.db.prepare('UPDATE tasks SET phase=? WHERE id=?').run(event.phase, command.id);
          // A motor encoder or endstop observes the axis, not the box. Keep the
          // last confirmed box location until the operator verifies the box.
        });
        count++;
      }, controller.signal);
      const watchdog = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('任务超时，位置待核对')); }, this.timeoutMs);
      });
      await Promise.race([execution, watchdog]);
      assert(!controller.signal.aborted, '任务已停止');
      assert(count === expected.length, '设备缺少完整到位回执，不能认定完成');
      this.transaction(() => {
        this.db.prepare('UPDATE tasks SET status=?, finished_at=? WHERE id=?')
          .run(command.box_id ? 'AWAITING_CONFIRMATION' : 'SUCCEEDED', command.box_id ? null : now(), command.id);
        this.deviceState = command.box_id ? 'AWAITING_CONFIRMATION' : 'READY';
      });
    } catch (error) {
      controller.abort();
      this.transaction(() => {
        this.db.prepare("UPDATE tasks SET status='FAILED', error=?, finished_at=? WHERE id=?")
          .run(error.name === 'AbortError' ? '任务停止或超时，位置待核对' : error.message, now(), command.id);
        if (command.box_id) this.db.prepare("UPDATE boxes SET state='UNKNOWN' WHERE id=?").run(command.box_id);
        this.deviceState = 'RECOVERY_REQUIRED';
      });
    } finally {
      clearTimeout(timer);
      this.active = null;
    }
  }
  stop() {
    this.device.stop?.();
    this.active?.controller.abort();
    this.transaction(() => {
      const pending = this.pendingTask();
      if (pending) {
        this.db.prepare("UPDATE tasks SET status='FAILED',error=?,finished_at=? WHERE id=?").run('已停止，盒子位置待核对', now(), pending.id);
        this.db.prepare("UPDATE boxes SET state='UNKNOWN' WHERE id=?").run(pending.box_id);
      }
      this.deviceState = 'RECOVERY_REQUIRED';
    });
    return { message: '已请求停止；需核对状态后恢复。网页停止不能代替实体急停。' };
  }
  confirmTask(id, { confirmed } = {}) {
    assert(confirmed === true, '需要确认实际盒子位置');
    assert(!this.active && this.deviceState === 'AWAITING_CONFIRMATION', '当前没有可确认的取回件任务', 409);
    const task = this.pendingTask();
    assert(task?.id === id, '确认任务与当前任务不一致', 409);
    const box = this.boxes().find(b => b.id === task.box_id);
    this.transaction(() => {
      this.db.prepare('UPDATE boxes SET state=?,last_location=? WHERE id=?')
        .run(task.action === 'FETCH' ? 'PRESENTED' : 'STORED', task.action === 'FETCH' ? 'PICKUP' : box.slot_id, box.id);
      this.db.prepare('INSERT INTO events(task_id,seq,phase,sensors,created_at) VALUES (?,?,?,?,?)')
        .run(id, PHASES[task.action].length + 1, 'OPERATOR_CONFIRMED', JSON.stringify({ evidence: 'operator', confirmed: true }), now());
      this.db.prepare("UPDATE tasks SET status='SUCCEEDED',phase='OPERATOR_CONFIRMED',finished_at=? WHERE id=?").run(now(), id);
      this.deviceState = 'READY';
    });
    return this.getTask(id);
  }
  resetSimulation({ confirmed } = {}) {
    assert(this.device.mode === 'simulation', '仅模拟模式允许重置');
    assert(!this.active, '请等待任务停止', 409);
    assert(!this.pendingTask(), '请先确认盒子位置，或停止当前任务再恢复', 409);
    assert(confirmed === true, '需要确认重置模拟盒子位置');
    this.transaction(() => {
      this.db.exec("UPDATE boxes SET state='STORED', last_location=slot_id");
      this.deviceState = 'UNHOMED';
    });
    return { message: '模拟盒子已全部归位，历史记录保留；请重新确认机械原点。' };
  }
  recoverHardware({ confirmed_all_stored } = {}) {
    assert(this.device.mode === 'hardware', '仅真实设备模式使用人工恢复');
    assert(!this.active && !this.pendingTask(), '仍有任务未结束，不能恢复', 409);
    assert(confirmed_all_stored === true, '需要确认所有料盒均已人工放回对应格口');
    this.transaction(() => {
      this.db.exec("UPDATE boxes SET state='STORED', last_location=slot_id");
      this.deviceState = 'UNHOMED';
    });
    return { message: '盒位已按人工检查恢复；请重新确认机械原点。' };
  }
  interpret(text) {
    assert(typeof text === 'string' && text.trim() && text.length <= 200, '请输入 1–200 字的指令');
    const input = normalize(text);
    if (/(不要|别拿|别取|取消|停止|别放|别回)/.test(input)) return { action: null, candidates: [], message: '未执行动作。停止任务请使用停止按钮。' };
    const hasReturn = /(放回|归还|回件)/.test(input);
    const hasFetch = /(拿|取出|取件|取一下)/.test(input);
    if ((hasReturn && hasFetch) || /(然后|再拿|再取|同时|并且|以及)/.test(input)) return { action: null, candidates: [], message: '每次请只指定一个动作和一个盒子。' };
    const action = hasReturn ? 'RETURN' : hasFetch ? 'FETCH' : 'QUERY';
    const boxes = this.boxes();
    if (action === 'RETURN' && /^(请|帮我)?(放回|归还|回件)(当前盒|当前盒子|这个盒子|这个|零件盒|盒子)?$/.test(input)) {
      const candidates = boxes.filter(b => b.state === 'PRESENTED');
      return { action, candidates, message: candidates.length ? '请确认取物口已让开，再执行归还。' : '取物口没有待归还盒子。' };
    }
    const match = input.match(/(?:b0?([1-9]\d*)|([一二三四五六123456789])号盒)/);
    const boxNumber = match ? Number(match[1] || ('一二三四五六'.indexOf(match[2]) + 1 || match[2])) : null;
    const term = input.replace(/^(请)?(帮我)?(拿出|拿取|拿|取出|取件|取一下|查找|查询|放回|归还)/, '').replace(/(在哪儿|在哪里|在哪|的位置|给我)$/, '');
    let candidates = boxNumber ? boxes.filter(b => b.id === `B0${boxNumber}`) : [];
    if (!boxNumber && term) {
      candidates = boxes.filter(b => [b.name, ...b.aliases].some(a => normalize(a) === term));
      if (!candidates.length) candidates = boxes.filter(b => [b.name, ...b.aliases].some(a => normalize(a).includes(term)));
    }
    return { action, candidates, message: candidates.length > 1 ? '匹配到多个盒子，请选择。' : candidates.length ? '已找到对应零件盒。' : '当前仅启用 B01、B02；请尝试零件名称、别名或“一号盒”。' };
  }
  async close() { if (this.active) this.active.controller.abort(); await this.running; this.device.close?.(); this.db.close(); }
}
