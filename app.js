import * as P from './protocol.js';

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
const bytesToHex = (b) => [...new Uint8Array(b)].map(x => hex(x)).join(' ');
const parseHex = (s) => Uint8Array.from(s.trim().split(/[\s,]+/).filter(Boolean).map(x => parseInt(x.replace(/^0x/i, ''), 16)));
const rgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
const toHexColor = (c) => '#' + hex(c.r) + hex(c.g) + hex(c.b);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(kind, msg) {
  const el = $('#console'); if (!el) return;
  const d = document.createElement('div'); d.className = 'log-' + kind;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
}
function flash(id, ok, text) {
  const el = $('#' + id); if (!el) return;
  el.textContent = text; el.style.color = ok ? 'var(--good)' : 'var(--bad)';
  setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
}

/* tabs */
function openTab(name) {
  const tab = $(`.tab[data-pane="${name}"]`); if (!tab) return;
  $$('.tab').forEach(x => x.classList.remove('active'));
  $$('.tabpane').forEach(p => p.classList.add('hidden'));
  tab.classList.add('active'); $('#pane-' + name).classList.remove('hidden');
}
$$('.tab').forEach(t => t.addEventListener('click', () => { openTab(t.dataset.pane); location.hash = t.dataset.pane; }));
if (location.hash) openTab(location.hash.slice(1));

/* ================= Bluetooth ================= */
let bleDevice = null;
async function connectBle() {
  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'daWg' }],
      optionalServices: [P.BLE.batteryService, P.BLE.deviceInfoService],
    });
    bleDevice.addEventListener('gattserverdisconnected', () => setBle(false));
    const server = await bleDevice.gatt.connect();
    setBle(true);
    await readBattery(server); await readDeviceInfo(server);
  } catch (e) { log('err', 'BLE: ' + e.message); }
}
async function readBattery(server) {
  try {
    const c = await (await server.getPrimaryService(P.BLE.batteryService)).getCharacteristic(P.BLE.batteryLevel);
    setBattery((await c.readValue()).getUint8(0));
    await c.startNotifications();
    c.addEventListener('characteristicvaluechanged', e => setBattery(e.target.value.getUint8(0)));
  } catch (e) { log('err', 'Battery: ' + e.message); }
}
async function readDeviceInfo(server) {
  const box = $('#deviceInfo'); box.innerHTML = '';
  let s; try { s = await server.getPrimaryService(P.BLE.deviceInfoService); } catch { return; }
  const dec = new TextDecoder();
  for (const it of P.BLE.deviceInfo) {
    try { const c = await s.getCharacteristic(it.uuid); addKv(box, it.label, dec.decode(await c.readValue()).replace(/\0+$/, '') || '—'); } catch {}
  }
}
function addKv(box, k, v) {
  const a = document.createElement('div'); a.className = 'k'; a.textContent = k;
  const b = document.createElement('div'); b.className = 'v'; b.textContent = v; box.append(a, b);
}
function setBle(on) { $('#btnBle').classList.toggle('on', on); if (!on) log('sys', 'Bluetooth disconnected.'); }
function setBattery(p) { $('#battValue').textContent = p; $('#battTop').textContent = p + '%'; $('#battChip').classList.remove('hidden'); pushBatt(p); }

/* ---- live battery sparkline (session history) ---- */
const battHist = [];
function pushBatt(p) {
  if (!Number.isFinite(p)) return;
  if (battHist.length && battHist[battHist.length - 1] === p && battHist.length > 1) battHist[battHist.length - 1] = p;
  else battHist.push(p);
  if (battHist.length > 160) battHist.shift();
  const cv = $('#battSpark'); if (!cv) return; cv.classList.remove('hidden');
  const ctx = cv.getContext('2d'), w = cv.width, h = cv.height; ctx.clearRect(0, 0, w, h);
  if (battHist.length < 2) return;
  const n = battHist.length, step = w / (n - 1), y = v => h - (v / 100) * (h - 5) - 3;
  ctx.beginPath();
  battHist.forEach((v, i) => { const x = i * step; i ? ctx.lineTo(x, y(v)) : ctx.moveTo(x, y(v)); });
  ctx.strokeStyle = '#6c8cff'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = 'rgba(108,140,255,.12)'; ctx.fill();
}

