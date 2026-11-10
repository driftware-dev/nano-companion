/*
 * Nano Companion — interface web pour le BLEShark Nano (InfiShark)
 * Copyright (C) 2026 Kestrall
 *
 * Logiciel libre sous licence GNU GPL v3 (voir LICENSE). Réimplémente le
 * protocole USB du SDK InfiShark, lui-même GPL-3.0 (voir NOTICE.md).
 * Distribué SANS AUCUNE GARANTIE.
 */

// Protocole USB du BLEShark Nano (repris du SDK officiel infishark, core/src).
// Trame : B5 5A C1 | version | type | seq_le | len_le | payload | crc16_le
// Le CRC16-CCITT (init 0xFFFF) couvre tout ce qui suit le magic.

export const MAGIC = [0xb5, 0x5a, 0xc1];
const VERSION = 0x01;
const MAX_PAYLOAD = 512;
export const PKT = { COMMAND: 0x10, RESPONSE: 0x11, EVENT: 0x12, ERROR: 0x7f };
const RESP_MORE = 1 << 1;
const ERR_BUSY = 5;

export const CMD = {
  DEVICE_INFO: 0x0001, SYSTEM_STATUS: 0x0002,
  WIFI_SCAN: 0x0100, WIFI_PORTAL: 0x0113, WIFI_RAW_TX: 0x0120, WIFI_RAW_MONITOR: 0x0121,
  BLE_SCAN: 0x0200, BLE_RESET: 0x0203, BLE_HID: 0x0211, BLE_HID_SEND: 0x0212,
  BLE_ADV: 0x0213, BLE_SERVE: 0x0214, BLE_CHAR_SET: 0x0215,
  BLE_GATT_CONNECT: 0x0220, BLE_GATT_ENUM: 0x0221, BLE_GATT_READ: 0x0222,
  BLE_GATT_WRITE: 0x0223, BLE_GATT_SUBSCRIBE: 0x0224, BLE_GATT_UNSUBSCRIBE: 0x0225,
  IR_RX: 0x0300, IR_TX: 0x0310, IR_TVBGONE: 0x0311, IR_RAW_TX: 0x0320,
  MESH_STATUS: 0x0400, MESH_NODES: 0x0401,
  FILES_LIST: 0x0500, FILES_READ_CHUNK: 0x0501,
  STOP: 0x7f00,
};
export const EVT = {
  SCAN_DONE: 0x0002, BLE_DEVICE: 0x0004, BLE_NOTIFY: 0x0005, WIFI_FRAME: 0x0006,
  BLE_WRITE: 0x0008, BLE_CONNECT: 0x0009, BLE_SUBSCRIBE: 0x000a, BLE_HID_OUTPUT: 0x000b,
  WIFI_DEVICE: 0x000c, IR: 0x000d, PORTAL_REQUEST: 0x000e, WIFI_TX: 0x000f,
};

const ERRORS = {
  1: "trame invalide", 2: "version non supportée", 3: "action interdite",
  4: "commande inconnue", 5: "le Nano est occupé", 6: "erreur interne",
  7: "paramètres invalides", 8: "introuvable",
};

