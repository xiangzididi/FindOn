import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Cabinet } from '../lib/cabinet.js';
import { SimulatedDevice, JsonLineDevice, UsbSerialDevice } from '../lib/device.js';
import { createServer } from '../server.js';

function create(t, options = {}) {
  const app = new Cabinet(':memory:', { device: new SimulatedDevice({ stepMs: 1 }), ...options });
  t.after(() => app.close()); return app;
}
async function submit(app, action, box_id = null, extra = {}) {
  const task = app.submit({ action, box_id, request_id: randomUUID(), area_clear: true, ...extra });
  await app.running; if (app.getTask(task.id).status === "AWAITING_CONFIRMATION") app.confirmTask(task.id, {confirmed:true}); return app.getTask(task.id);
}
const home = app => submit(app, 'HOME');

test('统一取物区：先完全离柜再左移，回件先回到原格', async t => {
  const app=create(t); await home(app);
  const fetch=await submit(app,'FETCH','B02');
  const phases=fetch.events.map(e=>e.phase);
  assert.ok(phases.indexOf('TRANSFER_READY') < phases.indexOf('MOVING_TO_PICKUP'));
  assert.equal(fetch.events.find(e=>e.phase==='PICKUP_REACHED').sensors.location,'PICKUP');
  const returned=await submit(app,'RETURN','B02',{area_clear:true});
  assert.equal(returned.events.find(e=>e.phase==='SLOT_REACHED').sensors.slot_id,'S02');
  assert.ok(returned.events.findIndex(e=>e.phase==='SLOT_REACHED') < returned.events.findIndex(e=>e.phase==='PUSHING'));
});

test('未确认离柜或未到取物区不能记为成功', async t => {
  for (const badPhase of ['TRANSFER_READY','PICKUP_REACHED']) {
    const simulator=new SimulatedDevice({stepMs:1});
    const app=create(t,{device:{mode:'simulation',execute(cmd,emit,signal){
      return simulator.execute(cmd,event=>emit(event.phase===badPhase?{...event,sensors:{}}:event),signal);
    }}});
    await home(app);
    const result=await submit(app,'FETCH','B01');
    assert.equal(result.status,'FAILED');
    assert.equal(app.boxes().find(b=>b.id==='B01').state,'UNKNOWN');
  }
});

test('两格配置保留旧盒记录，归档未知位置阻止回零', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cabinet-legacy-'));
  const path = join(dir, 'test.sqlite');
  const app = new Cabinet(path);
  app.db.prepare('INSERT INTO boxes VALUES (?,?,?,?,?,?,?,?)').run('B03','S03',0,2,'旧零件','[]','UNKNOWN','S03');
  await app.close();
  const reopened = new Cabinet(path);
  t.after(async () => { await reopened.close(); rmSync(dir,{recursive:true,force:true}); });
  assert.equal(reopened.boxes().length,2);
  assert.equal(reopened.snapshot().archived_box_count,1);
  assert.equal(reopened.boxes(false).find(b=>b.id==='B03').name,'旧零件');
  assert.throws(()=>reopened.submit({action:'HOME',request_id:'blocked'}),/恢复/);
});

test('横移路径确认缺失时拒绝继续', async t => {
  const app = create(t,{device:{mode:'simulation',async execute(command,onEvent) {
    onEvent({task_id:command.id,seq:1,phase:'E_CLEAR',sensors:{e_clear:false}});
  }}});
  app.deviceState = 'READY';
  assert.match((await submit(app,'FETCH','B01')).error,/未确认让开/);
  assert.equal(app.deviceState,'RECOVERY_REQUIRED');
});

test('轴到位后停止仍将盒子标记未知，不能晚确认成功', async t => {
  const app=create(t); await home(app);
  const task=app.submit({action:'FETCH',box_id:'B02',area_clear:true,request_id:'pending-stop'});
  await app.running;
  assert.equal(app.getTask(task.id).status,'AWAITING_CONFIRMATION');
  app.stop();
  assert.equal(app.boxes().find(b=>b.id==='B02').state,'UNKNOWN');
  assert.throws(()=>app.confirmTask(task.id,{confirmed:true}),/没有可确认/);
});

