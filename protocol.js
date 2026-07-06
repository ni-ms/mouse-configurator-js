/*
 * protocol.js — daWg Slay50 configuration protocol
 * =================================================
 * Reverse-engineered from the vendor app (daWg-Slay-50.exe, XiChen OEM) by
 * static analysis — decompiled command builders + the device's own data files.
 * NOTHING here was guessed at the framing level; a few high-level mappings
 * (polling Hz codes, lighting effect order) are marked BEST-EFFORT and are easy
 * to confirm live with the HID Console.
 *
 * TRANSPORT
 *   USB cable  : VID 0x088D / PID 0x062E, interface MI_02
 *   2.4G dongle: VID 0x089D / PID 0x062F, interface MI_02
 *   Bluetooth  : NOT supported for config (the app says so outright)
 *   MI_02 = HID usagePage 0xFF01, usage 0x10, 33-byte OUTPUT/INPUT reports.
 *
 * WIRE FORMAT (33 bytes)
 *   [0]  = 0x00                 report ID (WebHID: reportId 0, data = bytes 1..32)
 *   [1]  = command
 *   [2]  = 0x00
 *   [3]  = 0x01
 *   [4]  = length / sub-code    (command specific)
 *   [5..31] = payload (27 bytes)
 *   [32] = checksum = (sum of bytes[5..31]) & 0xFF
 */

export const IDS = {
  usb:    { vendorId: 0x088d, productId: 0x062e },
  dongle: { vendorId: 0x089d, productId: 0x062f },
  configUsagePage: 0xff01,
  configUsage: 0x10,
};

export const BLE = {
  batteryService: 'battery_service',
  batteryLevel:   'battery_level',
  deviceInfoService: 'device_information',
  deviceInfo: [
    { uuid: 'manufacturer_name_string', label: 'Manufacturer' },
    { uuid: 'model_number_string',      label: 'Model'        },
    { uuid: 'firmware_revision_string', label: 'Firmware'     },
    { uuid: 'hardware_revision_string', label: 'Hardware'     },
    { uuid: 'software_revision_string', label: 'Software'     },
    { uuid: 'serial_number_string',     label: 'Serial'       },
  ],
};

/* ---- device model (from device/mouse.xml) ------------------------------- */
export const MODEL = {
  sensor: 0x11,                 // this mouse; drives the DPI encoder below
  dpiStages: 5,                 // configurable stages
  dpiMax: 12000,
  dpiMin: 100,
  defaultDpis: [800, 1600, 3200, 6400, 12000, 12000],
  buttons: [                    // 6 physical buttons (key_value order)
    { index: 0, name: 'Left click' },
    { index: 1, name: 'Right click' },
    { index: 2, name: 'Middle click' },
    { index: 4, name: 'Forward' },
    { index: 3, name: 'Back' },
    { index: 5, name: 'DPI loop' },
  ],
};

/* ---- framing ------------------------------------------------------------ */
// body = bytes starting at buffer[4] (the length/sub-code byte). Returns the
// full 33-byte report *including* the leading report-ID byte (buf[0]=0).
export function frame(cmd, body = []) {
  const buf = new Uint8Array(33);
  buf[1] = cmd & 0xff;
  buf[3] = 0x01;
  for (let i = 0; i < body.length && i < 28; i++) buf[4 + i] = body[i] & 0xff;
  let sum = 0;
  for (let i = 5; i <= 31; i++) sum = (sum + buf[i]) & 0xff;
  buf[32] = sum;
  return buf;
}

/* ---- DPI value <-> raw sensor code (sensor 0x11), exactly as FUN_0041f540 */
export function dpiToRaw(dpi, sensor = MODEL.sensor) {
  if (sensor === 0x11) {
    if (dpi > 12999) return Math.floor((dpi - 13000) / 1000) + 221;
    if (dpi < 10001) return Math.floor(dpi / 50);
    return Math.floor((dpi - 10000) / 100) + 200;
  }
  return Math.floor(dpi / 100); // generic fallback
}
export function rawToDpi(raw, sensor = MODEL.sensor) {
  if (sensor === 0x11) {
    if (raw < 200) return raw * 50;
    if (raw > 220) return (raw - 208) * 1000;
    return (raw - 100) * 100;
  }
  return raw * 100;
}

/* ---- command builders --------------------------------------------------- */