export function crc16(bytes, crc = 0xffff) {
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeCommand(seq, opcode, args = new Uint8Array()) {
  const plen = 2 + args.length;
  const covered = new Uint8Array(6 + plen);
  covered.set([VERSION, PKT.COMMAND, seq & 0xff, seq >> 8, plen & 0xff, plen >> 8, opcode & 0xff, opcode >> 8]);
  covered.set(args, 8);
  const crc = crc16(covered);
  const out = new Uint8Array(3 + covered.length + 2);
  out.set(MAGIC);
  out.set(covered, 3);
  out.set([crc & 0xff, crc >> 8], 3 + covered.length);
  return out;
}

// Arguments « locaux » (portée mesh = cet appareil) : octet 0 puis JSON éventuel.
export function localArgs(obj = {}) {
  const json = Object.keys(obj).length ? enc.encode(JSON.stringify(obj)) : new Uint8Array();
  const out = new Uint8Array(1 + json.length);
  out.set(json, 1);
  return out;
}
export const jsonArgs = (obj) => enc.encode(JSON.stringify(obj));

// Démultiplexeur : extrait les trames valides, rend le reste comme texte de log.
export class Demuxer {
  constructor() { this.buf = new Uint8Array(); }
  feed(data) {
    const merged = new Uint8Array(this.buf.length + data.length);
    merged.set(this.buf); merged.set(data, this.buf.length);
    let buf = merged;
    const frames = [], logs = [];
    for (;;) {
      const idx = findMagic(buf);
      if (idx < 0) {
        const keep = tailKeep(buf);
        if (buf.length - keep > 0) logs.push(buf.slice(0, buf.length - keep));
        buf = buf.slice(buf.length - keep);
        break;
      }
      if (idx > 0) { logs.push(buf.slice(0, idx)); buf = buf.slice(idx); }
      if (buf.length < 4) break;
      if (buf[3] !== VERSION) { logs.push(buf.slice(0, 1)); buf = buf.slice(1); continue; }
      if (buf.length < 9) break;
      const typ = buf[4], seq = buf[5] | (buf[6] << 8), plen = buf[7] | (buf[8] << 8);
      if (plen > MAX_PAYLOAD) { logs.push(buf.slice(0, 1)); buf = buf.slice(1); continue; }
      const end = 9 + plen;
      if (buf.length < end + 2) break;
      if (crc16(buf.subarray(3, end)) !== (buf[end] | (buf[end + 1] << 8))) {
        logs.push(buf.slice(0, 1)); buf = buf.slice(1); continue;
      }
      frames.push({ typ, seq, payload: buf.slice(9, end) });
      buf = buf.slice(end + 2);
    }
    this.buf = buf;
    return { frames, logs };
  }
}
function findMagic(b) {
  for (let i = 0; i + 2 < b.length; i++) if (b[i] === 0xb5 && b[i + 1] === 0x5a && b[i + 2] === 0xc1) return i;
  return -1;
}
function tailKeep(b) {
  for (let k = Math.min(2, b.length); k > 0; k--) {
    let ok = true;
    for (let j = 0; j < k; j++) if (b[b.length - k + j] !== MAGIC[j]) ok = false;
    if (ok) return k;
  }
  return 0;
}

export class DeviceError extends Error {
  constructor(code, body) {
    let msg = ERRORS[code] || `erreur ${code}`;
    try { const j = JSON.parse(body); if (j.error) msg += ` (${j.error})`; } catch { if (body) msg += ` (${body})`; }
    super(msg);
    this.code = code;
  }
}

// Client haut niveau au-dessus d'un port Web Serial.
export class Nano {
  constructor({ onEvent, onLog, onTraffic, onClose } = {}) {
    this.onEvent = onEvent || (() => {});
    this.onLog = onLog || (() => {});
    this.onTraffic = onTraffic || (() => {});
    this.onClose = onClose || (() => {});
    this.seq = 0;
    this.pending = new Map();
    this.eventAcc = new Map();
    this.demux = new Demuxer();
  }

  // `link` : un SerialLink (Web Serial, PC) ou un UsbLink (WebUSB, Android).
  async connect(link) {
    this.link = link;
    this.port = link.serialPort || null; // pour l'évènement serial "disconnect"
    await link.open();
    link.onData = (value) => {
      const { frames, logs } = this.demux.feed(value);
      for (const l of logs) this.onLog(dec.decode(l));
      for (const f of frames) this.dispatch(f);
    };
    link.onError = (e) => { if (!this.closing) this.onLog(`\n[lecture interrompue : ${e.message}]\n`); };
    link.onClose = () => {
      for (const p of this.pending.values()) p.reject(new Error("Nano déconnecté"));
      this.pending.clear();
      this.onClose();
    };
    link.start();
  }

  async disconnect() {
    this.closing = true;
    await this.link?.close().catch(() => {});
  }

  // Redémarrage matériel : pulse la ligne RESET via le signal RTS. Géré par le
  // contrôleur USB de l'ESP32-C3, donc agit même quand le firmware est occupé
  // (seul moyen fiable d'interrompre une rafale bloquante comme TV-B-Gone).
  // Le Nano reboote et la connexion tombe ; l'utilisateur doit reconnecter.
  async reboot() {
    if (!this.link) throw new Error("Nano non connecté");
    await this.link.setSignals({ dataTerminalReady: false, requestToSend: true });  // RESET maintenu
    await new Promise((r) => setTimeout(r, 120));
    await this.link.setSignals({ dataTerminalReady: false, requestToSend: false }); // relâché -> redémarre
  }

  dispatch(f) {
    if ((f.typ === PKT.RESPONSE || f.typ === PKT.ERROR) && this.pending.has(f.seq)) {
      const p = this.pending.get(f.seq);
      const pl = f.payload;
      if (pl.length < 4) return;
      const error = pl[2], flags = pl[3], data = pl.slice(4);
      if (p.first) return p.resolve({ error, flags, data });
      p.chunks.push(data);
      if (p.error === undefined) p.error = error;
      if (!(flags & RESP_MORE)) p.resolve({ error: p.error, data: concat(p.chunks) });
      return;
    }
    if (f.typ === PKT.EVENT && f.payload.length >= 3) {
      const id = f.payload[0] | (f.payload[1] << 8), flags = f.payload[2];
      const acc = this.eventAcc.get(id) || [];
      acc.push(f.payload.slice(3));
      if (flags & RESP_MORE) { this.eventAcc.set(id, acc); return; }
      this.eventAcc.delete(id);
      const raw = concat(acc);
      const text = dec.decode(raw);
      let json = null;
      try { json = JSON.parse(text); } catch {}
      this.onTraffic("←", `événement 0x${id.toString(16).padStart(4, "0")}`, json ? text : `${raw.length} octets`);
      this.onEvent(id, json, text, raw);
    }
  }

  async raw(opcode, args = new Uint8Array(), { first = false, timeout = 6000 } = {}) {
    const seq = this.seq = (this.seq + 1) & 0xffff;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error("pas de réponse du Nano")); }, timeout);
      this.pending.set(seq, {
        first, chunks: [],
        resolve: (r) => { clearTimeout(timer); this.pending.delete(seq); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    this.onTraffic("→", `commande 0x${opcode.toString(16).padStart(4, "0")}`, dec.decode(args.filter((b) => b >= 0x20)));
    await this.link.write(encodeCommand(seq, opcode, args));
    return promise;
  }

  // Envoie une commande, réessaie si le Nano est occupé, lève une erreur lisible sinon.
  async call(opcode, args, opts) {
    let delay = 50, r;
    for (let i = 0; i < 4; i++) {
      r = await this.raw(opcode, args, opts);
      if (r.error !== ERR_BUSY) break;
      await new Promise((ok) => setTimeout(ok, delay));
      delay = Math.min(delay * 2, 400);
    }
    const body = dec.decode(r.data);
    if (r.error) throw new DeviceError(r.error, body);
    this.onTraffic("←", `réponse 0x${opcode.toString(16).padStart(4, "0")}`, body);
    if (opts?.first) return r;
    return body ? JSON.parse(body) : {};
  }

  info() { return this.call(CMD.DEVICE_INFO); }
  status() { return this.call(CMD.SYSTEM_STATUS); }
  mesh() { return this.call(CMD.MESH_STATUS); }
  // Liste des Nano du maillage. Absent sur certains firmwares -> renvoie [].
  async meshNodes() {
    try { const r = await this.call(CMD.MESH_NODES); return r.nodes || []; }
    catch (e) { if (e.code === 4) return []; throw e; } // 4 = commande inconnue
  }
  stop() { return this.call(CMD.STOP, localArgs()); }
  wifiScan() { return this.call(CMD.WIFI_SCAN, localArgs()); }
  bleScan(durationMs) { return this.call(CMD.BLE_SCAN, localArgs({ duration_ms: durationMs, active: true })); }
  irListen() { return this.call(CMD.IR_RX, localArgs()); }
  irSend(cap) {
    return cap.timings
      ? this.call(CMD.IR_RAW_TX, localArgs({ khz: cap.khz || 38, timings: cap.timings }))
      : this.call(CMD.IR_TX, localArgs({ protocol: cap.protocol, data: cap.data, bits: cap.bits, repeats: 0 }));
  }
  files() { return this.call(CMD.FILES_LIST); }
  irTvbgone() { return this.call(CMD.IR_TVBGONE, localArgs({})); }
  bleReset() { return this.call(CMD.BLE_RESET); }

  // --- Wi-Fi offensif ---
  // Envoie une rafale de trames 802.11 brutes. count 0 = jusqu'à stop.
  wifiRawTx(frame, channel, count, intervalMs) {
    const args = new Uint8Array(5 + frame.length);
    args[0] = channel;
    args[1] = count & 0xff; args[2] = count >> 8;
    args[3] = intervalMs & 0xff; args[4] = intervalMs >> 8;
    args.set(frame, 5);
    return this.call(CMD.WIFI_RAW_TX, args);
  }
  deauth(bssid, channel, { station = BROADCAST, reason = 7, intervalMs = 0 } = {}) {
    return this.wifiRawTx(deauthFrame(bssid, station, reason), channel, 0, intervalMs);
  }
  wifiPortal(opts) { return this.call(CMD.WIFI_PORTAL, localArgs(portalJson(opts))); }
  wifiMonitor(channel, filter = { active: true }) {
    return this.call(CMD.WIFI_RAW_MONITOR, { channel, ...filter }); // JSON direct (pas de portée locale)
  }

  // --- BLE actif ---
  bleAdv(spec) { return this.call(CMD.BLE_ADV, jsonArgs(spec)); }
  bleServe(spec) { return this.call(CMD.BLE_SERVE, jsonArgs(spec)); }
  bleHidStart(spec) { return this.call(CMD.BLE_HID, jsonArgs(spec), { timeout: 12000 }); }
  bleHidSend(spec) { return this.call(CMD.BLE_HID_SEND, jsonArgs(spec)); }
  // Tape un texte via un clavier HID BLE déjà démarré (preset "keyboard", report 1).
  async bleHidType(text, delayMs = 10) {
    const t = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    for (const c of t) {
      const k = asciiToHid(c);
      if (!k) throw new Error(`caractère non tapable : « ${c} »`);
      await this.bleHidSend(keyReport(1, k[0], k[1]));
      await new Promise((r) => setTimeout(r, delayMs));
      await this.bleHidSend(keyReport(1, 0, 0));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  gattConnect(address, addrType = 0, extra = {}) {
    return this.call(CMD.BLE_GATT_CONNECT, jsonArgs({ address, addr_type: addrType, ...extra }), { timeout: 12000 });
  }
  gattEnum() { return this.call(CMD.BLE_GATT_ENUM, new Uint8Array(), { timeout: 12000 }); }
  gattRead(uuid) { return this.call(CMD.BLE_GATT_READ, jsonArgs({ char: uuid })); }
  gattWrite(uuid, hex, response = true) { return this.call(CMD.BLE_GATT_WRITE, jsonArgs({ char: uuid, data: hex, response })); }
  gattSubscribe(uuid, indicate = false) { return this.call(CMD.BLE_GATT_SUBSCRIBE, jsonArgs({ char: uuid, indicate })); }
  gattUnsubscribe(uuid) { return this.call(CMD.BLE_GATT_UNSUBSCRIBE, jsonArgs({ char: uuid })); }

  async readFile(path) {
    const parts = [];
    let got = 0;
    for (;;) {
      const r = await this.call(CMD.FILES_READ_CHUNK, jsonArgs({ path, offset: got }), { first: true });
      if (r.data.length < 8) throw new Error("morceau de fichier trop court");
      const total = (r.data[4] | (r.data[5] << 8) | (r.data[6] << 16) | (r.data[7] << 24)) >>> 0;
      if (total > 8 * 1024 * 1024) throw new Error("fichier annoncé trop gros");
      const chunk = r.data.slice(8);
      parts.push(chunk);
      got += chunk.length;
      if (!(r.flags & RESP_MORE) || got >= total || chunk.length === 0) break;
    }
    return concat(parts);
  }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- Voies de connexion ----------
// Chaque "link" expose : open(), start(), write(bytes), setSignals(sig), close().
// Nano y branche onData / onError / onClose.

// PC : Web Serial (navigator.serial). Non disponible sur Android.
export class SerialLink {
  constructor(port) { this.port = port; this.serialPort = port; }
  async open() {
    await this.port.open({ baudRate: 921600 });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }
  async start() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) this.onData?.(value);
      }
    } catch (e) { if (!this.closing) this.onError?.(e); }
    finally { try { this.reader.releaseLock(); } catch {} this.onClose?.(); }
  }
  write(bytes) { return this.writer.write(bytes); }
  setSignals(sig) { return this.port.setSignals(sig); }
  async close() {
    this.closing = true;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
  }
}