test('完整取回闭环仅在完成回执后更新位置', async t => {
  const app = create(t);
  assert.throws(() => app.submit({ action: 'FETCH', area_clear: true, box_id: 'B01', request_id: 'before-home' }), /原点/);
  await home(app);
  const task = app.submit({ action: 'FETCH', area_clear: true, box_id: 'B01', request_id: 'fetch' });
  assert.equal(app.boxes().find(b => b.id === 'B01').state, 'IN_TRANSIT');
  await app.running;
  assert.equal(app.getTask(task.id).status, 'AWAITING_CONFIRMATION');
  assert.equal(app.boxes()[0].state, 'IN_TRANSIT');
  assert.throws(() => app.confirmTask('wrong', {confirmed:true}), /不一致/);
  assert.throws(() => app.submit({action:'HOME',request_id:'pending'}), /先确认/);
  app.confirmTask(task.id, {confirmed:true});
  assert.equal(app.getTask(task.id).status, 'SUCCEEDED');
  assert.equal(app.boxes().find(b => b.id === 'B01').state, 'PRESENTED');
  assert.throws(() => app.submit({ action: 'FETCH', area_clear: true, box_id: 'B02', request_id: 'another' }), /归还/);
  assert.throws(() => app.submit({ action: 'RETURN', box_id: 'B01', request_id: 'unclear' }), /手已离开/);
  assert.equal((await submit(app, 'RETURN', 'B01', { area_clear: true })).status, 'SUCCEEDED');
  assert.ok(app.boxes().every(b => b.state === 'STORED'));
});

test('重复请求复用任务，变更参数则拒绝', async t => {
  const app = create(t); await home(app);
  const input = { action: 'FETCH', area_clear: true, box_id: 'B02', request_id: 'same' };
  const first = app.submit(input);
  assert.equal(app.submit(input).id, first.id);
  assert.throws(() => app.submit({ ...input, box_id: 'B01' }), /不同任务/);
  assert.throws(() => app.submit({ ...input, request_id: 'new' }), /正在执行/);
  await app.running;
  assert.equal(app.submit(input).id, first.id);
  assert.equal(app.snapshot().tasks.length, 2);
});

test('故障保留位置并禁止自动继续；恢复不删除历史', async t => {
  const app = create(t); await home(app);
  const result = await submit(app, 'FETCH', 'B01', { fault_at: 'EXTRACTION_REACHED' });
  assert.equal(result.status, 'FAILED');
  const box = app.boxes().find(b => b.id === 'B01');
  assert.equal(box.state, 'UNKNOWN'); assert.equal(box.last_location, 'S01');
  assert.equal(app.deviceState, 'RECOVERY_REQUIRED');
  assert.throws(() => app.submit({ action: 'HOME', request_id: 'unsafe' }), /恢复/);
  assert.throws(() => app.resetSimulation({ confirmed: false }), /确认/);
  app.resetSimulation({ confirmed: true });
  assert.equal(app.deviceState, 'UNHOMED'); assert.equal(app.snapshot().tasks.length, 2);
});

test('停止任务后不会晚到成功', async t => {
  const app = create(t, { device: new SimulatedDevice({ stepMs: 10 }) }); await home(app);
  const task = app.submit({ action: 'FETCH', area_clear: true, box_id: 'B01', request_id: 'stop' });
  app.stop(); await app.running;
  assert.equal(app.getTask(task.id).status, 'FAILED'); assert.equal(app.deviceState, 'RECOVERY_REQUIRED');
});

test('超时和缺少传感器回执均不能显示成功', async t => {
  const slow = create(t, { device: new SimulatedDevice({ stepMs: 100 }), timeoutMs: 5 });
  assert.equal((await home(slow)).status, 'FAILED');
  const incomplete = create(t, { device: { mode: 'simulation', async execute() {} } });
  assert.match((await home(incomplete)).error, /缺少完整/);
  const invalid = create(t, { device: { mode: 'simulation', async execute(command, onEvent) {
    onEvent({ task_id: command.id, seq: 1, phase: 'REFERENCE_ACCEPTED' });
    onEvent({ task_id: command.id, seq: 2, phase: 'HOME_CONFIRMED', sensors: {} });
  } } });
  assert.match((await home(invalid)).error, /回零确认不足/);
});