// 0x02 — polling rate.  code is the device's rate index.
// BEST-EFFORT Hz map (verify live): 1=125, 2=250, 3=500, 4=1000.
export const POLLING = [
  { code: 1, hz: 125 }, { code: 2, hz: 250 }, { code: 3, hz: 500 }, { code: 4, hz: 1000 },
];
// The vendor stores report_rate and report_rate_wireless separately, so the
// wired (USB) and wireless (2.4G dongle) rates can differ. sub-code 0x01 = wired
// (verified), 0x02 = wireless (BEST-EFFORT — confirm live).
export function setPollingRate(code, wireless = false) {
  return frame(0x02, [wireless ? 0x02 : 0x01, code & 0xff]);
}

// 0x03 — DPI stages. dpis = array (1..6); each entry is a number (X=Y) or an
// {x, y} pair for independent per-axis sensitivity. activeIndex is 0-based.
// The wire format has always carried X and Y separately (4 bytes/stage:
// xLo xHi yLo yHi) — passing a number just sets them equal.
// All 6 slots must hold a valid DPI (the vendor duplicates the last stage into
// unused slots — a 0 there makes the DPI loop stall and DPI+/- misbehave).
export function setDpi(dpis, activeIndex = 0, sensor = MODEL.sensor) {
  const count = Math.max(1, Math.min(dpis.length, 6));
  const asXY = (v) => (v && typeof v === 'object') ? { x: v.x, y: v.y } : { x: v, y: v };
  const last = asXY(dpis[count - 1] || MODEL.dpiMax);
  const body = [0x26, 0x00, ((activeIndex & 0x0f) << 4) | (count & 0x0f)];
  for (let i = 0; i < 6; i++) {
    const { x, y } = i < count ? asXY(dpis[i]) : last;   // fill spare slots with last stage
    const xr = dpiToRaw(x, sensor), yr = dpiToRaw(y, sensor);
    body.push(xr & 0xff, (xr >> 8) & 0xff, yr & 0xff, (yr >> 8) & 0xff);
  }
  return frame(0x03, body);
}

// Active-stage read: send request then fetch; reply byte[4] = active stage index.
export function readActiveDpiRequest() { return frame(0x0e, [0x01, 0x01]); }
export function readActiveDpiFetch() { return frame(0x15, []); }

// 0x04 — per-stage DPI colors. colors = array of 6 {r,g,b}.
export function setDpiColors(colors) {
  const body = [0x12];
  for (let i = 0; i < 6; i++) {
    const c = colors[i] || { r: 0, g: 0, b: 0 };
    body.push(c.r & 0xff, c.g & 0xff, c.b & 0xff);
  }
  return frame(0x04, body);
}

// 0x05 — lighting effect.
// modeClass determines payload shape (from FUN_004363e0):
//   simple : buf4=2, [mode, bri<<4|speed]
//   single : buf4=5, [mode, bri<<4|speed, r,g,b]
//   custom7: buf4=0x18, [mode, bri<<4|speed, 7, 7×rgb]
// BEST-EFFORT effect list (order/labels verify live):
export const LIGHT_EFFECTS = [
  { mode: 0, name: 'Off',           kind: 'simple' },
  { mode: 1, name: 'Constant',      kind: 'single' },
  { mode: 2, name: 'Custom (7)',    kind: 'custom7' },
  { mode: 3, name: 'Breathing',     kind: 'single' },
  { mode: 4, name: 'Flowing',       kind: 'simple' },
  { mode: 5, name: 'Colorful wave', kind: 'simple' },
];
// The first body byte is the payload length (simple=2, single=5, custom7=0x18).
// `direction` (0/1) is appended for effects that flow, bumping the length by one.
// BEST-EFFORT: the light schema carries a direction field; confirm the reverse
// actually flips live. Leave `direction` undefined to send the verified packet.
export function setLighting({ mode, kind, brightness = 4, speed = 3, color = { r: 255, g: 0, b: 0 }, colors7 = [], direction }) {
  const bs = ((brightness & 0x0f) << 4) | (speed & 0x0f);
  const dir = direction === undefined ? [] : [direction & 0xff];
  if (kind === 'custom7') {
    const body = [0x18, mode & 0xff, bs, 7];
    for (let i = 0; i < 7; i++) {
      const c = colors7[i] || color;
      body.push(c.r & 0xff, c.g & 0xff, c.b & 0xff);
    }
    return frame(0x05, body);
  }
  if (kind === 'single') {
    return frame(0x05, [0x05 + dir.length, mode & 0xff, bs, color.r & 0xff, color.g & 0xff, color.b & 0xff, ...dir]);
  }
  return frame(0x05, [0x02 + dir.length, mode & 0xff, bs, ...dir]); // simple
}