// Android (ou PC sans Web Serial) : WebUSB. Parle à l'interface CDC Data du Nano
// (ESP32-C3 USB-Serial-JTAG) : interface 1, EP 0x01 OUT / 0x81 IN, contrôle sur
// l'interface 0 (DTR/RTS via SET_CONTROL_LINE_STATE).
export class UsbLink {
  constructor(device) {
    this.device = device; this.serialPort = null;
    this.ifCtrl = 0; this.ifData = 1; this.epOut = 1; this.epIn = 1;
  }
  async open() {
    const d = this.device;
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    // Repère l'interface CDC Data (classe 10) et ses endpoints, au cas où la
    // numérotation diffère.
    for (const itf of d.configuration.interfaces) {
      const a = itf.alternate;
      if (a.interfaceClass === 10) {
        this.ifData = itf.interfaceNumber;
        for (const ep of a.endpoints) {
          if (ep.direction === "out") this.epOut = ep.endpointNumber;
          if (ep.direction === "in") this.epIn = ep.endpointNumber;
        }
      }
      if (a.interfaceClass === 2) this.ifCtrl = itf.interfaceNumber;
    }
    try { await d.claimInterface(this.ifCtrl); } catch {}
    await d.claimInterface(this.ifData);
    await this.lineState(true, true); // DTR+RTS : le Nano commence à émettre
  }
  lineState(dtr, rts) {
    return this.device.controlTransferOut({
      requestType: "class", recipient: "interface",
      request: 0x22, value: (dtr ? 1 : 0) | (rts ? 2 : 0), index: this.ifCtrl,
    }).catch(() => {});
  }
  async start() {
    this.running = true;
    try {
      while (this.running) {
        const r = await this.device.transferIn(this.epIn, 64);
        if (r.status === "stall") { await this.device.clearHalt("in", this.epIn); continue; }
        if (r.data && r.data.byteLength) this.onData?.(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
      }
    } catch (e) { if (this.running) this.onError?.(e); }
    finally { this.onClose?.(); }
  }
  async write(bytes) { await this.device.transferOut(this.epOut, bytes); }
  setSignals({ dataTerminalReady = false, requestToSend = false } = {}) { return this.lineState(dataTerminalReady, requestToSend); }
  async close() { this.running = false; try { await this.device.close(); } catch {} }
}

// Ouvre la bonne voie selon le navigateur : Web Serial (PC) sinon WebUSB (Android).
export async function requestLink() {
  if (navigator.serial) {
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] });
    return new SerialLink(port);
  }
  if (navigator.usb) {
    const dev = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x303a }] });
    return new UsbLink(dev);
  }
  throw new Error("Ni Web Serial ni WebUSB ne sont disponibles dans ce navigateur.");
}
export const canConnect = () => !!(navigator.serial || navigator.usb);