/* ================= USB / HID ================= */
let hidDevice = null, cfgReportId = 0, pendingInput = null;
async function connectHid() {
  try {
    const [dev] = await navigator.hid.requestDevice({ filters: [
      { vendorId: P.IDS.usb.vendorId, usagePage: P.IDS.configUsagePage },
      { vendorId: P.IDS.dongle.vendorId, usagePage: P.IDS.configUsagePage },
    ]});
    if (!dev) return;
    hidDevice = dev;
    if (!dev.opened) await dev.open();
    dev.addEventListener('inputreport', onInput);
    const cfg = findConfig(dev); cfgReportId = cfg.reportId;
    setHid(true);
    log('sys', `USB ready: "${dev.productName}" reportId=${cfg.reportId}`);
    describeCollections(dev);
    await refreshUsbInfo();          // battery + active stage straight over USB
  } catch (e) { log('err', 'HID: ' + e.message); }
}
function outLen(out) { if (!out || !out.items) return null; let b = 0; for (const it of out.items) b += (it.reportSize || 0) * (it.reportCount || 0); return Math.ceil(b / 8); }
function findConfig(dev) {
  const pick = (c) => {
    const out = (c.outputReports || [])[0]; const len = outLen(out);
    if (len && len !== 32) log('sys', `note: output report is ${len} data bytes (expected 32).`);
    return { reportId: out ? out.reportId : 0 };
  };
  for (const c of dev.collections || []) if (c.usagePage === P.IDS.configUsagePage) return pick(c);
  const v = (dev.collections || []).find(c => c.usagePage >= 0xff00);
  return v ? pick(v) : { reportId: 0 };
}
function describeCollections(dev) {
  const box = $('#collections'); box.innerHTML = '';
  (dev.collections || []).forEach((c, i) => {
    const vendor = c.usagePage >= 0xff00; const el = document.createElement('div'); el.className = 'coll';
    el.innerHTML = `Collection ${i}: usagePage=0x${hex(c.usagePage, 4)} usage=0x${hex(c.usage, 2)}` +
      `<span class="tag ${vendor ? 'vendor' : 'std'}">${vendor ? 'VENDOR' : 'standard'}</span>`;
    box.appendChild(el);
  });
}
function setHid(on) { $('#btnHid').classList.toggle('on', on); $('#connCallout').classList.toggle('hidden', on); }
function onInput(e) {
  const data = new Uint8Array(e.data.buffer);
  const full = new Uint8Array(1 + data.length); full[0] = e.reportId; full.set(data, 1);
  log('rx', `in #${e.reportId}: ${bytesToHex(e.data.buffer)}`);
  if (data[0] === 0xD2) {                          // live DPI-change notification
    const idx = data[1] >> 4, cnt = data[1] & 0x0f, dpi = P.rawToDpi(data[2]);
    $('#activeStage').textContent = `Stage ${idx + 1} / ${cnt} · ${dpi} DPI`;
    return;                                        // don't feed notifications to a pending read
  }
  if (pendingInput) { pendingInput(full); pendingInput = null; }
}
async function send(buf33, label = '') {
  if (!hidDevice) { log('err', 'Connect USB first.'); throw new Error('Connect USB first'); }
  log('tx', `${label}: ${bytesToHex(buf33)}`);
  await hidDevice.sendReport(cfgReportId, buf33.slice(1));
}
async function sendRead(buf33, label) {
  const reply = new Promise(res => { pendingInput = res; });
  await send(buf33, label);
  return Promise.race([reply, new Promise((_, rej) => setTimeout(() => rej(new Error('read timeout')), 1500))]);
}
const guard = (id) => async (fn) => { try { await fn(); flash(id, true, 'Applied ✓'); } catch (e) { flash(id, false, e.message); } };