// 0x06 — lift-off distance + toggles (angle snap / motion sync).
export function setLiftoff(heightMm = 1, angleSnap = false, motionSync = false) {
  return frame(0x06, [0x05, heightMm & 0xff, motionSync ? 1 : 0, angleSnap ? 1 : 0]);
}

// 0x07 — power / motion behaviour.
export function setMotion({ sleepMinutes = 5, wakeOnMove = 0, dimOnStill = 1, buttonResponseMs = 0 }) {
  return frame(0x07, [0x04, sleepMinutes & 0xff, wakeOnMove & 0xff, dimOnStill & 0xff, buttonResponseMs & 0xff]);
}

// 0x0f — factory reset (restore defaults).
export function factoryReset() {
  return frame(0x0f, [0xff, 0x01]);
}

/* ---- button remap (0x09) ----------------------------------------------- */
// Each button = 3 bytes {type, v1, v2}. Catalog derived from FUN_004357a0.
// `build(entryArgs)` returns [type, v1, v2].
export const BUTTON_FUNCTIONS = [
  // Mouse buttons (type 0x20). v1 = mouse mask.
  { id: 'left',       label: 'Left click',    bytes: [0x20, 0x01, 0x00] },
  { id: 'right',      label: 'Right click',   bytes: [0x20, 0x02, 0x00] },
  { id: 'middle',     label: 'Middle click',  bytes: [0x20, 0x04, 0x00] },
  { id: 'forward',    label: 'Forward',       bytes: [0x20, 0x10, 0x00] },
  { id: 'back',       label: 'Back',          bytes: [0x20, 0x08, 0x00] },
  { id: 'dblclick',   label: 'Double click',  bytes: [0x40, 0x01, 0x02] }, // fire type, left x2
  // DPI functions (type 0x50). Sub-code verified by device behaviour:
  //   0x01 = loop (cycles every active stage and wraps back to the first)
  //   0x02 = DPI up (+),  0x03 = DPI down (-)
  { id: 'dpi_loop',   label: 'DPI loop',      bytes: [0x50, 0x01, 0x00] },
  { id: 'dpi_up',     label: 'DPI +',         bytes: [0x50, 0x02, 0x00] },
  { id: 'dpi_down',   label: 'DPI -',         bytes: [0x50, 0x03, 0x00] },
  // Multimedia / consumer (type 0x90).
  { id: 'play',       label: 'Play / Pause',  bytes: [0x90, 0xcd, 0x00] },
  { id: 'stop',       label: 'Stop',          bytes: [0x90, 0xb7, 0x00] },
  { id: 'prev',       label: 'Previous',      bytes: [0x90, 0xb6, 0x00] },
  { id: 'next',       label: 'Next',          bytes: [0x90, 0xb5, 0x00] },
  { id: 'volup',      label: 'Volume +',      bytes: [0x90, 0xe9, 0x00] },
  { id: 'voldown',    label: 'Volume -',      bytes: [0x90, 0xea, 0x00] },
  { id: 'mute',       label: 'Mute',          bytes: [0x90, 0xe2, 0x00] },
  // System shortcuts (type 0x90 extended).
  { id: 'calc',       label: 'Calculator',    bytes: [0x90, 0x92, 0x01] },
  { id: 'mycomputer', label: 'My Computer',   bytes: [0x90, 0x94, 0x01] },
  // Keyboard-shortcut convenience entries (type 0x80 = keyboard: [0x80, mod, usage]).
  { id: 'refresh',    label: 'Refresh (F5)',  bytes: [0x80, 0x00, 0x3e] },   // F5, no modifier
  { id: 'switchapp',  label: 'Switch app (Alt+Tab)', bytes: [0x80, 0x04, 0x2b] }, // Alt+Tab
  // Consumer-page brightness (type 0x90). BEST-EFFORT codes — verify live.
  { id: 'bright_up',   label: 'Brightness +', bytes: [0x90, 0x6f, 0x00], beta: true },
  { id: 'bright_down', label: 'Brightness -', bytes: [0x90, 0x70, 0x00], beta: true },
  // Disable the button entirely.
  { id: 'disable',    label: 'Disable',       bytes: [0x60, 0x00, 0x00] },
];