// ---------- Constructeurs de trames (repris du SDK) ----------

export const BROADCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

export function parseMac(s) {
  const m = String(s).trim().match(/^([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})$/i);
  if (!m) throw new Error(`adresse MAC invalide : ${s}`);
  return m.slice(1).map((h) => parseInt(h, 16));
}

// Trame de désauthentification 802.11, sans FCS (la radio l'ajoute).
// FC(0xC0 00) | durée(0) | addr1=station | addr2=AP | addr3=AP | seq(0) | raison(LE)
export function deauthFrame(bssid, station = BROADCAST, reason = 7) {
  const ap = Array.isArray(bssid) ? bssid : parseMac(bssid);
  const sta = Array.isArray(station) ? station : parseMac(station);
  return new Uint8Array([0xc0, 0x00, 0x00, 0x00, ...sta, ...ap, ...ap, 0x00, 0x00, reason & 0xff, reason >> 8]);
}

export function portalJson(o = {}) {
  const m = { host_content: false };
  if (o.ssid) m.ssid = o.ssid;
  if (o.pass) m.pass = o.pass;
  if (o.channel) m.channel = o.channel;
  if (o.hidden) m.hidden = true;
  if (o.maxClients) m.max_clients = o.maxClients;
  if (o.randomMac) m.random_mac = true;
  if (o.detailed) m.detailed_capture = true;
  return m;
}