/* ================= DPI ================= */
let stageCount = 5, xyMode = false;
const stageColors = [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 }, { r: 255, g: 0, b: 255 }, { r: 255, g: 255, b: 0 }, { r: 255, g: 255, b: 255 }];
const dpiInput = (cls, val) => `<input type="number" class="dpiVal ${cls}" min="${P.MODEL.dpiMin}" max="${P.MODEL.dpiMax}" step="50" value="${val}">`;
function buildDpi() {
  const cnt = $('#stageCount'); cnt.innerHTML = '';
  for (let n = 1; n <= P.MODEL.dpiStages; n++) cnt.innerHTML += `<option ${n === stageCount ? 'selected' : ''}>${n}</option>`;
  cnt.onchange = () => { stageCount = +cnt.value; dpiDisable(); };
  const xy = $('#xyDpi'); xy.checked = xyMode; xy.onchange = () => { xyMode = xy.checked; buildDpi(); };
  const box = $('#dpiRows'); box.innerHTML = '';
  for (let i = 0; i < P.MODEL.dpiStages; i++) {
    const r = document.createElement('div'); r.className = 'stage' + (xyMode ? ' xy' : ''); r.dataset.i = i;
    const d = P.MODEL.defaultDpis[i];
    r.innerHTML =
      `<input type="radio" name="activeStage" value="${i}" ${i === 0 ? 'checked' : ''}>` +
      `<span class="sname">Stage ${i + 1}</span>` +
      `<span class="dpi-in">${dpiInput('dpiX', d)}<span>${xyMode ? 'X' : 'DPI'}</span>` +
        (xyMode ? `${dpiInput('dpiY', d)}<span>Y</span>` : '') + `</span>` +
      `<input type="color" class="dpiColor" value="${toHexColor(stageColors[i])}">`;
    box.appendChild(r);
  }
  $('#dpiColHead').textContent = xyMode ? 'X / Y' : 'DPI';
  $('.stage-head').classList.toggle('xy', xyMode);
  dpiDisable();
}
function dpiDisable() { $$('.stage').forEach(r => { const on = +r.dataset.i < stageCount; r.classList.toggle('off', !on); r.querySelectorAll('input').forEach(x => x.disabled = !on); }); }
function dpiPacket() {
  const rows = $$('.stage').slice(0, stageCount);
  const dpis = rows.map(r => xyMode
    ? { x: +r.querySelector('.dpiX').value, y: +r.querySelector('.dpiY').value }
    : +r.querySelector('.dpiX').value);
  const active = Math.min(+($('input[name=activeStage]:checked')?.value || 0), stageCount - 1);
  return P.setDpi(dpis, active);
}
function colorsPacket() { const c = $$('.dpiColor').map(i => rgb(i.value)); while (c.length < 6) c.push(c[c.length - 1]); return P.setDpiColors(c); }
const applyDpi = () => guard('dpiMsg')(() => send(dpiPacket(), 'setDPI'));
const applyColors = () => guard('dpiMsg')(() => send(colorsPacket(), 'setColors'));

/* ================= Lighting ================= */
const custom7 = ['#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'];
function buildLight() {
  const s = $('#lightMode'); s.innerHTML = '';
  P.LIGHT_EFFECTS.forEach((e, i) => s.innerHTML += `<option value="${i}">${e.name}</option>`);
  const sw = $('#custom7Swatches'); sw.innerHTML = '';
  custom7.forEach((c, i) => { const inp = document.createElement('input'); inp.type = 'color'; inp.value = c; inp.oninput = () => custom7[i] = inp.value; sw.appendChild(inp); });
  s.onchange = lightModeChange; lightModeChange();
}
function lightModeChange() {
  const e = P.LIGHT_EFFECTS[+$('#lightMode').value];
  $('#custom7').classList.toggle('hidden', e.kind !== 'custom7');
  $('#lightColorWrap').classList.toggle('hidden', e.kind === 'custom7' || e.kind === 'simple');
}
function lightPacket() {
  const e = P.LIGHT_EFFECTS[+$('#lightMode').value], dv = $('#lightDir').value;
  return P.setLighting({
    mode: e.mode, kind: e.kind, brightness: +$('#lightBri').value, speed: +$('#lightSpeed').value,
    color: rgb($('#lightColor').value), colors7: custom7.map(rgb),
    direction: dv === '' ? undefined : +dv,
  });
}
const applyLight = () => guard('lightMsg')(() => send(lightPacket(), 'setLight'));