// Turbo / rapid-fire (button type 0x40): fire a target N times.
// Layout is [0x40, targetMask, count] — the same shape the vendor uses for
// "double click" ([0x40, 0x01, 0x02]). count 0 = fire continuously while held.
// The per-button binding has no interval byte; the mouse uses its own cadence.
export const FIRE_TARGETS = [
  { id: 'left',   label: 'Left click',   mask: 0x01 },
  { id: 'right',  label: 'Right click',  mask: 0x02 },
  { id: 'middle', label: 'Middle click', mask: 0x04 },
];
export function fireBinding(mask, count) { return { fire: true, mask: mask & 0xff, count: count & 0xff }; }

// entries[i] is either a function-id string, or a macro binding object:
//   { macro: true, keyId, loop: 'once'|'repeat'|'hold', count }
export function setButtons(entries) {
  const body = [0x0f];
  MODEL.buttons.forEach((btn, i) => {
    const e = entries[i];
    if (e && typeof e === 'object' && e.macro) {
      let v1 = e.keyId & 0x0f;
      if (e.loop === 'once') v1 |= 0x10;
      else if (e.loop === 'hold') v1 |= 0x40;
      else v1 |= 0x20;                       // repeat N
      const v2 = e.loop === 'repeat' ? (e.count & 0xff) : 0;
      body.push(0xa0, v1, v2);
    } else if (e && typeof e === 'object' && e.fire) {
      body.push(0x40, e.mask & 0xff, e.count & 0xff);   // turbo / rapid-fire
    } else if (e && typeof e === 'object' && e.kbd) {
      body.push(0x80, e.mod & 0xff, e.usage & 0xff);   // keyboard key/combo
    } else {
      const fn = BUTTON_FUNCTIONS.find(f => f.id === e) || BUTTON_FUNCTIONS[0];
      body.push(fn.bytes[0], fn.bytes[1], fn.bytes[2]);
    }
  });
  return frame(0x09, body);
}

// Keyboard-combo helpers for button assignment (type 0x80).
export function modBitsFromEvent(e) { return (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0); }
export function comboLabel(mod, code) {
  const p = [];
  if (mod & 1) p.push('Ctrl'); if (mod & 2) p.push('Shift'); if (mod & 4) p.push('Alt'); if (mod & 8) p.push('Win');
  p.push((code || '').replace(/^(Key|Digit)/, '') || '?');
  return p.join('+');
}

/* ---- macros (0x08) ------------------------------------------------------ */
// HID keyboard usage ids by KeyboardEvent.code (common subset).
export const KEY_HID = {
  KeyA:0x04,KeyB:0x05,KeyC:0x06,KeyD:0x07,KeyE:0x08,KeyF:0x09,KeyG:0x0a,KeyH:0x0b,KeyI:0x0c,
  KeyJ:0x0d,KeyK:0x0e,KeyL:0x0f,KeyM:0x10,KeyN:0x11,KeyO:0x12,KeyP:0x13,KeyQ:0x14,KeyR:0x15,
  KeyS:0x16,KeyT:0x17,KeyU:0x18,KeyV:0x19,KeyW:0x1a,KeyX:0x1b,KeyY:0x1c,KeyZ:0x1d,
  Digit1:0x1e,Digit2:0x1f,Digit3:0x20,Digit4:0x21,Digit5:0x22,Digit6:0x23,Digit7:0x24,
  Digit8:0x25,Digit9:0x26,Digit0:0x27,Enter:0x28,Escape:0x29,Backspace:0x2a,Tab:0x2b,
  Space:0x2c,Minus:0x2d,Equal:0x2e,BracketLeft:0x2f,BracketRight:0x30,Backslash:0x31,
  Semicolon:0x33,Quote:0x34,Backquote:0x35,Comma:0x36,Period:0x37,Slash:0x38,CapsLock:0x39,
  F1:0x3a,F2:0x3b,F3:0x3c,F4:0x3d,F5:0x3e,F6:0x3f,F7:0x40,F8:0x41,F9:0x42,F10:0x43,F11:0x44,F12:0x45,
  PrintScreen:0x46,ScrollLock:0x47,Pause:0x48,Insert:0x49,Home:0x4a,PageUp:0x4b,Delete:0x4c,
  End:0x4d,PageDown:0x4e,ArrowRight:0x4f,ArrowLeft:0x50,ArrowDown:0x51,ArrowUp:0x52,
};
// modifier KeyboardEvent.code -> device modifier bit (from FUN_0044f3a0).
export const MOD_BIT = {
  ControlLeft:0x01, ShiftLeft:0x02, AltLeft:0x04, MetaLeft:0x08,
  ControlRight:0x10, ShiftRight:0x20, AltRight:0x40, MetaRight:0x80,
};
// mouse button index -> device mask (as used by mouse events in macros).
export const MOUSE_MASK = { 0:0x01, 2:0x04, 1:0x02, 3:0x08, 4:0x10 };