// Petit fichier .pcap (DLT 105 = IEEE 802.11 sans radiotap) à partir de trames MAC brutes.
export function buildPcap(frames) {
  const GH = 24, RH = 16;
  let len = GH;
  for (const f of frames) len += RH + f.length;
  const b = new Uint8Array(len);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0xa1b2c3d4, true); dv.setUint16(4, 2, true); dv.setUint16(6, 4, true);
  dv.setUint32(16, 65535, true); dv.setUint32(20, 105, true); // snaplen, DLT 802.11
  let o = GH;
  const now = Date.now();
  for (const f of frames) {
    const ts = now + 0;
    dv.setUint32(o, Math.floor(ts / 1000), true);
    dv.setUint32(o + 4, (ts % 1000) * 1000, true);
    dv.setUint32(o + 8, f.length, true); dv.setUint32(o + 12, f.length, true);
    b.set(f, o + RH); o += RH + f.length;
  }
  return b;
}

// Clavier HID BLE : descripteur et rapports (preset "keyboard" du SDK).
export const HID_KEYBOARD = {
  report_map: "05010906a101850105 0719e029e7150025017501950881029501750881039505750105081901290591029501750391039506750815002565050719002965 8100c0".replace(/ /g, ""),
  reports: [{ id: 1, type: "input" }, { id: 1, type: "output" }],
  appearance: 0x03c1,
};
export function keyboardSpec({ name = "Nano KB", passkey, randomMac } = {}) {
  const s = { ...HID_KEYBOARD, name };
  if (passkey !== undefined && passkey !== "") s.passkey = Number(passkey);
  if (randomMac) s.random_mac = true;
  return s;
}
export function keyReport(id, modifier, usage) {
  return { id, type: "input", hex: [modifier, 0, usage, 0, 0, 0, 0, 0].map((b) => b.toString(16).padStart(2, "0")).join("") };
}
// ASCII → (modificateur, usage HID). SHIFT = 0x02. Identique à ascii_to_hid du SDK.
export function asciiToHid(c) {
  const S = 0x02, code = c.charCodeAt(0);
  if (c >= "a" && c <= "z") return [0, 0x04 + code - 97];
  if (c >= "A" && c <= "Z") return [S, 0x04 + code - 65];
  if (c >= "1" && c <= "9") return [0, 0x1e + code - 49];
  const map = {
    "0": [0, 0x27], "\n": [0, 0x28], "\t": [0, 0x2b], " ": [0, 0x2c],
    "!": [S, 0x1e], "@": [S, 0x1f], "#": [S, 0x20], "$": [S, 0x21], "%": [S, 0x22],
    "^": [S, 0x23], "&": [S, 0x24], "*": [S, 0x25], "(": [S, 0x26], ")": [S, 0x27],
    "-": [0, 0x2d], "_": [S, 0x2d], "=": [0, 0x2e], "+": [S, 0x2e], "[": [0, 0x2f],
    "{": [S, 0x2f], "]": [0, 0x30], "}": [S, 0x30], "\\": [0, 0x31], "|": [S, 0x31],
    ";": [0, 0x33], ":": [S, 0x33], "'": [0, 0x34], '"': [S, 0x34], "`": [0, 0x35],
    "~": [S, 0x35], ",": [0, 0x36], "<": [S, 0x36], ".": [0, 0x37], ">": [S, 0x37],
    "/": [0, 0x38], "?": [S, 0x38],
  };
  return map[c] || null;
}

