# daWg Slay50 — Web Configurator

A browser-based replacement for the daWg Slay50 mouse software. **Nothing is
installed on your PC** and **no data leaves your browser** — the page talks to
the mouse directly via WebHID (config over USB) and Web Bluetooth (battery).

The whole protocol was reverse-engineered from the vendor app; see
[`protocol.js`](./protocol.js) for the annotated command reference.

## Features

- 🔋 **Battery + firmware/model** — over Bluetooth (works wirelessly), with a
  live session **battery sparkline** and a live active-DPI-stage readout
- 🎯 **DPI** — up to 5 stages, active stage, per-stage indicator color, and an
  **independent X / Y sensitivity** mode
- 💡 **Lighting** — effect, brightness, speed, color, plus effect **direction**
- 🖱️ **Button remap** — reassign all 6 buttons (clicks, DPI, media, system
  shortcuts, keyboard combos, disable…) and **turbo / rapid-fire**
- 🎬 **Macros** — record key/mouse sequences, edit timing, bind with repeat modes
- ⚙️ **Advanced** — polling rate (**separate wired / wireless**), lift-off
  distance, sleep timer, **button debounce**, factory reset
- 🔄 **Sync from mouse** — read the stored config back into the app
- 💾 **Profiles** — save/load named setups, **export/import** as JSON, and
  **Write all** to push every section at once
- 🔧 **HID console** — raw report send/receive

### Confidence

- **Verified from the binary** (exact bytes match the vendor app): framing +
  checksum, DPI values & encoding (incl. the separate X/Y bytes), DPI colors,
  button remap, turbo (same shape as the vendor's double-click), reads.
- **Best-effort** (correct format, labels/codes worth a visual check, marked
  `beta` in the UI): polling-rate Hz labels, the wireless polling sub-code,
  lighting-effect names/order and direction, brightness shortcuts, and the
  DPI/color values parsed by **Sync**. The mouse shows the real result
  instantly, so watch it while you try them — cross-check Sync against the
  Console's raw dump before trusting a read-back value.

## Requirements

- **Chrome, Edge, or Opera** on desktop (WebHID/Web Bluetooth aren't in Firefox/Safari).
- **A USB cable** to change settings — the mouse does not accept configuration
  over Bluetooth (the vendor app has the same limitation). Battery/firmware work
  over Bluetooth.
- Served over **HTTPS** or `localhost`. GitHub Pages is HTTPS, so it just works.

## Run locally

```bash
python -m http.server 8000    # then open http://localhost:8000
```

Connect **USB** on the Overview tab, pick “USB Gaming Mouse”, then use the tabs.

## Host on GitHub Pages

1. Put `index.html`, `app.js`, `styles.css`, `protocol.js` in a new repo.
2. Push to `main`.
3. Settings → Pages → Deploy from branch → `main` / root.
4. Live at `https://<user>.github.io/<repo>/`.

## Device facts (for reference)

- daWg Slay50 = BLE + 2.4G + USB gaming mouse (OEM “XiChen”), sensor id `0x11`.
- Config transport: interface **MI_02**, HID usage `0xFF01/0x10`, 33-byte reports.
- USB `088D:062E`, 2.4G dongle `089D:062F`.
- Report: `[00, cmd, 00, 01, len, …payload…, checksum]`, checksum = Σbytes[5..31] & 0xFF.
