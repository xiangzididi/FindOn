const API_CONFIG = { pollMs: 700, uploadTimeout: 15000 };
const names = {
  UNHOMED: '待确认原点', HOMING: '建立原点中', READY: '就绪', BUSY: '执行中',
  AWAITING_CONFIRMATION: '待人工确认', RECOVERY_REQUIRED: '待恢复', CONFIG_LOCKED: '待标定',
  UNREFERENCED: '待确认原点', PRESENTED: '已送达', OFFLINE: '离线', STORED: '在库',
  IN_TRANSIT: '取放中', UNKNOWN: '待核对', RUNNING: '执行中', SUCCEEDED: '已完成',
  FAILED: '失败', INTERRUPTED: '已中断', FETCH: '取件', RETURN: '回件', HOME: '原点确认'
};
const phaseGroups = {
  REFERENCE_ACCEPTED: 'accepted', HOME_CONFIRMED: 'delivered', E_CLEAR: 'accepted',
  MOVING_TO_SLOT: 'locating', SLOT_REACHED: 'locating', DOCKING: 'pulling',
  DOCK_REACHED: 'pulling', HOOK_SHIFTING: 'pulling', HOOK_ENGAGED: 'pulling',
  PULLING: 'pulling', EXTRACTION_REACHED: 'pulling',
  TRANSFER_READY: 'transporting', MOVING_TO_PICKUP: 'transporting', PICKUP_REACHED: 'delivered',
  PUSHING: 'pulling', INSERTION_REACHED: 'pulling', UNHOOKING: 'pulling',
  HOOK_RELEASED: 'pulling', RETRACTING: 'transporting',
  OPERATOR_CONFIRMED: 'delivered'
};
const phaseCopy = {
  accepted: ['任务已接收', '本机服务已锁定本次任务'],
  locating: ['正在定位料盒', 'X 轴前往目标格口'],
  pulling: ['正在操作料盒', 'E 轴执行对接与抽拉'],
  transporting: ['正在运送料盒', '平台前往固定取物区'],
  delivered: ['机械动作已结束', '等待人工确认盒位'],
  returning: ['正在归还料盒', '料盒返回原始格口']
};

const els = Object.fromEntries([
  'homeButton', 'partSearch', 'partList', 'partListTitle', 'searchHint', 'voiceButton',
  'bomFileInput', 'bomDropzone', 'bomFileState', 'bomFileName', 'bomFileMeta', 'clearBomFile',
  'bomInput', 'parseBomButton', 'bomMatchBadge', 'importPlaceholder', 'importBomList',
  'confirmImportedPlan', 'importCount', 'planBack', 'planType', 'planTitle', 'planDescription',
  'planDuration', 'planCount', 'planListLabel', 'planBadge', 'planList', 'startPlan', 'planAreaClear',
  'executeTitle', 'executeSlot', 'executePart', 'queueProgress', 'queueStrip', 'coordX', 'coordE',
  'machineState', 'stageStatus', 'stageStatusDot', 'slotGrid', 'carrier', 'deliveryDock', 'timeline',
  'traySensor', 'interlock', 'stopButton', 'completeMark', 'completeTitle', 'completeDescription',
  'completeSlotVisual', 'completeSlot', 'completeTray', 'completeProgress', 'nextMaterial', 'nextPart',
  'nextSlot', 'returnButton', 'returnAreaClear', 'returnClearLabel', 'confirmStoredButton', 'newTaskButton',
  'statusMessage', 'settingsButton', 'infoDialog', 'inventoryEditor', 'saveInventoryButton', 'toastRegion',
  'devicePill', 'deviceName', 'deviceStatus', 'footerStatusLed', 'footerNode', 'hostLabel', 'readyCard',
  'readyStateTitle', 'readySlotState', 'readyLinkState', 'readyCommState', 'referenceButton',
  'referenceDialog', 'referenceForm', 'referenceConfirmed', 'closeReference'
].map(id => [id, document.getElementById(id)]));