// Construit un payload d'advertising BLE. Soit raw (hex complet), soit champs structurés.
export function advSpec(o = {}) {
  const s = {};
  if (o.raw) s.hex = o.raw.replace(/[^0-9a-f]/gi, "");
  if (o.name) s.name = o.name;
  if (o.mfg) s.mfg = o.mfg.replace(/[^0-9a-f]/gi, "");
  if (o.service) s.service = o.service;
  if (o.ibeacon) s.ibeacon = o.ibeacon;      // UUID:major:minor
  if (o.eddystone) s.eddystone = o.eddystone; // URL
  if (o.connectable) s.connectable = true;
  if (o.intervalMs) s.interval = o.intervalMs;
  if (o.randomMac) s.random_mac = true;
  if (o.mac) s.mac = o.mac;
  if (o.durationMs) s.duration_ms = o.durationMs;
  return s;
}

// ---------- Interprétation « humaine » ----------

export const IR_PROTOCOLS = {
  1: "RC5", 2: "RC6", 3: "NEC", 4: "Sony", 5: "Panasonic", 6: "JVC", 7: "Samsung", 8: "Whynter",
  9: "Aiwa", 10: "LG", 11: "Sanyo", 12: "Mitsubishi", 13: "Dish", 14: "Sharp", 17: "Denon",
  19: "Sherwood", 21: "RCMM", 29: "Nikai", 35: "MagiQuest", 36: "Lasertag", 39: "Mitsubishi 2",
  43: "GI Cable", 47: "Lutron", 50: "Pioneer", 56: "Samsung 36", 58: "Lego PF", 64: "Inax",
  75: "Epson", 76: "Symphony", 81: "Doshisha", 82: "Multibrackets", 91: "Metz", 95: "Elite Screens",
  97: "MilesTag2", 99: "XMP", 106: "Bose", 107: "Arris", 117: "Toto",
};