// event: { kind:'key'|'mouse', down:bool, code, mask, delay(ms) }.
// Encoded as 4 bytes [type, delayLo, delayHi, value]; delay = time until next event.
export function encodeMacroEvent(ev) {
  const d = Math.max(0, Math.min(0xffff, ev.delay | 0));
  const dLo = d & 0xff, dHi = (d >> 8) & 0xff;
  if (ev.kind === 'mouse') return [ev.down ? 0x10 : 0x90, dLo, dHi, ev.mask & 0xff];
  const mod = MOD_BIT[ev.code];
  if (mod !== undefined) return [ev.down ? 0x20 : 0xa0, dLo, dHi, mod];
  return [ev.down ? 0x30 : 0xb0, dLo, dHi, (KEY_HID[ev.code] || 0) & 0xff];
}

function frame08(b3, len, payload) {
  const buf = new Uint8Array(33);
  buf[1] = 0x08; buf[3] = b3 & 0xff; buf[4] = len & 0xff;
  for (let i = 0; i < payload.length && i < 27; i++) buf[5 + i] = payload[i] & 0xff;
  let s = 0; for (let i = 5; i <= 31; i++) s = (s + buf[i]) & 0xff; buf[32] = s;
  return buf;
}
// Returns an array of 33-byte packets to upload a macro's steps to `keyId`.
export function setMacroSteps(keyId, events) {
  const data = [keyId & 0xff];
  for (const ev of events) data.push(...encodeMacroEvent(ev));
  if (events.length < 7) return [frame08(0x01, data.length, data)];
  const CHUNK = 0x1b, n = Math.ceil(data.length / CHUNK), packets = [];
  for (let p = 0; p < n; p++) {
    const chunk = data.slice(p * CHUNK, (p + 1) * CHUNK);
    packets.push(frame08(((p << 4) | n) & 0xff, chunk.length, chunk));
  }
  return packets;
}

/* ---- reads (0x11..0x17) ------------------------------------------------- */
// Send these (flag=read), then parse the reply. Parsers take the 33-byte reply.
export const READS = { info: 0x11, rate: 0x12, dpi: 0x13, dpiColor: 0x14, more: 0x15 };
export function readCmd(id) { return frame(id, []); }

// reply[1] == 0 means success (device ack). Battery lives in the 0x11 reply.
export function parseInfo(reply) {
  // Layout mirrors FUN_00434190's cached-struct parse (offsets within payload).
  return {
    ok: reply[1] === 0,
    sensor: reply[0x0c],       // sensor id
    dpiIndex: reply[0x0f],     // active stage
    batteryPct: reply[0x0e],   // %
  };
}

// BEST-EFFORT reply parsers for Sync-from-mouse. These mirror the write layouts,
// but the exact reply offsets weren't byte-verified — always cross-check against
// the raw dump in the Console before trusting a synced value.
//
// 0x13 DPI reply: assumed to echo the 0x03 write body — [.., active<<4|count,
// then 6×(xLo xHi yLo yHi)] starting at reply[6].
export function parseDpiReply(reply) {
  const ac = reply[6] || 0;
  const stages = [];
  for (let i = 0; i < 6; i++) {
    const o = 7 + i * 4;
    stages.push({
      x: rawToDpi(reply[o] | (reply[o + 1] << 8)),
      y: rawToDpi(reply[o + 2] | (reply[o + 3] << 8)),
    });
  }
  return { activeIndex: ac >> 4, count: ac & 0x0f, stages };
}
// 0x14 DPI-color reply: assumed 6×RGB starting at reply[6].
export function parseDpiColorReply(reply) {
  const colors = [];
  for (let i = 0; i < 6; i++) { const o = 6 + i * 3; colors.push({ r: reply[o], g: reply[o + 1], b: reply[o + 2] }); }
  return colors;
}
// 0x12 rate reply: assumed [.., subcode, code] with the code at reply[6].
export function parseRateReply(reply) { return { code: reply[6] }; }