/* ================= Buttons (unified state) ================= */
const buttonState = ['left', 'right', 'middle', 'forward', 'back', 'dpi_loop']; // string id OR macro object
function buildButtons() {
  const box = $('#btnRows'); box.innerHTML = '';
  P.MODEL.buttons.forEach((btn, i) => {
    const r = document.createElement('div'); r.className = 'brow';
    const sel = document.createElement('select'); sel.className = 'btnFn'; sel.dataset.i = i;
    P.BUTTON_FUNCTIONS.forEach(f => sel.innerHTML += `<option value="${f.id}">${f.label}${f.beta ? ' (beta)' : ''}</option>`);
    sel.innerHTML += `<option value="__kbd__">⌨ Keyboard key / combo…</option>`;
    const st = buttonState[i];
    if (st && st.macro) sel.innerHTML += `<option value="__cur__" selected>◆ Macro (recorded)</option>`;
    else if (st && st.fire) sel.innerHTML += `<option value="__cur__" selected>⚡ Turbo ×${st.count || '∞'}</option>`;
    else if (st && st.kbd) sel.innerHTML += `<option value="__cur__" selected>⌨ ${P.comboLabel(st.mod, st.code)}</option>`;
    else sel.value = st;
    sel.onchange = () => {
      if (sel.value === '__kbd__') startKbdCapture(i, sel);
      else if (sel.value !== '__cur__') buttonState[i] = sel.value;
    };
    const lab = document.createElement('span'); lab.className = 'blabel'; lab.textContent = btn.name;
    r.append(lab, sel); box.appendChild(r);
  });
}
const applyButtons = () => guard('btnMsg')(() => send(P.setButtons(buttonState), 'setButtons'));
function resetButtons() { ['left', 'right', 'middle', 'forward', 'back', 'dpi_loop'].forEach((v, i) => buttonState[i] = v); buildButtons(); }

/* turbo / rapid-fire binding */
function buildFireSelects() {
  const b = $('#fireBtn'); b.innerHTML = ''; P.MODEL.buttons.forEach((btn, i) => b.innerHTML += `<option value="${i}">${btn.name}</option>`); b.value = 0;
  const t = $('#fireTarget'); t.innerHTML = ''; P.FIRE_TARGETS.forEach(f => t.innerHTML += `<option value="${f.mask}">${f.label}</option>`);
}
const setFire = () => guard('fireMsg')(async () => {
  const idx = +$('#fireBtn').value, mask = +$('#fireTarget').value, count = Math.max(0, Math.min(255, +$('#fireCount').value || 0));
  buttonState[idx] = P.fireBinding(mask, count);
  await send(P.setButtons(buttonState), 'setButtons(turbo)');
  buildButtons();
});

let kbdCapture = null;
function startKbdCapture(i, sel) {
  kbdCapture = i;
  sel.innerHTML = `<option selected>Press a key… (Esc cancels)</option>`;
  flash('btnMsg', true, `Press a key or combo for "${P.MODEL.buttons[i].name}"`);
}
function onKbdCapture(e) {
  if (kbdCapture === null) return false;
  e.preventDefault();
  if (e.code === 'Escape') { kbdCapture = null; buildButtons(); return true; }
  if (P.MOD_BIT[e.code] !== undefined) return true;           // wait for a non-modifier key
  const usage = P.KEY_HID[e.code], i = kbdCapture; kbdCapture = null;
  if (usage === undefined) { flash('btnMsg', false, 'Unsupported key: ' + e.code); buildButtons(); return true; }
  buttonState[i] = { kbd: true, mod: P.modBitsFromEvent(e), usage, code: e.code };
  buildButtons(); flash('btnMsg', true, `Set ${P.comboLabel(buttonState[i].mod, e.code)} — click Apply`);
  return true;
}

