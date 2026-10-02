const $ = id => document.getElementById(id);
const names = { UNHOMED: '待回零', HOMING: '回零中', READY: '就绪', BUSY: '执行中', AWAITING_CONFIRMATION: '待人工确认', RECOVERY_REQUIRED: '待恢复', STORED: '在库', PRESENTED: '已送达', IN_TRANSIT: '取放中', UNKNOWN: '待核对', RUNNING: '执行中', SUCCEEDED: '已完成', FAILED: '失败', INTERRUPTED: '已中断', FETCH: '取件', RETURN: '回件', HOME: '回零' };
let state, token, editing, alignmentBox, submitting = false, online = false, currentPickup = null;
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
function notify(message, error = false) { $('notice').hidden = false; $('notice').textContent = message; $('notice').className = `notice${error ? ' error' : ''}`; }
async function api(path, body, method = 'POST') {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Cabinet-Token': token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function canFetch() { return online && state?.device_state === 'READY' && !state.active_task_id && state.boxes.every(b => b.state === 'STORED') && !submitting; }
function render() {
  const pickup = state.boxes.find(b => b.state === 'PRESENTED');
  if (currentPickup !== pickup?.id) { $('areaClear').checked = false; currentPickup = pickup?.id; }
  $('storedCount').textContent = state.boxes.filter(b => b.state === 'STORED').length;
  $('slotCount').textContent = `盒在库 / ${state.layout.slots.length} 个柜格`;
  $('layoutLabel').textContent = `${state.layout.rows} 行 × ${state.layout.columns} 列 · 两轴自动选格`;
  $('deviceState').textContent = names[state.device_state] || state.device_state;
  $('boxes').innerHTML = state.boxes.map(b => `<article class="box ${b.state === 'STORED' ? '' : b.state === 'UNKNOWN' ? 'unknown' : 'out'}"><div class="box-top"><span>${escape(b.slot_id)} · ${b.row + 1}排${b.col + 1}列</span><span>${names[b.state]}</span></div><div class="box-number">${b.id}</div><div class="box-name" title="${escape(b.name)}">${escape(b.name)}</div><div class="box-alias">${escape(b.aliases.join(' · '))}</div><div class="box-actions"><button data-fetch="${b.id}" ${canFetch() ? '' : 'disabled'}>取到手边</button><button class="edit" aria-label="编辑 ${escape(b.name)}" data-edit="${b.id}" ${state.active_task_id || state.pending_task_id || !online ? 'disabled' : ''}>编辑</button></div></article>`).join('');
  $('pickupVisual').textContent = pickup ? '▣' : '▱';
  $('pickupTitle').textContent = pickup ? `${pickup.id} · ${pickup.name}` : state.device_state === 'RECOVERY_REQUIRED' ? '盒子位置需要核对' : '取物口暂无零件盒';
  $('pickupDetail').textContent = pickup ? '已送达左侧取物区。取用后，平台会将盒子送回原格。' : state.device_state === 'UNHOMED' ? '请在下方设备调试中完成模拟回零。' : state.device_state === 'RECOVERY_REQUIRED' ? '查看任务记录，在调试区恢复模拟状态。' : state.pending_task_id ? '轴已停止；请在下方确认盒子实际位置。' : state.active_task_id ? '机构正在执行任务，请稍候。' : '选择需要的零件，自动选格后抽盒。';
  $('areaClear').disabled = !pickup || state.device_state !== 'READY' || !online;
  $('returnButton').disabled = !pickup || !online || state.device_state !== 'READY' || !$('areaClear').checked || submitting;
  $('homeButton').disabled = !online || !!state.active_task_id || state.device_state === 'RECOVERY_REQUIRED' || state.boxes.some(b => b.state !== 'STORED');
  $('resetButton').disabled = !online || !!state.active_task_id || !!state.pending_task_id;
  $('stopButton').disabled = !online;
  const task = state.tasks[0];
  $('taskTitle').textContent = task ? `${names[task.action]} ${task.box_id || ''} · ${names[task.status]}` : '等待任务';
  $('taskDetail').textContent = task ? (task.error || task.phase_label) : '每次处理一个盒子';
  $('progressBar').style.width = task ? `${Math.min(100, task.events.length / (state.phases[task.action].length + (task.action === 'HOME' ? 0 : 1)) * 100)}%` : '0%';
  const pending = state.tasks.find(t => t.id === state.pending_task_id);
  $('confirmationPanel').hidden = !pending;
  $('confirmationText').textContent = pending ? pending.action === 'FETCH' ? `${pending.box_id}：确认盒子已送达左侧取物区，并有托盘支撑。` : `${pending.box_id}：确认盒子完整归位；结束取放后脱钩，才能换格。` : '';
  $('confirmPosition').disabled = !online || submitting;
  $('events').innerHTML = task ? task.events.slice(-4).map(e => `<li><span>${escape(e.phase_label)}</span>${time(e.created_at)}</li>`).join('') : '';
  $('history').innerHTML = state.tasks.length ? state.tasks.map(t => `<tr><td>${time(t.created_at)}</td><td>${names[t.action]}</td><td>${t.box_id || '—'}</td><td>${names[t.status]}</td><td>${escape(t.error || t.phase_label)}</td></tr>`).join('') : '<tr><td colspan="5">还没有任务，完成回零后开始第一次取件。</td></tr>';
}
async function refresh() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('连接失败');
    state = await response.json(); token = state.token; online = true;
    $('connection').textContent = '● 本地服务在线'; render();
  } catch { online = false; $('connection').textContent = '服务已断开'; if (state) render(); }
}
async function task(action, box_id, aligned_slot_id = null) {
  if (submitting || !online) return;
  submitting = true; render();
  try {
    const payload = { action, box_id, request_id: crypto.randomUUID(), aligned_slot_id,
      area_clear: action === 'FETCH' ? $('alignmentChecked').checked : $('areaClear').checked };
    if (action === 'FETCH' && $('injectFault').checked) { payload.fault_at = 'EXTRACTION_REACHED'; $('injectFault').checked = false; }
    const result = await api('/tasks', payload);
    notify(`${names[action]}任务已接收：${result.box_id || '设备'}。以执行结果为准。`);
    $('interpretation').hidden = true;
  } catch (error) { notify(error.message, true); }
  finally { submitting = false; await refresh(); }
}
function beginFetch(boxId) {
  if (!canFetch()) { notify('请先回零、归还当前盒子或完成位置确认。', true); return; }
  alignmentBox = state.boxes.find(b => b.id === boxId);
  $('alignmentTitle').textContent = `取出 ${alignmentBox.slot_id} · ${alignmentBox.name}`;
  $('alignmentChecked').checked = false;
  $('alignmentDialog').showModal();
}
$('alignmentForm').onsubmit = event => {
  event.preventDefault();
  if (!$('alignmentChecked').checked) return;
  $('alignmentDialog').close(); task('FETCH', alignmentBox.id, alignmentBox.slot_id);
};
$('cancelAlignment').onclick = () => $('alignmentDialog').close();
$('confirmPosition').onclick = async () => {
  if (!state.pending_task_id || submitting) return;
  submitting = true;
  try { await api(`/tasks/${state.pending_task_id}/confirm`, { confirmed: true }); notify('已按人工确认更新盒子位置。'); }
  catch (error) { notify(error.message, true); }
  finally { submitting = false; await refresh(); }
};
$('boxes').addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.fetch) beginFetch(button.dataset.fetch);
  if (button.dataset.edit) {
    editing = button.dataset.edit; const box = state.boxes.find(b => b.id === editing);
    $('editBoxId').textContent = `${box.id} / ${box.slot_id}`; $('editName').value = box.name;
    $('editAliases').value = box.aliases.join('，'); $('editError').textContent = ''; $('editDialog').showModal();
  }
});
$('editForm').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api(`/boxes/${editing}`, { name: $('editName').value, aliases: $('editAliases').value.split(/[,，]/).map(s => s.trim()).filter(Boolean) }, 'PATCH'); $('editDialog').close(); await refresh(); }
  catch (error) { $('editError').textContent = error.message; }
});
$('cancelEdit').onclick = () => $('editDialog').close();
$('areaClear').onchange = () => render();
$('returnButton').onclick = () => { const box = state.boxes.find(b => b.state === 'PRESENTED'); if (box) task('RETURN', box.id); };
$('homeButton').onclick = () => task('HOME', null);
$('stopButton').onclick = async () => { try { notify((await api('/device/stop', {})).message); await refresh(); } catch (error) { notify(error.message, true); } };
$('resetButton').onclick = async () => {
  if (!confirm('把模拟盒子位置恢复为全部在库？零件信息和历史记录会保留。')) return;
  try { notify((await api('/simulation/reset', { confirmed: true })).message); await refresh(); } catch (error) { notify(error.message, true); }
};
async function interpret() {
  try {
    const result = await api('/interpret', { text: $('command').value });
    const container = $('interpretation'); container.hidden = false; container.replaceChildren();
    const message = document.createElement('p'); message.textContent = result.message; container.append(message);
    result.candidates.forEach(box => {
      const row = document.createElement('div'); row.className = 'candidate';
      const text = document.createElement('span'); text.textContent = `${box.name} · ${box.id} / ${box.slot_id} · ${names[box.state]}`; row.append(text);
      if (['FETCH', 'RETURN'].includes(result.action)) {
        const button = document.createElement('button'); button.textContent = result.action === 'FETCH' ? '确认取件' : '确认回件';
        button.onclick = () => {
          if (result.action === 'RETURN' && !$('areaClear').checked) { notify('请先勾选“取用完成，手已离开取物口”。', true); return; }
          if (result.action === 'FETCH') beginFetch(box.id);
          else task(result.action, box.id);
        };
        row.append(button);
      }
      container.append(row);
    });
  } catch (error) { notify(error.message, true); }
}
$('commandForm').onsubmit = event => { event.preventDefault(); interpret(); };
document.querySelectorAll('[data-example]').forEach(button => button.onclick = () => { $('command').value = button.dataset.example; interpret(); });
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!Recognition) {
  $('voiceButton').disabled = true; $('voiceHint').textContent = '当前浏览器未提供语音识别，请使用文字指令。';
} else {
  const recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false; recognition.continuous = false;
  $('voiceButton').onclick = () => {
    try { recognition.start(); $('voiceButton').disabled = true; $('voiceButton').textContent = '正在聆听…'; }
    catch (error) { notify(`无法启动麦克风：${error.message}`, true); }
  };
  recognition.onresult = event => { $('command').value = event.results[0][0].transcript; interpret(); };
  recognition.onerror = event => notify(`语音识别未完成（${event.error}），可改用文字输入。`, true);
  recognition.onend = () => { $('voiceButton').disabled = false; $('voiceButton').textContent = '语音输入'; };
}
await refresh();
async function poll() { await refresh(); setTimeout(poll, 800); }
setTimeout(poll, 800);