const state = {
  view: 'request', snapshot: null, token: null, backendOnline: false, parts: [],
  planItems: [], importedPlan: null, projectMeta: null, mode: null, activeIndex: 0,
  currentTaskId: null, handledTaskKey: null, phase: 'idle', submitting: false,
  bomImporting: false, editingInventory: false
};

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function showView(name) {
  state.view = name;
  document.querySelectorAll('.app-view').forEach(view => view.classList.toggle('active', view.dataset.view === name));
  const current = name === 'request' ? 0 : ['plan', 'execute', 'complete'].indexOf(name) + 1;
  document.querySelectorAll('.flow-step').forEach((step, index) => {
    step.classList.toggle('active', index === current);
    step.classList.toggle('done', index < current);
  });
  history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function readJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function api(path, body, method = 'POST') {
  const options = { method, headers: { 'X-Cabinet-Token': state.token } };
  if (body instanceof FormData) options.body = body;
  else {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return readJsonResponse(await fetch(`/api${path}`, options));
}

function slotPosition(slot) {
  return { x: slot.column === 0 ? 20 : 80, y: slot.row === 0 ? 67 : 20 };
}

function syncParts() {
  if (!state.snapshot || state.editingInventory) return;
  const slots = new Map(state.snapshot.layout.slots.map(slot => [slot.id, slot]));
  state.parts = state.snapshot.boxes.map(box => {
    const position = slotPosition(slots.get(box.slot_id) || { row: box.row, column: box.col });
    return { id: box.id, name: box.name, alias: box.aliases, slot: box.slot_id,
      category: `${box.id} · ${names[box.state] || box.state}`, state: box.state, ...position };
  });
}

function currentPart() {
  const planned = state.planItems[state.activeIndex] || state.planItems[0];
  if (planned) return planned;
  const taskId = state.currentTaskId || state.snapshot?.active_task_id || state.snapshot?.pending_task_id;
  const task = taskId ? state.snapshot?.tasks.find(item => item.id === taskId) : null;
  return state.parts.find(part => part.id === task?.box_id) || null;
}

function hardwareUsable() {
  const snapshot = state.snapshot;
  if (!snapshot) return false;
  if (snapshot.mode === 'simulation') return true;
  return snapshot.device?.connected && snapshot.device?.verified && snapshot.device?.motion_configured;
}

function canFetch() {
  return state.backendOnline && hardwareUsable() && state.snapshot?.device_state === 'READY' &&
    !state.snapshot.active_task_id && !state.snapshot.pending_task_id &&
    state.snapshot.boxes.every(box => box.state === 'STORED') && !state.submitting;
}

function renderParts(query = '') {
  const normalized = query.trim().toLowerCase().replace(/[，。！？,.!?]/g, '');
  const matches = state.parts.filter(part => {
    const haystack = [part.name, part.slot, part.id, ...part.alias].join(' ').toLowerCase();
    return !normalized || haystack.includes(normalized) || normalized.includes(part.name.toLowerCase());
  });
  els.partListTitle.textContent = normalized ? `找到 ${matches.length} 个结果` : '当前可用零件';
  if (!matches.length) {
    els.partList.innerHTML = `<div class="no-results">没有找到“${escapeHtml(query)}”。可以修改关键词，或进入硬件库更新格口内容。</div>`;
    return;
  }
  els.partList.innerHTML = matches.map(part => `<button class="part-card" type="button" data-part="${part.id}" aria-disabled="${!canFetch() || part.state !== 'STORED'}"><span class="part-slot">${part.slot}</span><span><strong>${escapeHtml(part.name)}</strong><small>${escapeHtml(part.category)}</small></span><span class="stock"><b>${escapeHtml(names[part.state] || part.state)}</b></span></button>`).join('');
}

function renderSlots(target = currentPart()) {
  if (!state.snapshot) return;
  const boxes = new Map(state.snapshot.boxes.map(box => [box.slot_id, box]));
  els.slotGrid.innerHTML = state.snapshot.layout.slots.map(slot => {
    const box = boxes.get(slot.id);
    const enabled = slot.enabled !== false;
    return `<div class="slot${target?.slot === slot.id ? ' target' : ''}${enabled ? '' : ' disabled'}"><span class="slot-id">${slot.id}</span><span class="slot-name">${escapeHtml(box?.name || slot.name || '扩展格')}</span><span class="slot-meta">${enabled ? escapeHtml(box?.id || '已启用') : '2×2 扩展预留'}</span><span class="slot-count">${enabled ? escapeHtml(names[box?.state] || box?.state || '可用') : 'DISABLED'}</span></div>`;
  }).join('');
}

function findPart(query) {
  const normalized = String(query).trim().toLowerCase();
  if (!normalized) return null;
  return state.parts.find(part => normalized.includes(part.name.toLowerCase()) ||
    part.name.toLowerCase().includes(normalized) || normalized === part.slot.toLowerCase() ||
    normalized === part.id.toLowerCase() || part.alias.some(alias => normalized.includes(String(alias).toLowerCase())));
}

function renderDevice() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const device = snapshot.device || {};
  const simulation = snapshot.mode === 'simulation';
  const bridgeOnline = simulation || Boolean(device.connected);
  const verified = simulation || Boolean(device.verified);
  const configured = simulation || Boolean(device.motion_configured);
  const ready = configured && snapshot.device_state === 'READY';
  const stateName = names[device.state] || names[snapshot.device_state] || device.state || snapshot.device_state;

  els.devicePill.classList.toggle('online', bridgeOnline && verified && configured);
  els.devicePill.classList.toggle('offline', !bridgeOnline);
  els.devicePill.classList.toggle('simulator', simulation);
  els.devicePill.classList.remove('checking');
  els.readyCard.classList.toggle('online', ready);
  els.readyCard.classList.toggle('offline', !bridgeOnline);
  els.readyCard.classList.toggle('simulator', simulation);
  els.readyCard.classList.toggle('config-locked', bridgeOnline && verified && !configured);
  els.readyCard.classList.remove('checking');
  els.footerStatusLed.classList.toggle('offline', !bridgeOnline);
  els.deviceName.textContent = simulation ? 'SIM-NODE' : (device.node || 'ESP32-S3');
  els.deviceStatus.textContent = simulation ? '模拟' : !bridgeOnline ? '离线' : !verified ? '未验证' : !configured ? '待标定' : stateName;
  els.readySlotState.textContent = `${snapshot.active_slot_count} / ${snapshot.layout.slots.length}`;
  els.readyLinkState.textContent = simulation ? 'SIMULATOR' : bridgeOnline ? verified ? 'VERIFIED' : 'UNVERIFIED' : 'OFFLINE';
  els.readyCommState.textContent = simulation ? 'LOCAL' : device.serial_port || '--';
  els.footerNode.textContent = simulation ? 'PARTGO–SIMULATOR' : bridgeOnline ? 'PARTGO–USB' : 'PARTGO–NO DEVICE';
  els.hostLabel.textContent = simulation ? 'PC LOCAL' : device.serial_port || 'USB CDC';

  if (!bridgeOnline) {
    els.readyStateTitle.textContent = '控制器未连接';
    els.devicePill.title = device.reason || '请检查 USB、串口号和控制器固件';
  } else if (!verified) {
    els.readyStateTitle.textContent = '串口已打开 · 等待协议握手';
    els.devicePill.title = '串口有连接，但没有收到 partgo-serial-v1 握手';
  } else if (!configured) {
    els.readyStateTitle.textContent = '控制器在线 · 尚未完成标定';
    els.devicePill.title = '需要填写 E 轴比例与 S01/S02 的 X 坐标后重新编译固件';
  } else {
    els.readyStateTitle.textContent = ready ? '设备在线 · 可以执行' : `设备在线 · ${stateName}`;
    els.devicePill.title = device.firmware || '控制器握手已验证';
  }

  const knownStored = snapshot.boxes.every(box => box.state === 'STORED');
  const mayReference = bridgeOnline && verified && configured && !snapshot.active_task_id &&
    !snapshot.pending_task_id && ['UNHOMED', 'RECOVERY_REQUIRED'].includes(snapshot.device_state) &&
    (knownStored || snapshot.device_state === 'RECOVERY_REQUIRED');
  const needsReference = ['UNHOMED', 'RECOVERY_REQUIRED'].includes(snapshot.device_state) ||
    (!simulation && device.state === 'UNREFERENCED');
  els.referenceButton.classList.toggle('hidden', !needsReference && configured);
  els.referenceButton.disabled = !mayReference;
  els.referenceButton.textContent = !configured ? '待完成 E 轴与格口标定' : snapshot.device_state === 'RECOVERY_REQUIRED' ? '核对位置后恢复原点' : '确认机械原点';
  els.settingsButton.disabled = Boolean(snapshot.active_task_id || snapshot.pending_task_id);
  els.startPlan.disabled = !canFetch() || !els.planAreaClear.checked;
  document.querySelectorAll('[data-part], #confirmImportedPlan').forEach(control => {
    control.setAttribute('aria-disabled', String(!canFetch()));
  });
}

function renderBomRows(items, missing = []) {
  return [...items.map(part => `<div class="bom-row"><span>${part.slot}</span><div><strong>${escapeHtml(part.name)}</strong><small>${escapeHtml(part.category)}</small></div><b>可取用</b></div>`),
    ...missing.map(name => `<div class="bom-row missing"><span>—</span><div><strong>${escapeHtml(name)}</strong><small>当前启用格口中没有匹配项</small></div><b>缺少</b></div>`)].join('');
}

function parseImportedBom() {
  const lines = els.bomInput.value.split(/\n|,|，|;/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return toast('请先上传文件或粘贴配件清单。', 'warning');
  const matched = [], missing = [];
  for (const line of lines) {
    const query = line.replace(/[xX×*]\s*\d+.*$/g, '').replace(/\s+\d+\s*(个|件|只|条)?$/g, '').trim();
    if (!query || /^(?:序号\s*)?(?:零件|配件|器件|物料)?名称(?:\s*数量)?$/i.test(query)) continue;
    const part = findPart(query);
    if (part && !matched.some(item => item.slot === part.slot)) matched.push(part);
    else if (!part && !missing.includes(query)) missing.push(query);
  }
  state.importedPlan = { name: '导入项目清单', description: `匹配到 ${matched.length} 个可取用料盒。`, items: matched, missing };
  els.importPlaceholder.classList.add('hidden');
  els.importBomList.classList.remove('hidden');
  els.importBomList.innerHTML = renderBomRows(matched, missing);
  els.bomMatchBadge.textContent = `${matched.length} 可用 / ${missing.length} 缺少`;
  els.confirmImportedPlan.classList.toggle('hidden', matched.length === 0);
  els.importCount.textContent = `${matched.length} ITEMS`;
  renderDevice();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setBomImportBusy(busy) {
  state.bomImporting = busy;
  els.bomFileInput.disabled = busy;
  els.bomDropzone.classList.toggle('loading', busy);
  els.bomDropzone.setAttribute('aria-busy', String(busy));
  els.bomDropzone.querySelector('label').textContent = busy ? '识别中…' : '选择';
}

function resetBomImport() {
  els.bomFileInput.value = '';
  els.bomFileState.classList.add('hidden');
  els.bomInput.value = '';
  state.importedPlan = null;
  els.importPlaceholder.classList.remove('hidden');
  els.importBomList.classList.add('hidden');
  els.importBomList.innerHTML = '';
  els.bomMatchBadge.textContent = '等待识别';
  els.confirmImportedPlan.classList.add('hidden');
}

async function importBomFile(file) {
  if (!file || state.bomImporting) return;
  const extension = `.${file.name.split('.').pop()?.toLowerCase() || ''}`;
  if (!['.xlsx', '.xls', '.csv', '.txt'].includes(extension)) return toast('只支持 .xlsx、.xls、.csv 和 .txt 文件。', 'warning');
  if (file.size > 5 * 1024 * 1024) return toast('文件超过 5 MB。', 'warning');
  els.bomFileState.classList.remove('hidden');
  els.bomFileName.textContent = file.name;
  els.bomFileMeta.textContent = `${extension.slice(1).toUpperCase()} · ${formatFileSize(file.size)} · 正在识别`;
  setBomImportBusy(true);
  try {
    const form = new FormData();
    form.append('file', file, file.name);
    const data = await api('/bom/import', form);
    els.bomInput.value = data.lines.join('\n');
    els.bomFileMeta.textContent = `${extension.slice(1).toUpperCase()} · ${formatFileSize(file.size)} · 已识别 ${data.count} 条`;
    parseImportedBom();
    toast(`已识别 ${data.count} 条物料。`);
  } catch (error) {
    const messages = { spreadsheet_parser_unavailable: '本机缺少表格解析组件。', no_bom_items_found: '没有识别到有效零件。',
      upload_too_large: '文件超过 5 MB。', unsupported_file_type: '不支持该文件类型。' };
    const message = messages[error.message] || `文件识别失败：${error.message}`;
    els.bomFileMeta.textContent = message;
    toast(message, 'error');
  } finally { setBomImportBusy(false); }
}

function preparePartPlan(id) {
  const part = state.parts.find(item => item.id === id);
  if (!part) return false;
  if (!canFetch()) { toast('设备尚未就绪。请先完成连接、标定和原点确认。', 'error'); return false; }
  state.mode = 'part';
  state.projectMeta = null;
  state.planItems = [part];
  state.activeIndex = 0;
  renderPlan();
  showView('plan');
  return true;
}

function prepareCustomPlan(meta) {
  if (!meta?.items?.length) return toast('当前方案没有可取用器件。', 'warning');
  if (!canFetch()) return toast('设备尚未就绪，不能开始批量取料。', 'error');
  state.mode = 'project';
  state.projectMeta = { name: meta.name, description: meta.description };
  state.planItems = meta.items;
  state.activeIndex = 0;
  renderPlan();
  showView('plan');
  return true;
}

function renderPlan() {
  const isProject = state.mode === 'project';
  const current = currentPart();
  els.planType.textContent = isProject ? '清单顺序取料' : '单件调用';
  els.planTitle.textContent = isProject ? state.projectMeta.name : current.name;
  els.planDescription.textContent = isProject ? `${state.projectMeta.description} 当前准备：${current.name} / ${current.slot}` : `系统已定位到 ${current.slot}，确认安全后开始。`;
  els.planDuration.textContent = '由实际标定速度决定';
  els.planCount.textContent = `${state.planItems.length - state.activeIndex} 次`;
  els.planListLabel.textContent = isProject ? '剩余配料顺序' : '取料内容';
  els.planBadge.textContent = `${state.planItems.length - state.activeIndex} ITEM${state.planItems.length - state.activeIndex > 1 ? 'S' : ''}`;
  els.planList.innerHTML = state.planItems.slice(state.activeIndex).map((part, index) => `<li><span>${part.slot}</span><div><strong>${escapeHtml(part.name)}</strong><small>${escapeHtml(part.category)}</small></div><b>${String(index + 1).padStart(2, '0')}</b></li>`).join('');
  els.planAreaClear.checked = false;
  els.startPlan.querySelector('span').textContent = isProject ? '确认并取当前一项' : '确认并开始取料';
  renderDevice();
}

function moveCarrier(x, y, animated = true) {
  if (!animated) els.carrier.style.transition = 'none';
  els.carrier.style.setProperty('--cx', x);
  els.carrier.style.setProperty('--cy', y);
  if (!animated) requestAnimationFrame(() => { els.carrier.style.transition = ''; });
}

function renderTask(task) {
  const part = currentPart() || state.parts.find(item => item.id === task.box_id);
  if (!part) return;
  renderSlots(part);
  els.executeTitle.textContent = `${names[task.action] || task.action} ${part.name}`;
  els.executeSlot.textContent = part.slot;
  els.executePart.textContent = part.name;
  els.queueProgress.textContent = `${state.activeIndex + 1} / ${state.planItems.length || 1}`;
  els.queueStrip.innerHTML = (state.planItems.length ? state.planItems : [part]).map((item, index) => `<span class="${index < state.activeIndex ? 'done' : index === state.activeIndex ? 'active' : ''}">${item.slot}</span>`).join('');
  const group = task.action === 'RETURN' && ['TRANSFER_READY', 'MOVING_TO_SLOT'].includes(task.phase)
    ? 'returning' : (phaseGroups[task.phase] || 'accepted');
  state.phase = group;
  const [title, detail] = phaseCopy[group];
  els.machineState.textContent = task.phase_label || title;
  els.stageStatus.textContent = detail;
  els.statusMessage.textContent = `${task.action} · ${task.phase_label || detail}`;
  els.stageStatusDot.style.background = group === 'delivered' ? 'var(--cyan)' : 'var(--amber)';
  const order = ['accepted', 'locating', 'pulling', 'transporting', 'delivered'];
  const current = order.indexOf(group === 'returning' ? 'locating' : group);
  els.timeline.querySelectorAll('li').forEach((item, index) => {
    item.classList.toggle('done', index < current || group === 'delivered');
    item.classList.toggle('current', index === current && group !== 'delivered');
  });
  const event = task.events.at(-1);
  const sensors = event?.sensors || {};
  const xUm = [...task.events].reverse().find(item => Number.isFinite(item.sensors?.x_um))?.sensors.x_um;
  const eUm = [...task.events].reverse().find(item => Number.isFinite(item.sensors?.e_um))?.sensors.e_um;
  els.coordX.textContent = Number.isFinite(xUm) ? (xUm / 1000).toFixed(1) : '---';
  els.coordE.textContent = Number.isFinite(eUm) ? (eUm / 1000).toFixed(1) : '---';
  els.traySensor.textContent = sensors.evidence === 'open_loop_pulse_count' ? 'OPEN LOOP' : state.snapshot.mode === 'simulation' ? 'SIMULATED' : 'PENDING';
  els.interlock.textContent = task.status === 'AWAITING_CONFIRMATION' ? '待人工确认' : 'LOCKED';
  if (['locating', 'pulling'].includes(group)) moveCarrier(part.x, part.y);
  if (group === 'transporting' || group === 'delivered') moveCarrier(50, 100);
  if (state.view !== 'execute') showView('execute');
}

function showDelivered(task) {
  const part = currentPart() || state.parts.find(item => item.id === task.box_id);
  const next = state.planItems[state.activeIndex + 1];
  state.phase = 'delivered';
  els.completeMark.className = 'success-mark';
  els.completeMark.innerHTML = '<span>✓</span>已到取物口';
  els.completeTitle.textContent = `${part.name} 已在你面前`;
  els.completeDescription.textContent = '取出需要的零件。准备归还前，请再次确认手和工具已离开运动区域。';
  els.completeSlotVisual.textContent = part.slot;
  els.completeSlot.textContent = part.slot;
  els.completeTray.textContent = '待人工确认';
  els.completeProgress.textContent = `${state.activeIndex + 1} / ${state.planItems.length || 1}`;
  els.returnClearLabel.classList.remove('hidden');
  els.returnAreaClear.checked = false;
  els.returnButton.classList.remove('hidden');
  els.returnButton.disabled = true;
  els.confirmStoredButton.classList.add('hidden');
  els.newTaskButton.classList.add('hidden');
  els.nextMaterial.classList.toggle('hidden', !next);
  if (next) { els.nextPart.textContent = next.name; els.nextSlot.textContent = next.slot; }
  els.deliveryDock.classList.add('active');
  els.statusMessage.textContent = `AWAITING CONFIRMATION · ${part.name} 已到取物口`;
  showView('complete');
}

function showReturnConfirmation(task) {
  const part = currentPart() || state.parts.find(item => item.id === task.box_id);
  state.phase = 'return-confirm';
  els.completeMark.className = 'success-mark';
  els.completeMark.innerHTML = '<span>!</span>待确认';
  els.completeTitle.textContent = `${part.name} 已执行归还动作`;
  els.completeDescription.textContent = '当前硬件没有盒体传感器。请目视确认料盒已完整进入原格，抽盒机构已收回。';
  els.completeTray.textContent = '位置待核对';
  els.returnClearLabel.classList.add('hidden');
  els.returnButton.classList.add('hidden');
  els.confirmStoredButton.classList.remove('hidden');
  els.newTaskButton.classList.add('hidden');
  els.nextMaterial.classList.add('hidden');
  els.statusMessage.textContent = `VERIFY POSITION · 请确认 ${part.slot} 料盒已归位`;
  showView('complete');
}

function showFinished() {
  const isProject = state.mode === 'project';
  const part = currentPart();
  state.phase = 'finished';
  els.completeMark.className = 'success-mark final';
  els.completeMark.innerHTML = '<span>✓</span>流程完成';
  els.completeTitle.textContent = isProject ? `${state.projectMeta.name} 已配齐` : `${part.name} 已归位`;
  els.completeDescription.textContent = isProject ? `共完成 ${state.planItems.length} 次取料，所有盒位均经人工确认。` : '零件已取用，料盒位置已经人工确认。';
  els.completeTray.textContent = 'CLEAR';
  els.returnClearLabel.classList.add('hidden');
  els.returnButton.classList.add('hidden');
  els.confirmStoredButton.classList.add('hidden');
  els.newTaskButton.classList.remove('hidden');
  els.nextMaterial.classList.add('hidden');
  els.statusMessage.textContent = 'TASK COMPLETE · 所有料盒已归位';
  showView('complete');
}

function reconcileTask() {
  if (!state.snapshot) return;
  const targetId = state.currentTaskId || state.snapshot.active_task_id || state.snapshot.pending_task_id;
  const task = targetId ? state.snapshot.tasks.find(item => item.id === targetId) : null;
  if (!task) return;
  state.currentTaskId = task.id;
  if (task.status === 'RUNNING') {
    state.handledTaskKey = null;
    renderTask(task);
    return;
  }
  const key = `${task.id}:${task.status}`;
  if (state.handledTaskKey === key) return;
  state.handledTaskKey = key;
  if (task.status === 'AWAITING_CONFIRMATION') {
    if (task.action === 'FETCH') showDelivered(task);
    else showReturnConfirmation(task);
  } else if (task.status === 'FAILED' || task.status === 'INTERRUPTED') {
    state.phase = 'error';
    toast(task.error || '任务未完整结束，位置需要核对。', 'error');
    els.machineState.textContent = '任务停止 · 位置待核对';
    els.stageStatus.textContent = task.error || '请断电检查机构';
    showView('execute');
  } else if (task.action === 'HOME' && task.status === 'SUCCEEDED') {
    state.currentTaskId = null;
    state.phase = 'idle';
    toast('机械原点已登记，设备可以接收任务。');
    showView('request');
  }
}

async function refresh({ announce = false } = {}) {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    const snapshot = await readJsonResponse(response);
    state.backendOnline = true;
    state.snapshot = snapshot;
    state.token = snapshot.token;
    syncParts();
    renderParts(els.partSearch.value);
    renderSlots();
    renderDevice();
    reconcileTask();
    if (announce) toast('设备状态已刷新。');
  } catch (error) {
    state.backendOnline = false;
    els.deviceStatus.textContent = '服务断开';
    els.readyStateTitle.textContent = '本机服务未连接';
    els.footerStatusLed.classList.add('offline');
    if (announce) toast(`无法连接本机服务：${error.message}`, 'error');
  }
}

async function startPlan() {
  if (state.submitting || !els.planAreaClear.checked || !canFetch()) return;
  const part = currentPart();
  state.submitting = true;
  els.startPlan.disabled = true;
  try {
    const task = await api('/tasks', { action: 'FETCH', box_id: part.id,
      request_id: crypto.randomUUID(), aligned_slot_id: part.slot, area_clear: true });
    state.currentTaskId = task.id;
    state.handledTaskKey = null;
    state.phase = 'accepted';
    renderTask(task);
  } catch (error) { toast(error.message, 'error'); }
  finally { state.submitting = false; await refresh(); }
}

async function returnCurrent() {
  if (state.submitting || state.phase !== 'delivered' || !els.returnAreaClear.checked) return;
  const pendingId = state.snapshot.pending_task_id;
  const part = currentPart();
  state.submitting = true;
  els.returnButton.disabled = true;
  try {
    await api(`/tasks/${pendingId}/confirm`, { confirmed: true });
    const task = await api('/tasks', { action: 'RETURN', box_id: part.id,
      request_id: crypto.randomUUID(), area_clear: true });
    state.currentTaskId = task.id;
    state.handledTaskKey = null;
    state.phase = 'returning';
    renderTask(task);
  } catch (error) { toast(error.message, 'error'); }
  finally { state.submitting = false; await refresh(); }
}

async function confirmStored() {
  if (state.submitting || state.phase !== 'return-confirm') return;
  state.submitting = true;
  try {
    await api(`/tasks/${state.snapshot.pending_task_id}/confirm`, { confirmed: true });
    await refresh();
    if (state.activeIndex < state.planItems.length - 1) {
      state.activeIndex += 1;
      state.currentTaskId = null;
      state.handledTaskKey = null;
      renderPlan();
      showView('plan');
      toast('盒位已确认。请检查运动区域后开始下一项。');
    } else showFinished();
  } catch (error) { toast(error.message, 'error'); }
  finally { state.submitting = false; }
}

async function stopTask() {
  if (state.submitting || ['idle', 'finished'].includes(state.phase)) return;
  state.submitting = true;
  try {
    const result = await api('/device/stop', {});
    toast(result.message, 'warning');
    state.phase = 'error';
  } catch (error) { toast(`停止请求未确认：${error.message}。请切断执行机构电源。`, 'error'); }
  finally { state.submitting = false; await refresh(); }
}

function resetHome() {
  if (state.snapshot?.active_task_id || state.snapshot?.pending_task_id) return toast('请先完成当前任务或盒位确认。', 'warning');
  state.mode = null;
  state.projectMeta = null;
  state.planItems = [];
  state.activeIndex = 0;
  state.currentTaskId = null;
  state.handledTaskKey = null;
  state.phase = 'idle';
  els.partSearch.value = '';
  els.statusMessage.textContent = state.snapshot?.device_state === 'READY'
    ? 'SYSTEM READY · 等待任务'
    : `SYSTEM HOLD · ${names[state.snapshot?.device_state] || state.snapshot?.device_state || '设备未就绪'}`;
  renderParts();
  showView('request');
}

function renderInventoryEditor() {
  els.inventoryEditor.innerHTML = state.parts.map(part => `<div class="inventory-edit-row" data-box="${part.id}"><b>${part.slot}</b><input data-field="name" value="${escapeHtml(part.name)}" aria-label="${part.slot} 零件名称" maxlength="60" /><input data-field="aliases" value="${escapeHtml(part.alias.join('，'))}" aria-label="${part.slot} 别名" placeholder="别名，用逗号分隔" /></div>`).join('');
}

function openInventory() {
  if (state.snapshot?.active_task_id || state.snapshot?.pending_task_id) return toast('任务执行或待确认期间不能编辑格口。', 'warning');
  state.editingInventory = true;
  renderInventoryEditor();
  els.infoDialog.showModal();
}

async function saveInventory() {
  if (state.submitting) return;
  state.submitting = true;
  try {
    for (const row of els.inventoryEditor.querySelectorAll('.inventory-edit-row')) {
      const name = row.querySelector('[data-field="name"]').value.trim();
      const aliases = row.querySelector('[data-field="aliases"]').value.split(/[,，]/).map(value => value.trim()).filter(Boolean);
      await api(`/boxes/${row.dataset.box}`, { name, aliases }, 'PATCH');
    }
    els.infoDialog.close();
    state.editingInventory = false;
    await refresh();
    toast('硬件库已保存到本机数据库。');
  } catch (error) { toast(error.message, 'error'); }
  finally { state.submitting = false; }
}

async function submitReference(event) {
  event.preventDefault();
  if (!els.referenceConfirmed.checked || state.submitting) return;
  state.submitting = true;
  try {
    if (state.snapshot.device_state === 'RECOVERY_REQUIRED') {
      if (state.snapshot.mode === 'simulation') await api('/simulation/reset', { confirmed: true });
      else await api('/device/recover', { confirmed_all_stored: true });
    }
    const task = await api('/device/reference', { request_id: crypto.randomUUID(),
      manual_reference_confirmed: true, area_clear: true });
    state.currentTaskId = task.id;
    state.handledTaskKey = null;
    els.referenceDialog.close();
    state.phase = 'accepted';
    showView('execute');
  } catch (error) { toast(error.message, 'error'); }
  finally { state.submitting = false; await refresh(); }
}

function toast(message, type = 'normal') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toastRegion.appendChild(node);
  setTimeout(() => node.remove(), 3600);
}

function initVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    els.voiceButton.addEventListener('click', () => toast('当前浏览器不支持语音识别，请使用文字搜索。', 'warning'));
    return;
  }
  const recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = false;
  recognition.onstart = () => { els.voiceButton.classList.add('listening'); els.searchHint.textContent = '正在聆听…'; };
  recognition.onend = () => els.voiceButton.classList.remove('listening');
  recognition.onerror = event => toast(`语音识别未完成：${event.error}`, 'error');
  recognition.onresult = event => {
    const transcript = event.results[0][0].transcript.replace(/阿仓|帮我|给我|拿一个|拿|取出/g, '').trim();
    els.partSearch.value = transcript;
    renderParts(transcript);
    const part = findPart(transcript);
    if (part) preparePartPlan(part.id);
  };
  els.voiceButton.addEventListener('click', () => { try { recognition.start(); } catch { toast('语音识别正在启动。', 'warning'); } });
}