/* ================= Macros ================= */
let recording = false, recRaw = [], macroEvents = [];   // macroEvents = finalized, editable {kind,down,code,mask,delay}
const MEV_MOUSE = { 0: 0x01, 1: 0x04, 2: 0x02, 3: 0x08, 4: 0x10 };
const evLabel = (ev) => ev.kind === 'mouse'
  ? 'M' + (Object.keys(MEV_MOUSE).find(k => MEV_MOUSE[k] === ev.mask) ?? '?')
  : (ev.code || '').replace(/^(Key|Digit)/, '');
function buildMacroBtnSelect() { const s = $('#macroBtn'); s.innerHTML = ''; P.MODEL.buttons.forEach((b, i) => s.innerHTML += `<option value="${i}">${b.name}</option>`); s.value = 5; }
function renderMacro() {
  const box = $('#macroList'); box.innerHTML = '';
  if (recording) { box.textContent = recRaw.map(e => (e.down ? '↓' : '↑') + evLabel(e)).join('  ') || 'recording…'; return; }
  macroEvents.forEach((ev, i) => {
    const d = document.createElement('span'); d.className = 'mev';
    d.innerHTML = `${ev.down ? '↓' : '↑'}${evLabel(ev)}`;
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = 0; inp.max = 65535; inp.value = ev.delay;
    inp.title = 'delay after (ms)'; inp.oninput = () => ev.delay = Math.max(0, Math.min(65535, +inp.value || 0));
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.onclick = () => { macroEvents.splice(i, 1); renderMacro(); };
    d.append(' ', inp, 'ms ', x); box.appendChild(d);
  });
}
function toggleRecord() {
  recording = !recording;
  $('#btnRec').textContent = recording ? '■ Stop' : '● Record';
  $('#recZone').classList.toggle('rec', recording);
  if (recording) { recRaw = []; renderMacro(); $('#recZone').focus(); }
  else {                                        // finalize: delay = time until next event
    macroEvents = recRaw.map((ev, i) => ({
      kind: ev.kind, down: ev.down, code: ev.code, mask: ev.mask,
      delay: recRaw[i + 1] ? Math.max(0, Math.min(0xffff, Math.round(recRaw[i + 1].t - ev.t))) : 0,
    }));
    renderMacro();
  }
}
function onKey(down) { return (e) => { if (!recording) return; e.preventDefault(); recRaw.push({ kind: 'key', down, code: e.code, t: performance.now() }); renderMacro(); }; }
function onMouse(down) { return (e) => { if (!recording) return; e.preventDefault(); recRaw.push({ kind: 'mouse', down, mask: MEV_MOUSE[e.button] ?? 1, t: performance.now() }); renderMacro(); }; }
const saveMacro = () => guard('macroMsg')(async () => {
  if (recording) toggleRecord();
  if (!macroEvents.length) throw new Error('Record something first');
  const idx = +$('#macroBtn').value, keyId = P.MODEL.buttons[idx].index;
  for (const pkt of P.setMacroSteps(keyId, macroEvents)) { await send(pkt, 'macroStep'); await sleep(20); }
  buttonState[idx] = { macro: true, keyId, loop: $('#macroLoop').value, count: +$('#macroCount').value || 1, events: macroEvents.slice() };
  await send(P.setButtons(buttonState), 'setButtons(macro)');
  buildButtons();
});

