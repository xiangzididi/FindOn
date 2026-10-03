let token = "";
let hydrated = false;
let polling = false;

const $ = (selector) => document.querySelector(selector);

function showNotice(message, error = false) {
  const notice = $("#notice");
  notice.textContent = message;
  notice.className = `notice${error ? " error" : ""}`;
  notice.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { notice.hidden = true; }, 4500);
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Calibration-Token": token },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  render(payload.state);
  return payload;
}

function displayValue(input, value) {
  if (!hydrated) input.value = value ?? "";
}

function render(state) {
  const serviceChanged = Boolean(token && token !== state.token);
  if (serviceChanged) {
    hydrated = false;
    document.querySelectorAll(".check input").forEach((input) => { input.checked = false; });
  }
  token = state.token;
  const device = state.device;
  const pill = $("#devicePill");
  pill.className = `pill ${device.connected ? "online" : "offline"}`;
  pill.querySelector("strong").textContent = device.connected ? (state.mode === "simulation" ? "模拟器已连接" : "控制器已连接") : "控制器离线";
  pill.querySelector("small").textContent = `${device.port} · ${device.baud}`;
  $("#modeValue").textContent = state.mode === "simulation" ? "安全模拟" : "真实硬件";
  $("#portValue").textContent = device.port;
  $("#baudValue").textContent = device.baud;
  $("#deviceError").textContent = device.error || "";
  $("#motionBadge").textContent = state.moving ? "运动中" : "空闲";
  $("#motionBadge").className = `status-tag${state.moving ? " moving" : ""}`;

  const calibration = state.calibration;
  $("#xScale").textContent = calibration.x.pulses_per_mm ? `${calibration.x.pulses_per_mm.toLocaleString()} pulse/mm` : "待测量";
  $("#eScale").textContent = calibration.e.pulses_per_mm
    ? `${(calibration.e.pulses_per_mm / (calibration.e.scale_divisor || 1)).toLocaleString(undefined, { maximumFractionDigits: 4 })} pulse/mm`
    : "待测量";
  displayValue($("#dockInput"), calibration.e.dock_mm);
  displayValue($("#s01Input"), calibration.slots.S01.x_mm);
  displayValue($("#s02Input"), calibration.slots.S02.x_mm);
  displayValue($("#hookShiftInput"), calibration.x.hook_shift_mm);
  if (!hydrated) {
    $("#xDirection").value = calibration.x.dir_high_motion;
    $("#eDirection").value = calibration.e.dir_high_motion;
  }

  const missing = state.missing;
  const list = $("#missingList");
  list.className = `missing-list${missing.length ? "" : " complete"}`;
  list.innerHTML = missing.length ? missing.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : "<li>全部参数有效，可以写入</li>";
  const completeCount = Math.max(0, 5 - missing.length);
  $("#progressNumber").textContent = `${completeCount} / 5`;
  $("#progressText").textContent = missing.length ? `还有 ${missing.length} 项需要处理` : "所有必需参数已就绪";
  $("#headerPreview").textContent = state.header_preview || "参数完整后生成";
  $("#applyButton").disabled = missing.length > 0 || state.moving;

  const move = state.last_move;
  const measurement = $("#measurementForm");
  measurement.hidden = !move?.complete || !(move.emitted_pulses > 0);
  if (!measurement.hidden) {
    $("#measurementTitle").textContent = `录入 ${move.axis} 轴实测距离`;
    $("#measurementHelp").textContent = `控制器完成 ${move.emitted_pulses.toLocaleString()} 个脉冲；只填绝对距离。`;
  }

  const terminal = $("#terminal");
  terminal.innerHTML = state.logs.length ? state.logs.map((entry) => `<p class="${entry.source}"><span>${escapeHtml(entry.time)}</span> [${escapeHtml(entry.source)}] ${escapeHtml(entry.line)}</p>`).join("") : "<p>正在等待日志…</p>";
  terminal.scrollTop = terminal.scrollHeight;
  document.querySelectorAll(".motion-panel button[type=submit]").forEach((button) => { button.disabled = state.moving || !device.connected; });
  hydrated = true;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    render(await response.json());
  } catch (error) {
    $("#deviceError").textContent = `本地标定服务不可用：${error.message}`;
  } finally { polling = false; }
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    try { await api("/api/action", { action: button.dataset.action }); }
    catch (error) { showNotice(error.message, true); }
  });
});

function bindMotion(formSelector, action) {
  $(formSelector).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api("/api/action", { action, value: Number(data.get("value")), confirmed: data.get("confirmed") === "on" });
      form.elements.confirmed.checked = false;
      showNotice("有限运动指令已发送，请观察机构并等待停止回执。");
    } catch (error) { showNotice(error.message, true); }
  });
}
bindMotion("#xForm", "X_TRAVEL");
bindMotion("#eForm", "E_PULSE");

$("#measurementForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const measured = Number(new FormData(event.currentTarget).get("measured_mm"));
    const result = await api("/api/measurement", { measured_mm: measured });
    showNotice(`计算完成：${result.pulses_per_mm.toLocaleString()} pulse/mm`);
  } catch (error) { showNotice(error.message, true); }
});

$("#geometryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api("/api/geometry", data);
    showNotice("几何参数已暂存，确认结果后可写入固件配置。");
  } catch (error) { showNotice(error.message, true); }
});

$("#applyButton").addEventListener("click", async () => {
  try {
    await api("/api/apply", {});
    showNotice("已写入最终固件配置。下一步重新编译并烧录控制器固件。");
  } catch (error) { showNotice(error.message, true); }
});

await refresh();
setInterval(refresh, 900);