function registerWebMcp() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  try {
    context.registerTool({ name: 'find_part', title: '查找零件', description: '按名称或别名查询当前启用格口。',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      annotations: { readOnlyHint: true }, execute: ({ query }) => {
        const part = findPart(query);
        return part ? { found: true, name: part.name, slot: part.slot, state: part.state } : { found: false };
      } });
  } catch {}
}

document.addEventListener('click', event => {
  const partButton = event.target.closest('[data-part]');
  if (partButton && partButton.getAttribute('aria-disabled') !== 'true') preparePartPlan(partButton.dataset.part);
});
els.partSearch.addEventListener('input', event => renderParts(event.target.value));
els.partSearch.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  const part = findPart(event.currentTarget.value);
  part ? preparePartPlan(part.id) : toast('硬件库中没有找到对应零件。', 'warning');
});
els.planAreaClear.addEventListener('change', renderDevice);
els.returnAreaClear.addEventListener('change', () => { els.returnButton.disabled = !els.returnAreaClear.checked || state.submitting; });
els.startPlan.addEventListener('click', startPlan);
els.returnButton.addEventListener('click', returnCurrent);
els.confirmStoredButton.addEventListener('click', confirmStored);
els.stopButton.addEventListener('click', stopTask);
els.homeButton.addEventListener('click', resetHome);
els.planBack.addEventListener('click', resetHome);
els.newTaskButton.addEventListener('click', resetHome);
els.settingsButton.addEventListener('click', openInventory);
els.saveInventoryButton.addEventListener('click', saveInventory);
els.infoDialog.addEventListener('close', () => { state.editingInventory = false; });
els.devicePill.addEventListener('click', () => refresh({ announce: true }));
els.referenceButton.addEventListener('click', () => { els.referenceConfirmed.checked = false; els.referenceDialog.showModal(); });
els.closeReference.addEventListener('click', () => els.referenceDialog.close());
els.referenceForm.addEventListener('submit', submitReference);
els.parseBomButton.addEventListener('click', parseImportedBom);
els.bomFileInput.addEventListener('change', event => importBomFile(event.target.files?.[0]));
els.clearBomFile.addEventListener('click', resetBomImport);
els.confirmImportedPlan.addEventListener('click', () => prepareCustomPlan(state.importedPlan));
els.bomDropzone.addEventListener('click', event => { if (event.target !== els.bomFileInput && !event.target.closest('label') && !state.bomImporting) els.bomFileInput.click(); });
els.bomDropzone.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key) && !state.bomImporting) { event.preventDefault(); els.bomFileInput.click(); } });
for (const type of ['dragenter', 'dragover']) els.bomDropzone.addEventListener(type, event => { event.preventDefault(); els.bomDropzone.classList.add('dragging'); });
for (const type of ['dragleave', 'drop']) els.bomDropzone.addEventListener(type, event => { event.preventDefault(); els.bomDropzone.classList.remove('dragging'); });
els.bomDropzone.addEventListener('drop', event => importBomFile(event.dataTransfer?.files?.[0]));
document.addEventListener('keydown', event => {
  if (event.key === '/' && state.view === 'request' && document.activeElement !== els.partSearch) { event.preventDefault(); els.partSearch.focus(); }
});

moveCarrier(0, 100, false);
initVoice();
registerWebMcp();
await refresh();
setInterval(refresh, API_CONFIG.pollMs);