/* ================= Advanced ================= */
function buildPoll() { const s = $('#pollRate'); s.innerHTML = ''; P.POLLING.forEach(p => s.innerHTML += `<option value="${p.code}">${p.hz} Hz</option>`); s.value = 4; }
const applyPoll = () => guard('pollMsg')(() => send(P.setPollingRate(+$('#pollRate').value, $('#pollConn').value === 'wireless'), 'setPolling'));
const applyLod = () => guard('advMsg')(() => send(P.setLiftoff(+$('#lod').value, $('#angleSnap').checked, $('#motionSync').checked), 'setLOD'));
const applyMotion = () => guard('advMsg')(() => send(P.setMotion({ sleepMinutes: +$('#sleepMin').value || 5, buttonResponseMs: Math.max(0, Math.min(255, +$('#debounce').value || 0)) }), 'setMotion'));
const factory = () => { if (confirm('Reset the mouse to factory defaults?')) guard('factoryMsg')(() => send(P.factoryReset(), 'factoryReset')); };
// The mouse reports the active stage as a packed `index<<4 | count` byte (same
// shape as the live 0xD2 report). A small value is already a raw index; a larger
// one is packed, so take the high nibble. Always clamp to a real stage.
function decodeStage(v) {
  const idx = (v < P.MODEL.dpiStages) ? v : (v >> 4);
  return Math.min(Math.max(idx, 0), P.MODEL.dpiStages - 1);
}
function setActiveStageLabel(v) { $('#activeStage').textContent = 'Stage ' + (decodeStage(v) + 1); }
// This firmware answers the two-step request->fetch read (0x0e then 0x15) and
// ignores the single-shot 0x11/0x13/0x14 reads (they time out). Battery is only
// available over Bluetooth here.
async function readActive() {
  await send(P.readActiveDpiRequest(), 'dpiActive?');   // 0x0e request
  await sleep(120);
  return await sendRead(P.readActiveDpiFetch(), 'dpiActive');   // 0x15 fetch
}
async function readUsb() {
  try {
    const reply = await readActive();
    setActiveStageLabel(reply[4]);
    log('sys', `active stage reply: ${bytesToHex(reply)}`);
  } catch (e) { log('err', 'read: ' + e.message); }
}
async function consoleSend() {
  try { const d = parseHex($('#txBytes').value); const buf = new Uint8Array(33); buf.set(d.slice(0, 32), 1);
    let s = 0; for (let i = 5; i <= 31; i++) s = (s + buf[i]) & 0xff; buf[32] = s; await send(buf, 'console'); }
  catch (e) { log('err', 'send: ' + e.message); }
}

/* ================= Sync from mouse ================= */
async function refreshUsbInfo() {
  try {
    const reply = await readActive();
    setActiveStageLabel(reply[4]);
    log('sys', `active stage reply (0x15): ${bytesToHex(reply)}`);
  } catch { log('sys', 'active-stage read timed out — firmware may not answer over this link.'); }
}
async function syncFromMouse() {
  if (!hidDevice) { flash('syncMsg', false, 'Connect USB first'); return; }
  try {
    const reply = await readActive();
    setActiveStageLabel(reply[4]);
    log('sys', `sync reply (0x15): ${bytesToHex(reply)}`);
    // The DPI/color values may live further into this same reply; once its layout
    // is confirmed from a real dump we can populate the DPI tab from it here.
    flash('syncMsg', true, `Active stage synced (Stage ${decodeStage(reply[4]) + 1}). Full DPI/colour read-back isn't supported by this firmware's single-shot reads — see the Console dump.`);
  } catch { flash('syncMsg', false, 'Read timed out — this firmware may not support read-back over this link.'); }
}