// Même filtre anti-bruit que le SDK : code connu non nul, ou trame brute.
export function irCapture(ev) {
  if (!ev) return null;
  const name = IR_PROTOCOLS[ev.protocol];
  if (name) {
    const data = String(ev.data ?? "0").replace(/^0x/i, "");
    const n = BigInt("0x" + (data || "0"));
    if (n === 0n || !ev.bits || n === 0xffffffffffffffffn) return null;
    return { protocol: ev.protocol, name, data: data.toUpperCase(), bits: ev.bits };
  }
  if (Array.isArray(ev.timings) && ev.timings.length) return { name: "Brut", khz: ev.khz || 38, timings: ev.timings };
  return null;
}

const COMPANIES = {
  0x004c: "Apple", 0x0006: "Microsoft", 0x0075: "Samsung", 0x00e0: "Google", 0x0087: "Garmin",
  0x0157: "Huami (Amazfit)", 0x027d: "Huawei", 0x038f: "Xiaomi", 0x0059: "Nordic", 0x02e5: "Espressif",
  0x0171: "Amazon", 0x000f: "Broadcom", 0x0002: "Intel", 0x001d: "Qualcomm", 0x0499: "Ruuvi",
  0x00d2: "Dialog", 0x0310: "SGL Italia", 0x0131: "Cypress", 0x0822: "Withings",
  0x0101: "Fugoo", 0x058e: "Meta", 0x0397: "Polar", 0x009e: "Bose", 0x00cd: "Microchip",
  0x0001: "Nokia", 0x010f: "HiSilicon", 0x0046: "MediaTek", 0x05a7: "Sonos", 0x0003: "IBM",
};
const APPLE_TYPES = {
  0x02: "balise iBeacon", 0x05: "AirDrop", 0x07: "AirPods / écouteurs Apple", 0x09: "AirPlay",
  0x0c: "Handoff", 0x0f: "partage de connexion", 0x10: "iPhone, iPad ou Mac à proximité",
  0x12: "objet Localiser (AirTag, appareil perdu…)", 0x16: "Localiser", 0x19: "Localiser",
};