test('数据持久化；服务重启保留在外盒子并要求恢复', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cabinet-test-'));
  const path = join(dir, 'test.sqlite');
  const app = new Cabinet(path, { device: new SimulatedDevice({ stepMs: 1 }) });
  app.editBox('B01', { name: '测试螺母', aliases: ['别名'] }); await home(app); await submit(app, 'FETCH', 'B01'); await app.close();
  const reopened = new Cabinet(path); t.after(async () => { await reopened.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(reopened.boxes().find(b => b.id === 'B01').name, '测试螺母');
  assert.equal(reopened.boxes().find(b => b.id === 'B01').state, 'PRESENTED');
  assert.equal(reopened.deviceState, 'RECOVERY_REQUIRED');
});

test('重启识别未完成任务，不盲目重放', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cabinet-test-'));
  const path = join(dir, 'test.sqlite'); const app = new Cabinet(path);
  app.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)').run('interrupted', 'request', 'FETCH', 'B01', 'RUNNING', 'PULLING', null, new Date().toISOString(), null);
  app.db.prepare("UPDATE boxes SET state='IN_TRANSIT' WHERE id='B01'").run(); await app.close();
  const reopened = new Cabinet(path); t.after(async () => { await reopened.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(reopened.getTask('interrupted').status, 'INTERRUPTED');
  assert.equal(reopened.boxes().find(b => b.id === 'B01').state, 'UNKNOWN');
  assert.equal(reopened.deviceState, 'RECOVERY_REQUIRED');
});

test('名称、别名、中文盒号与歧义选择', async t => {
  const app = create(t);
  assert.equal(app.interpret('拿 M3 螺母').candidates[0].id, 'B01');
  assert.equal(app.interpret('拿三号盒').candidates.length, 0);
  assert.equal(app.interpret('拿 6 号盒').candidates.length, 0);
  assert.equal(app.interpret('拿螺丝').candidates.length, 1);
  assert.equal(app.interpret('杜邦线在哪').action, 'QUERY');
  assert.equal(app.interpret('拿连接线').candidates.length, 0);
  assert.equal(app.interpret('不要拿螺母').action, null);
  assert.equal(app.interpret('拿螺丝然后放回').action, null);
  assert.equal(app.interpret('拿不存在的东西').candidates.length, 0);
  assert.equal(app.interpret('放回当前盒').candidates.length, 0);
  await home(app); await submit(app, 'FETCH', 'B02');
  assert.equal(app.interpret('放回当前盒').candidates[0].id, 'B02');
  assert.equal(app.interpret('放回二号盒').candidates[0].id, 'B02');
});

class FakeStream extends EventEmitter { writes = []; write(line) { this.writes.push(JSON.parse(line)); } }
test('JSONL 适配器支持分片；ACK 不完成任务，忽略其他任务消息', async () => {
  const stream = new FakeStream(); const device = new JsonLineDevice(stream); const events = [];
  let completed = false;
  const pending = device.execute({ id: 'T1', action: 'HOME', slot_id: null }, e => events.push(e), new AbortController().signal).then(() => { completed = true; });
  stream.emit('data', Buffer.from('{"type":"ack","task_id":"T1",'));
  stream.emit('data', Buffer.from('"accepted":true}\n{"type":"result","task_id":"T0","success":true}\n'));
  await Promise.resolve(); assert.equal(completed, false);
  stream.emit('data', Buffer.from('{"type":"event","task_id":"T1","seq":1,"phase":"HOMING"}\n'));
  stream.emit('data', Buffer.from('{"type":"result","task_id":"T1","success":true}\n'));
  await pending; assert.equal(events.length, 1); assert.equal(stream.listenerCount('data'), 0);
});

test('JSONL 断连、超时、停止均失败并清理监听', async () => {
  const stream = new FakeStream(); const device = new JsonLineDevice(stream, { timeoutMs: 5 });
  await assert.rejects(device.execute({ id: 'T1', action: 'HOME' }, () => {}, new AbortController().signal), /超时/);
  assert.equal(stream.writes.at(-1).type, 'stop');
  const disconnected = device.execute({ id: 'T2', action: 'HOME' }, () => {}, new AbortController().signal);
  stream.emit('close'); await assert.rejects(disconnected, /断开/);
  const controller = new AbortController();
  const stopped = device.execute({ id: 'T3', action: 'HOME' }, () => {}, controller.signal);
  controller.abort(); await assert.rejects(stopped, /停止/);
  assert.equal(stream.listenerCount('data'), 0);
});

test('JSONL 中文 UTF-8 字节分片不会损坏错误消息', async () => {
  const stream = new FakeStream(); const device = new JsonLineDevice(stream);
  const pending = device.execute({ id: 'T1', action: 'HOME' }, () => {}, new AbortController().signal);
  const expected = assert.rejects(pending, /盒子卡住/);
  const bytes = Buffer.from('{"type":"result","task_id":"T1","success":false,"error":"盒子卡住"}\n');
  for (const byte of bytes) stream.emit('data', Buffer.from([byte]));
  await expected;
});

class FakeTransport extends EventEmitter {
  writes = [];
  connected = false;
  start() { this.connected = true; this.emit('open'); }
  info() { return { bridge_connected: this.connected, serial_port: 'COM-TEST', baud: 115200, bridge_error: null }; }
  write(data) { this.writes.push(data); }
  close() { this.connected = false; this.emit('close'); }
}

test('USB 设备先完成协议握手，再发送业务级指令', async () => {
  const transport = new FakeTransport();
  const device = new UsbSerialDevice(transport, { probeMs: 60000, timeoutMs: 1000 });
  device.start();
  assert.equal(JSON.parse(transport.writes[0]).type, 'status');
  transport.emit('data', Buffer.from(`${JSON.stringify({ v: 1, type: 'status', protocol: 'partgo-serial-v1',
    node: 'ESP32-S3', firmware: 'test', state: 'UNREFERENCED', motion_configured: true,
    referenced: false, config_version: 4, slots: [] })}\n`));
  assert.equal(device.info().verified, true);
  const events = [];
  const pending = device.execute({ id: 'T-USB', action: 'HOME', area_clear: true,
    manual_reference_confirmed: true }, event => events.push(event), new AbortController().signal);
  const command = JSON.parse(transport.writes.at(-1));
  assert.equal(command.cmd, 'REFERENCE');
  assert.equal(command.manual_reference_confirmed, true);
  transport.emit('data', Buffer.from('{"v":1,"type":"ack","task_id":"T-USB","accepted":true}\n'));
  transport.emit('data', Buffer.from('{"v":1,"type":"event","task_id":"T-USB","seq":1,"phase":"REFERENCE_ACCEPTED","sensors":{}}\n'));
  transport.emit('data', Buffer.from('{"v":1,"type":"result","task_id":"T-USB","success":true,"state":"READY"}\n'));
  await pending;
  assert.equal(events.length, 1);
  device.close();
});

test('真实设备故障后只有人工确认全部归位才能恢复', t => {
  const device = { mode: 'hardware', info: () => ({ connected: true, verified: true, motion_configured: true }), close() {} };
  const app = new Cabinet(':memory:', { device });
  t.after(() => app.close());
  app.db.prepare("UPDATE boxes SET state='UNKNOWN' WHERE id='B01'").run();
  app.deviceState = 'RECOVERY_REQUIRED';
  assert.throws(() => app.recoverHardware({ confirmed_all_stored: false }), /需要确认/);
  app.recoverHardware({ confirmed_all_stored: true });
  assert.equal(app.deviceState, 'UNHOMED');
  assert.ok(app.boxes().every(box => box.state === 'STORED'));
});

test('HTTP 页面、状态、互斥、输入校验与任务接口', async t => {
  const app = create(t); const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.match(await (await fetch(base)).text(), /PartGo/);
  const state = await (await fetch(`${base}/api/state`)).json(); assert.equal(state.boxes.length, 2);
  const post = (path, data, token = state.token) => fetch(`${base}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cabinet-Token': token }, body: JSON.stringify(data) });
  assert.equal((await post('/device/home', {}, 'wrong')).status, 403);
  assert.equal((await post('/tasks', null)).status, 400);
  assert.equal((await post('/tasks', { action: 'FLY', request_id: 'x' })).status, 400);
  assert.equal((await post('/device/home', { request_id: 'home' })).status, 202); await app.running;
  assert.equal((await post('/tasks', { action: 'FETCH', area_clear: true, box_id: 'B01', request_id: 'fetch' })).status, 202); await app.running;
  assert.equal((await post('/tasks', { action: 'FETCH', area_clear: true, box_id: 'B02', request_id: 'bad' })).status, 409);
  app.confirmTask(app.pendingTask().id, {confirmed:true});
  assert.equal((await post('/tasks', { action: 'RETURN', box_id: 'B01', request_id: 'return', area_clear: true })).status, 202); await app.running;
  assert.equal((await fetch(`${base}/api/tasks/missing`)).status, 404);
});