/* ================= Profiles ================= */
const PKEY = 'dawg_profiles';
const loadProfiles = () => { try { return JSON.parse(localStorage.getItem(PKEY)) || {}; } catch { return {}; } };
const saveProfiles = (p) => localStorage.setItem(PKEY, JSON.stringify(p));
function refreshProfileSel(sel) {
  const s = $('#profileSel'), profs = loadProfiles(); s.innerHTML = '<option value="">— none —</option>';
  Object.keys(profs).sort().forEach(n => { const o = document.createElement('option'); o.textContent = n; if (n === sel) o.selected = true; s.appendChild(o); });
}
function collectConfig() {
  return {
    v: 1,
    dpi: {
      count: stageCount, xy: xyMode, active: +($('input[name=activeStage]:checked')?.value || 0),
      stages: $$('.stage').map(r => ({ x: +r.querySelector('.dpiX').value, y: +(r.querySelector('.dpiY')?.value || r.querySelector('.dpiX').value) })),
      colors: $$('.dpiColor').map(i => i.value),
    },
    light: { mode: +$('#lightMode').value, bri: +$('#lightBri').value, speed: +$('#lightSpeed').value, color: $('#lightColor').value, dir: $('#lightDir').value, custom7: custom7.slice() },
    buttons: buttonState.map(s => s),
    poll: { conn: $('#pollConn').value, rate: +$('#pollRate').value },
    adv: { lod: +$('#lod').value, angleSnap: $('#angleSnap').checked, motionSync: $('#motionSync').checked, sleep: +$('#sleepMin').value, debounce: +$('#debounce').value },
  };
}
function applyConfigToUI(c) {
  if (!c) return;
  if (c.dpi) {
    stageCount = c.dpi.count || stageCount; xyMode = !!c.dpi.xy; buildDpi();
    const rows = $$('.stage');
    (c.dpi.stages || []).forEach((s, i) => { if (!rows[i]) return; rows[i].querySelector('.dpiX').value = s.x; if (xyMode && rows[i].querySelector('.dpiY')) rows[i].querySelector('.dpiY').value = s.y; });
    (c.dpi.colors || []).forEach((v, i) => { if (rows[i]) rows[i].querySelector('.dpiColor').value = v; });
    const rb = $(`input[name=activeStage][value="${c.dpi.active || 0}"]`); if (rb) rb.checked = true;
  }
  if (c.light) {
    if (Array.isArray(c.light.custom7)) c.light.custom7.forEach((v, i) => custom7[i] = v);
    buildLight();
    $('#lightMode').value = c.light.mode ?? 0; $('#lightBri').value = c.light.bri ?? 8; $('#lightSpeed').value = c.light.speed ?? 8;
    $('#lightColor').value = c.light.color || '#ff0000'; $('#lightDir').value = c.light.dir ?? '';
    lightModeChange();
  }
  if (Array.isArray(c.buttons)) { c.buttons.forEach((s, i) => buttonState[i] = s); buildButtons(); }
  if (c.poll) { $('#pollConn').value = c.poll.conn || 'wired'; $('#pollRate').value = c.poll.rate || 4; }
  if (c.adv) { $('#lod').value = c.adv.lod || 1; $('#angleSnap').checked = !!c.adv.angleSnap; $('#motionSync').checked = !!c.adv.motionSync; $('#sleepMin').value = c.adv.sleep ?? 5; $('#debounce').value = c.adv.debounce || 0; }
}
async function writeAllToMouse() {
  if (!hidDevice) { flash('syncMsg', false, 'Connect USB first'); return; }
  try {
    await send(dpiPacket(), 'setDPI'); await sleep(30);
    await send(colorsPacket(), 'setColors'); await sleep(30);
    await send(lightPacket(), 'setLight'); await sleep(30);
    await send(P.setButtons(buttonState), 'setButtons'); await sleep(30);
    await send(P.setPollingRate(+$('#pollRate').value, $('#pollConn').value === 'wireless'), 'setPolling'); await sleep(30);
    await send(P.setLiftoff(+$('#lod').value, $('#angleSnap').checked, $('#motionSync').checked), 'setLOD'); await sleep(30);
    await send(P.setMotion({ sleepMinutes: +$('#sleepMin').value || 5, buttonResponseMs: +$('#debounce').value || 0 }), 'setMotion');
    flash('syncMsg', true, 'Wrote all settings to the mouse ✓');
  } catch (e) { flash('syncMsg', false, e.message); }
}
function profSave() {
  const name = prompt('Profile name:', $('#profileSel').value || 'My profile'); if (!name) return;
  const p = loadProfiles(); p[name] = collectConfig(); saveProfiles(p); refreshProfileSel(name); flash('syncMsg', true, `Saved "${name}"`);
}
function profLoad() { const n = $('#profileSel').value; if (!n) return; const p = loadProfiles(); if (p[n]) { applyConfigToUI(p[n]); flash('syncMsg', true, `Loaded "${n}" — press Apply or Write all to send`); } }
function profDelete() { const n = $('#profileSel').value; if (!n) return; if (!confirm(`Delete profile "${n}"?`)) return; const p = loadProfiles(); delete p[n]; saveProfiles(p); refreshProfileSel(); flash('syncMsg', true, `Deleted "${n}"`); }
function profExport() {
  const n = $('#profileSel').value, cfg = (n && loadProfiles()[n]) || collectConfig();
  const blob = new Blob([JSON.stringify({ name: n || 'current', config: cfg }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (n || 'dawg-profile') + '.json'; a.click(); URL.revokeObjectURL(a.href);
}
function profImport(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const data = JSON.parse(rd.result), cfg = data.config || data, name = data.name || file.name.replace(/\.json$/i, '');
      const p = loadProfiles(); p[name] = cfg; saveProfiles(p); refreshProfileSel(name); applyConfigToUI(cfg); flash('syncMsg', true, `Imported "${name}"`);
    } catch (e) { flash('syncMsg', false, 'Bad JSON: ' + e.message); }
  };
  rd.readAsText(file);
}

/* ================= init ================= */
window.addEventListener('error', (e) => log('err', 'JS: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => log('err', 'Promise: ' + (e.reason?.message || e.reason)));
const sup = { hid: 'hid' in navigator, ble: 'bluetooth' in navigator };
if (!sup.hid) $('#connCallout').innerHTML = '<span><b>Unsupported browser.</b> WebHID isn\'t available — use Chrome, Edge or Opera on desktop.</span>';
$('#btnBle').onclick = connectBle; $('#btnHid').onclick = connectHid; $('#calloutHid').onclick = connectHid; $('#btnReadUsb').onclick = readUsb;
$('#btnApplyDpi').onclick = applyDpi; $('#btnApplyColors').onclick = applyColors;
$('#btnApplyLight').onclick = applyLight;
$('#btnApplyButtons').onclick = applyButtons; $('#btnResetButtons').onclick = resetButtons;
$('#btnRec').onclick = toggleRecord; $('#btnClearMacro').onclick = () => { macroEvents = []; recRaw = []; renderMacro(); };
$('#btnSaveMacro').onclick = saveMacro;
$('#btnApplyPoll').onclick = applyPoll; $('#btnApplyLod').onclick = applyLod; $('#btnApplyMotion').onclick = applyMotion;
$('#btnFactory').onclick = factory; $('#btnSend').onclick = consoleSend; $('#btnClear').onclick = () => $('#console').innerHTML = '';
$('#btnSetFire').onclick = setFire;
$('#btnSyncMouse').onclick = syncFromMouse; $('#btnWriteAll').onclick = writeAllToMouse;
$('#btnProfLoad').onclick = profLoad; $('#btnProfSave').onclick = profSave; $('#btnProfDelete').onclick = profDelete;
$('#btnProfExport').onclick = profExport; $('#btnProfImport').onclick = () => $('#profFile').click();
$('#profFile').onchange = (e) => { if (e.target.files[0]) profImport(e.target.files[0]); e.target.value = ''; };
$('#btnBle').disabled = !sup.ble; $('#btnHid').disabled = !sup.hid;

window.addEventListener('keydown', (e) => { if (onKbdCapture(e)) return; onKey(true)(e); });
window.addEventListener('keyup', onKey(false));
const rz = $('#recZone');
rz.addEventListener('mousedown', onMouse(true)); rz.addEventListener('mouseup', onMouse(false));
rz.addEventListener('contextmenu', e => { if (recording) e.preventDefault(); });

buildDpi(); buildLight(); buildButtons(); buildPoll(); buildMacroBtnSelect(); buildFireSelects(); refreshProfileSel();
log('sys', 'Ready.');