function parseAdv(hex) {
  const b = (hex || "").match(/../g)?.map((x) => parseInt(x, 16)) || [];
  const out = {};
  for (let i = 0; i < b.length;) {
    const len = b[i];
    if (!len || i + 1 + len > b.length) break;
    const type = b[i + 1], val = b.slice(i + 2, i + 1 + len);
    if ((type === 0x09 || type === 0x08) && !out.name) out.name = dec.decode(new Uint8Array(val));
    if (type === 0xff && val.length >= 2 && out.company === undefined) {
      out.company = val[0] | (val[1] << 8);
      out.mfg = val.slice(2);
    }
    i += 1 + len;
  }
  return out;
}

export function describeBle(d) {
  const adv = parseAdv(d.payload);
  const companyId = d.company_id ?? adv.company;
  const company = companyId !== undefined ? COMPANIES[companyId] || `fabricant n°${companyId}` : null;
  let kind = null;
  if (companyId === 0x004c && adv.mfg?.length) kind = APPLE_TYPES[adv.mfg[0]] || null;
  if (!kind && adv.mfg && companyId === 0x0006) kind = "PC ou appareil Windows";
  if (!kind && /^4c000215/i.test(d.payload || "")) kind = "balise iBeacon";
  const name = d.name || adv.name || null;
  const privacy = d.addr_type === 1 && (d.rpa || d.nrpa);
  return { name, company, kind, privacy };
}

export function distanceHint(rssi) {
  if (rssi >= -55) return { label: "tout près", level: 4 };
  if (rssi >= -67) return { label: "proche", level: 3 };
  if (rssi >= -80) return { label: "dans la pièce d'à côté", level: 2 };
  return { label: "loin", level: 1 };
}

export const SECURITY = {
  OPEN: { label: "Ouvert", note: "aucun mot de passe : tout le monde peut voir ce qui passe", tone: "bad" },
  WEP: { label: "WEP", note: "obsolète, se casse en quelques minutes", tone: "bad" },
  WPA_PSK: { label: "WPA", note: "ancien, à éviter", tone: "warn" },
  WPA_WPA2_PSK: { label: "WPA/WPA2", note: "correct, mais garde une compatibilité ancienne", tone: "warn" },
  WPA2_PSK: { label: "WPA2", note: "bonne protection si le mot de passe est solide", tone: "ok" },
  WPA2_WPA3_PSK: { label: "WPA2/WPA3", note: "très bonne protection", tone: "ok" },
  WPA3_PSK: { label: "WPA3", note: "la meilleure protection actuelle", tone: "best" },
  WPA2_ENTERPRISE: { label: "Entreprise", note: "identifiant personnel par utilisateur", tone: "ok" },
  WPA3_ENTERPRISE: { label: "Entreprise WPA3", note: "identifiant personnel, très solide", tone: "best" },
  WAPI_PSK: { label: "WAPI", note: "norme chinoise", tone: "warn" },
  OWE: { label: "OWE", note: "réseau ouvert mais chiffré", tone: "ok" },
};
