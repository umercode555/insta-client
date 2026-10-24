'use strict';
// Lead bridge: drives the Android Instagram app over adb, reads screen text via
// uiautomator, emits raw observations. Filtering/AI/CSV live in the Chrome extension.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFile } = require('child_process');
const P = require('./parse');
const { parseNodes, parseProfile, parseContactSheet, parseAbout, classifyScreen, OVERLAY_KINDS, waFromUrl, normalizePhone, findPhones, findByLabel, findProfileMenuButton, center } = P;

const PORT = +process.env.PORT || 8787;
const TOKEN = process.env.BRIDGE_TOKEN || '';
const SERIAL = process.env.ADB_SERIAL || '';   // empty = single USB phone
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADB = process.env.ADB_BIN || 'adb';
if (!TOKEN || TOKEN.length < 16) { console.error('BRIDGE_TOKEN missing or too short (min 16 chars)'); process.exit(1); }
fs.mkdirSync(DATA, { recursive: true });

const EV_FILE = path.join(DATA, 'events.jsonl'), SEEN_FILE = path.join(DATA, 'seen.json');
let events = [], nextId = 1;
try {
  for (const line of fs.readFileSync(EV_FILE, 'utf8').split('\n')) if (line) { const e = JSON.parse(line); events.push(e); nextId = e.id + 1; }
  if (events.length > 20000) events = events.slice(-20000);
} catch (_) {}
let seen = new Set();
try { seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch (_) {}
const saveSeen = () => fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
function emit(type, data) {
  const e = { id: nextId++, t: Date.now(), type, data };
  events.push(e); if (events.length > 20000) events.shift();
  fs.appendFileSync(EV_FILE, JSON.stringify(e) + '\n');
  return e;
}

const state = { status: 'stopped', reason: '', reelsScanned: 0, profilesVisited: 0, parseFailures: 0, errors: 0,
  noReel: 0, hourCount: 0, dayCount: 0, startedAt: null, lastUser: null, config: null, device: SERIAL || 'usb',
  screen: '', brand: '', openFails: 0, withWhatsApp: 0, withCountry: 0, hint: '',
  diag: { dumpOk: 0, dumpFail: 0, kinds: {}, lastDumpError: '', recoveries: 0, stuck: 0, lastStep: '' }, preflight: null };
let visits = [];       // timestamps of profile visits (rolling hour)
let dayKey = '', loopRunning = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
async function nap(ms) { const end = Date.now() + ms; while (Date.now() < end && state.status === 'running') await sleep(Math.min(400, end - Date.now())); }

// ---------- diagnostics ----------
const TRACE_FILE = path.join(DATA, 'trace.log'), DEBUG_DIR = path.join(DATA, 'debug');
fs.mkdirSync(DEBUG_DIR, { recursive: true });
try { if (fs.statSync(TRACE_FILE).size > 5e6) fs.writeFileSync(TRACE_FILE, ''); } catch (_) {}
const traceBuf = [];
function trace(step, detail) {
  const d = detail == null ? '' : ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  const line = new Date().toISOString().slice(11, 23) + ' ' + step + d;
  traceBuf.push(line); if (traceBuf.length > 800) traceBuf.shift();
  state.diag.lastStep = (step + d).slice(0, 140);
  try { fs.appendFileSync(TRACE_FILE, line + '\n'); } catch (_) {}
}
let lastSnap = 0, lastXml = '';
async function snapshot(tag, xml) {          // save what the phone showed when something went wrong
  if (Date.now() - lastSnap < 4000) return; lastSnap = Date.now();
  const base = path.join(DEBUG_DIR, new Date().toISOString().replace(/[:.]/g, '-') + '-' + tag.replace(/[^\w-]/g, ''));
  try { if (xml) fs.writeFileSync(base + '.xml', xml); } catch (_) {}
  try { fs.writeFileSync(base + '.png', await adb(['exec-out', 'screencap', '-p'], { raw: true, timeout: 10000 })); } catch (_) {}
  try { const f = fs.readdirSync(DEBUG_DIR).sort(); for (const x of f.slice(0, Math.max(0, f.length - 40))) fs.unlinkSync(path.join(DEBUG_DIR, x)); } catch (_) {}
  trace('snapshot', path.basename(base));
}
class Halt extends Error {}                  // thrown to unwind quietly when the user pauses/stops or a block is detected
const alive = () => { if (state.status !== 'running') throw new Halt('not running'); };
function errKind(m) {
  m = String(m || '');
  if (/INJECT_EVENTS|SecurityException/i.test(m)) return 'inject_denied';
  if (/user_cpu_freq|EACCES/i.test(m)) return 'dump_eacces';
  if (/idle state/i.test(m)) return 'dump_idle';
  if (/not connected|UiAutomation|already registered/i.test(m)) return 'uia_stale';
  if (/no devices|offline|unauthorized|not found|No Android phone/i.test(m)) return 'device';
  if (/timed? ?out|ETIMEDOUT|killed|SIGTERM/i.test(m)) return 'timeout';
  return 'other';
}
function injectHint(brand) {
  const b = String(brand || state.brand || '').toLowerCase();
  if (/xiaomi|redmi|poco/.test(b)) return "Settings > Additional settings > Developer options > turn ON 'USB debugging (Security settings)' (needs SIM + Mi account), then unplug and replug USB.";
  if (/oppo|realme|oneplus/.test(b)) return "Settings > Developer options > turn ON 'Disable permission monitoring' (ColorOS / realme UI), then unplug and replug USB.";
  if (/vivo|iqoo/.test(b)) return "Settings > Developer options > turn ON 'USB debugging (Security settings)', then replug USB.";
  return "Developer options > turn ON 'USB debugging (Security settings)' or 'Disable permission monitoring' (whichever your phone has), then unplug and replug USB.";
}

function adb(args, { timeout = 20000, raw = false } = {}) {
  return new Promise((res, rej) => execFile(ADB, SERIAL ? ['-s', SERIAL, ...args] : args,
    { timeout, maxBuffer: 64 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' },
    (e, so, se) => {
      const errText = (se && se.toString()) || '', head = raw ? '' : String(so || '').slice(0, 600);
      // `input` prints SecurityException but older adb/Android still exit 0 -> never treat that as success
      const bad = /Exception occurred while executing|java\.lang\.SecurityException/.test(errText + head);
      if (e || bad) {
        const m = ((errText + ' ' + head).replace(/\s+/g, ' ').trim() || (e && e.message) || 'adb failed').slice(0, 500);
        return rej(Object.assign(new Error(m), { kind: errKind(m) }));
      }
      res(so);
    }));
}
async function ensureConnected() {
  try { const o = await adb(['get-state'], { timeout: 5000 }); if (/device/.test(o)) return; } catch (_) {}
  if (SERIAL.includes(':')) await new Promise((r) => execFile(ADB, ['connect', SERIAL], { timeout: 8000 }, () => r()));
  else throw Object.assign(new Error('No Android phone found. Plug USB cable, enable USB debugging, tap Allow on phone.'), { kind: 'device' });
}
// Three ways to read the screen; the one that last worked is tried first. File mode deletes the old file first so we never read a stale dump.
const DUMPERS = [
  () => adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 25000 }),
  async () => { const f = '/sdcard/__ui.xml'; await adb(['shell', 'rm -f ' + f + '; uiautomator dump ' + f], { timeout: 25000 }); return adb(['exec-out', 'cat', f], { timeout: 10000 }); },
  async () => { const f = '/data/local/tmp/__ui.xml'; await adb(['shell', 'rm -f ' + f + '; uiautomator dump ' + f], { timeout: 25000 }); return adb(['exec-out', 'cat', f], { timeout: 10000 }); },
];
let dumpMode = 0;
async function dumpXml() {
  const order = [dumpMode, ...DUMPERS.keys()].filter((v, i, a) => a.indexOf(v) === i);
  let last;
  for (const m of order) {
    try {
      const out = String(await DUMPERS[m]());
      const i = out.indexOf('<?xml');
      if (i >= 0 && out.includes('</hierarchy>')) {
        if (m !== dumpMode) { trace('dump.mode', 'switched to mode ' + m); dumpMode = m; }
        lastXml = out.slice(i, out.indexOf('</hierarchy>') + 12); return lastXml;
      }
      last = Object.assign(new Error('uiautomator dump failed: ' + out.replace(/\s+/g, ' ').slice(0, 240)), {});
      last.kind = errKind(last.message);
    } catch (e) { last = e; }
    trace('dump.mode-fail', { mode: m, kind: last.kind || errKind(last.message) });
    if (last.kind === 'device' || last.kind === 'inject_denied') break;
  }
  throw last;
}
async function killUia() { await adb(['shell', 'pkill -f uiautomator 2>/dev/null; killall uiautomator 2>/dev/null; true'], { timeout: 6000 }).catch(() => {}); }
let screen = null;
async function screenSize() {
  if (screen) return screen;
  const o = await adb(['shell', 'wm', 'size']); const all = [...String(o).matchAll(/(\d+)x(\d+)/g)]; const m = all[all.length - 1];  // last = override size if set
  screen = m ? [+m[1], +m[2]] : [720, 1280]; return screen;
}
async function tap(x, y) { alive(); trace('tap', x + ',' + y); await adb(['shell', 'input', 'tap', String(x + Math.round(rand(-3, 3))), String(y + Math.round(rand(-3, 3)))]); }
async function back() { alive(); trace('back'); await adb(['shell', 'input', 'keyevent', '4']); }
async function bringInstagram() { trace('launch.instagram'); await adb(['shell', 'monkey', '-p', 'com.instagram.android', '-c', 'android.intent.category.LAUNCHER', '1']).catch(() => {}); }
async function swipeNext(big) {
  alive(); const [w, h] = await screenSize();
  const x = Math.round(w * rand(0.45, 0.58)), y1 = Math.round(h * rand(big ? 0.82 : 0.72, big ? 0.88 : 0.8)), y2 = Math.round(h * rand(big ? 0.15 : 0.25, big ? 0.22 : 0.33));
  trace('swipe', big ? 'big' : 'normal');
  await adb(['shell', 'input', 'swipe', String(x), String(y1), String(x + Math.round(rand(-12, 12))), String(y2), String(Math.round(rand(big ? 380 : 220, big ? 520 : 420)))]);
  state.videoPaused = false; pausedUser = null;
}
// Reels animate constantly, so uiautomator sometimes cannot reach an idle state. Retry other dump modes, clear a stale uiautomator,
// and only as a last resort single-tap the video to pause it. (The old code fired a 1.8 s long-press WITHOUT awaiting it, so it overlapped the next tap
// and opened Instagram's Speed/Auto-scroll sheet.)
async function dump() {
  let last;
  for (let i = 0; i < 5; i++) {
    try { const nodes = parseNodes(await dumpXml()); state.diag.dumpOk++; return nodes; }
    catch (e) {
      last = e; const k = e.kind || errKind(e.message);
      state.diag.dumpFail++; state.diag.kinds[k] = (state.diag.kinds[k] || 0) + 1; state.diag.lastDumpError = e.message.slice(0, 200);
      trace('dump.fail', { try: i, kind: k, msg: e.message.slice(0, 120) });
      if (k === 'device' || k === 'inject_denied') throw e;
      if (i >= 1) await killUia();
      if (i === 3 && k === 'dump_idle' && state.status === 'running' && (state.config || {}).pauseTapFallback && !state.videoPaused) {
        const [w, h] = await screenSize(); await tap(Math.round(w / 2), Math.round(h * 0.4)); state.videoPaused = true; await sleep(700);
      }
      await sleep(600 + i * 500);
    }
  }
  await snapshot('dump-failed', lastXml);
  throw last;
}
async function observe() {
  const nodes = await dump();
  const o = classifyScreen(nodes); o.nodes = nodes;
  const blk = P.detectBlock(nodes);
  if (blk) { await snapshot('block', lastXml); pauseWith('Instagram prompt detected: /' + blk + '/'); throw new Halt('block'); }
  if (o.kind !== state.screen) trace('screen', o.kind + (o.reel && o.reel.username ? ' @' + o.reel.username : '') + (o.prof && o.prof.profileUser ? ' profile=' + o.prof.profileUser : '') + (o.pkg && o.pkg !== 'com.instagram.android' ? ' pkg=' + o.pkg : ''));
  state.screen = o.kind; return o;
}
// Pause the playing Reel with ONE tap on the video centre before touching anything. Playing video is what made taps on the username land
// as a "hold" (Instagram's Speed / Auto-scroll sheet) and made uiautomator fail; a paused Reel is stable. Done once per Reel.
let pausedUser = null;
const PAUSED_UI = /^(Play|Paused|Resume|Tap to play)$/i;
const looksPaused = (nodes) => nodes.some((n) => PAUSED_UI.test(n.desc.trim()) || PAUSED_UI.test(n.text.trim()) || /(pause|play)_?(icon|button|indicator|overlay)/i.test(n.id));
async function pauseReel(o, force) {
  const cfg = state.config || {};
  if (cfg.pauseBeforeTap === false) return o;
  const user = o.reel && o.reel.username;
  if (!force && user && pausedUser === user) return o;
  if (!force && looksPaused(o.nodes)) { pausedUser = user; trace('pause.already'); return o; }
  const [w, h] = await screenSize();
  await tap(Math.round(w * 0.45), Math.round(h * 0.36));      // video centre: away from right-side buttons and the bottom username/caption
  await nap(rand(500, 800));
  let n = await observe();
  if (n.kind !== 'reel') { trace('pause.unexpected', n.kind); n = await ensureReel('after-pause-tap'); pausedUser = null; return n; }
  pausedUser = (n.reel && n.reel.username) || user; state.videoPaused = true; trace('pause.done', pausedUser);
  return n;
}
// Poll until the screen is one of `want` (or an overlay / unexpected screen shows up, which the caller handles).
async function waitFor(want, { timeout = 7000 } = {}) {
  const t0 = Date.now(); let o = null;
  while (Date.now() - t0 < timeout) {
    alive(); o = await observe();
    if (want.includes(o.kind) || OVERLAY_KINDS.includes(o.kind)) return o;
    await nap(450);
  }
  return o;
}
// Get back to a readable Reel from ANY screen (sheets, profile, about, WhatsApp, other app...). Never blind-taps.
async function ensureReel(why) {
  let unk = 0;
  for (let i = 0; i < 8; i++) {
    alive(); const o = await observe();
    if (o.kind === 'reel') return o;
    state.diag.recoveries++; trace('recover', { why, i, kind: o.kind, pkg: o.pkg });
    if (o.kind === 'unknown') {
      unk++;
      if (unk === 1) { await nap(1200); continue; }                     // maybe just animating/loading
      const tab = o.nodes.find((n) => n.bounds && (n.id === 'clips_tab' || (/^Reels$/i.test(n.desc.trim()) && n.clickable)));
      if (tab && unk === 2) { const c = center(tab.bounds); await tap(c[0], c[1]); await nap(1800); continue; }
      if (unk >= 4) { await bringInstagram(); await nap(2200); continue; }
    } else if ((o.kind === 'foreign' || o.kind === 'whatsapp') && i >= 3) { await bringInstagram(); await nap(2200); continue; }
    await back(); await nap(rand(700, 1100));
  }
  await snapshot('no-reel', lastXml);
  throw new Error('Could not get back to a Reel (last screen: ' + state.screen + '). See data/debug for the screenshot.');
}

function pauseWith(reason, type = 'blocked') {
  state.status = 'paused'; state.reason = reason; emit(type, { reason });
}
function rateOk(cfg) {
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; state.dayCount = 0; }
  visits = visits.filter((t) => now - t < 3600e3); state.hourCount = visits.length;
  return visits.length < cfg.profilesPerHour && state.dayCount < cfg.dailyCap;
}

// ---------- WhatsApp number capture ----------
// Tap something that opens WhatsApp, then read the destination. Two independent sources, no extra Android app needed:
//  1) logcat: Android logs the launch intent (dat=https://wa.me/<number>) when Instagram hands the link to WhatsApp.
//  2) the screen: wa.me page text ("Chat on WhatsApp with +..."), the WhatsApp chat header, or a link list.
function scanForWhatsApp(o, h) {
  const nodes = o.nodes;
  for (const n of nodes) { const v = waFromUrl(n.text + ' ' + n.desc); if (v) return { num: v, src: 'screen-link' }; }
  const all = nodes.map((n) => n.text + ' ' + n.desc).join(' \n ');
  const m = /Chat on WhatsApp with\s*(\+?[\d\s()-]{8,20}\d)/i.exec(all);
  if (m) return { num: '+' + m[1].replace(/\D/g, ''), src: 'wa-web-page' };
  if (o.kind === 'whatsapp') {
    for (const n of nodes) {
      if (!n.bounds || n.bounds[1] > h * 0.22) continue;
      const t = (n.text || n.desc).trim(), ph = /^\+\d[\d\s()-]{7,}$/.test(t) ? t : (findPhones(t)[0] || {}).raw;
      const d = ph ? ph.replace(/\D/g, '') : ''; if (d.length >= 8 && d.length <= 15) return { num: '+' + d, src: 'whatsapp-app' };
    }
    if (/isn'?t on WhatsApp|not on WhatsApp|invalid/i.test(all)) return { num: null, fail: 'number not on WhatsApp / invalid link' };
  }
  return null;
}
async function captureWhatsApp(doTap) {
  const [, h] = await screenSize();
  await adb(['logcat', '-c'], { timeout: 5000 }).catch(() => {});
  await doTap();
  const t0 = Date.now(); let res = null, fail = null, polls = 0;
  while (Date.now() - t0 < 11000) {
    await nap(1000); alive(); polls++;
    try {
      const lg = String(await adb(['logcat', '-d', '-v', 'brief', '-t', '1500'], { timeout: 8000 }));
      for (const l of lg.split('\n')) if (/START|dat=|intent/i.test(l) && /wa\.me|whatsapp/i.test(l)) { const v = waFromUrl(l); if (v) { res = { num: v, src: 'intent-log' }; break; } }
    } catch (_) {}
    if (res) break;
    const o = await observe(), r = scanForWhatsApp(o, h);
    if (r && r.num) { res = r; break; }
    if (r && r.fail) { fail = r.fail; break; }
    if (polls >= 3 && o.kind === 'profile') { fail = 'tap did not open anything'; break; }
  }
  trace('wa.capture', res ? res.num + ' via ' + res.src : 'none: ' + (fail || 'timeout'));
  return res || { num: null, fail: fail || 'no number visible after 11s' };
}

// Back to the profile we are enriching (closes sheets, WhatsApp, About...). null = we overshot to the Reel or lost the profile.
async function refreshProfile(user) {
  for (let i = 0; i < 6; i++) {
    alive(); const o = await observe();
    if (o.kind === 'profile') {
      const pu = o.prof.profileUser;
      if (pu && user && pu.toLowerCase() !== user.toLowerCase()) { trace('warn.profile-changed', { expected: user, got: pu }); return null; }
      return o;
    }
    if (o.kind === 'reel') return null;
    await back(); await nap(rand(700, 1000));
  }
  return null;
}
const worthEnriching = (p, cfg) => !((p.followers != null && (p.followers > cfg.maxFollowers || p.followers < cfg.minFollowers)) || (p.posts != null && p.posts > cfg.maxPosts));

async function enrich(ctx, cfg) {
  const [w, h] = await screenSize();
  const step = async (name, fn) => {
    if (ctx.lost) return;
    const cur = await refreshProfile(ctx.user);
    if (!cur) { ctx.lost = true; ctx.notes.push(name + ': lost profile screen'); return; }
    try { await fn(cur); } catch (e) { if (e instanceof Halt) throw e; ctx.notes.push(name + ': ' + e.message); trace('enrich.err', name + ': ' + e.message); }
  };
  const p0 = ctx.prof;
  if (p0.waNumber) { ctx.waNumber = p0.waNumber; ctx.waSrc = 'bio-link'; }          // full wa.me link already readable: no tap needed
  if (cfg.fetchWhatsApp && !ctx.waNumber) await step('wa-button', async (cur) => {   // WhatsApp button directly on the profile
    const b = cur.prof.buttons.whatsapp; if (!b) return;
    const r = await captureWhatsApp(() => tap(b[0], b[1]));
    if (r.num) { ctx.waNumber = r.num; ctx.waSrc = 'wa-button/' + r.src; } else ctx.notes.push('wa-button: ' + r.fail);
  });
  if (cfg.fetchContact) await step('contact', async (cur) => {                      // "Contact info" sheet: call / email / address / WhatsApp row
    const b = cur.prof.buttons.contact; if (!b) return;
    await tap(b[0], b[1]);
    const s = await waitFor(['contact_sheet'], { timeout: 5500 });
    if (!s || s.kind !== 'contact_sheet') throw new Error('contact sheet did not open (' + (s && s.kind) + ')');
    const cs = parseContactSheet(s.nodes); ctx.contact = cs; trace('contact.sheet', { call: cs.call, email: cs.email, wa: cs.whatsapp, rows: Object.keys(cs.rowTap) });
    if (cs.whatsapp && !ctx.waNumber) { ctx.waRaw = cs.whatsapp; }
    else if (!ctx.waNumber && cfg.fetchWhatsApp && cs.rowTap.whatsapp) {
      const t = cs.rowTap.whatsapp, r = await captureWhatsApp(() => tap(t[0], t[1]));
      if (r.num) { ctx.waNumber = r.num; ctx.waSrc = 'contact-sheet/' + r.src; } else ctx.notes.push('contact-wa-row: ' + r.fail);
    }
  });
  if (cfg.fetchWhatsApp && !ctx.waNumber) await step('wa-link', async (cur) => {      // truncated bio link "wa.me/918…" or wa.link short link
    const t = cur.prof.waLinkTap; if (!t) return;
    const r = await captureWhatsApp(() => tap(t[0], t[1]));
    if (r.num) { ctx.waNumber = r.num; ctx.waSrc = 'bio-link-tap/' + r.src; } else ctx.notes.push('wa-link: ' + r.fail);
  });
  if (cfg.fetchCountry) await step('country', async (cur) => {                      // ⋮ > About this account > "Account based in"
    ctx.countryStatus = 'error';
    const m = findProfileMenuButton(cur.nodes) || [Math.round(w * 0.915), Math.round(h * 0.07)];
    await tap(m[0], m[1]);
    const menu = await waitFor(['profile_menu'], { timeout: 5500 });
    if (!menu || menu.kind !== 'profile_menu') throw new Error('three-dot menu did not open (' + (menu && menu.kind) + ')');
    const ab = findByLabel(menu.nodes, /^About this account$/i); await tap(ab[0], ab[1]);
    const a = await waitFor(['about'], { timeout: 7000 });
    if (!a || a.kind !== 'about') throw new Error('About page did not open (' + (a && a.kind) + ')');
    const r = parseAbout(a.nodes);
    if (r.user && r.user.toLowerCase() !== ctx.user.toLowerCase()) throw new Error('About page belongs to ' + r.user);
    ctx.joined = r.joined || null;
    if (r.country) { ctx.country = r.country; ctx.countryStatus = 'shown'; } else ctx.countryStatus = 'unavailable';
    trace('country', ctx.country || 'unavailable');
  });
}

const fails = {};
async function visitProfile(reel, cfg) {
  const uname = reel.username, key = uname.toLowerCase();
  let o = null;
  for (let a = 0; a < 2; a++) {
    if (a > 0) {                                   // retry: back to the Reel, force-pause, re-read fresh coordinates
      const r = await ensureReel('retry-open'); const p = await pauseReel(r, true);
      if (p.reel && p.reel.username && p.reel.username.toLowerCase() === key) reel = p.reel; else break;
    }
    const t = a === 0 ? reel.tap : (reel.altTap || reel.tap); if (!t) continue;
    await tap(t[0], t[1]);
    o = await waitFor(['profile'], { timeout: 8000 });
    if (o && o.kind === 'profile') break;
    trace('open.fail', { user: uname, attempt: a, screen: o && o.kind });
    await snapshot('open-' + (o && o.kind), lastXml);
    if (o && o.kind !== 'reel') await ensureReel('open-failed');
  }
  if (!o || o.kind !== 'profile') {
    fails[key] = (fails[key] || 0) + 1; state.openFails++;
    emit('info', { note: 'could not open profile @' + uname + ' (screen: ' + (o && o.kind) + ')' });
    if (fails[key] >= 2) { seen.add(key); saveSeen(); }
    if (state.openFails >= 5) return pauseWith('Could not open a profile 5 times in a row (last screen: ' + (o && o.kind) + '). Screenshot + XML saved in data/debug. Fix by hand, then Resume.', 'error');
    await ensureReel('after-open-fail'); return;
  }
  state.openFails = 0;
  const prof = o.prof, user = (prof.profileUser && /^[A-Za-z0-9._]{1,30}$/.test(prof.profileUser)) ? prof.profileUser : uname;
  if (user.toLowerCase() !== key) trace('warn.user-mismatch', { reel: uname, profile: user });
  visits.push(Date.now()); state.dayCount++; state.profilesVisited++; state.lastUser = user; state.parseFailures = 0;
  const ctx = { user, prof, notes: [], contact: null, waNumber: null, waSrc: '', waRaw: null, country: null, countryStatus: 'not_checked', joined: null, lost: false };
  const worth = worthEnriching(prof, cfg);
  if (worth && !prof.isPrivate) { try { await enrich(ctx, cfg); } catch (e) { if (e instanceof Halt) throw e; ctx.notes.push('enrich: ' + e.message); trace('enrich.fatal', e.message); } }
  else ctx.notes.push(worth ? 'private account' : 'skipped extras: fails size filter');

  const country = ctx.country, cs = ctx.contact || {};
  const phoneRaw = cs.call || cs.text || prof.phone || '';
  let waNumber = ctx.waNumber, waSrc = ctx.waSrc;
  if (!waNumber && ctx.waRaw) { waNumber = normalizePhone(ctx.waRaw, country); waSrc = 'contact-sheet'; }
  if (!waNumber) { const bw = prof.phoneList.find((p) => p.wa); if (bw) { waNumber = normalizePhone(bw.raw, country); if (waNumber) waSrc = 'bio-text'; } }
  const lead = { username: user, profileUrl: 'https://www.instagram.com/' + user + '/', reelUrl: null, likes: reel.likes, caption: reel.caption,
    followers: prof.followers, following: prof.following, posts: prof.posts, bio: prof.bio, fullName: prof.fullName, category: prof.category,
    links: prof.links, whatsapp: prof.whatsapp || (waNumber ? 'https://wa.me/' + waNumber.slice(1) : null), waNumber: waNumber || null, waSource: waNumber ? waSrc : '',
    phone: phoneRaw, phoneE164: normalizePhone(phoneRaw, country) || '', email: cs.email || prof.emails[0] || '', address: cs.address || '',
    country: cfg.fetchCountry && worth ? (country || 'unknown') : '', countryStatus: ctx.countryStatus, joined: ctx.joined,
    hasContactButton: !!prof.buttons.contact, hasWhatsAppButton: !!prof.buttons.whatsapp, notes: ctx.notes, isPrivate: prof.isPrivate, visible: prof.visible, enriched: worth };
  if (waNumber) state.withWhatsApp++; if (country) state.withCountry++;
  emit('lead', lead);
  emit('info', { note: '@' + user + ' wa=' + (waNumber || '-') + (waNumber ? ' (' + waSrc + ')' : '') + ' country=' + (lead.country || '-') + (ctx.notes.length ? ' | ' + ctx.notes.join('; ') : '') });
  seen.add(key); seen.add(user.toLowerCase()); saveSeen();
  await ensureReel('after-visit'); await nap(rand(600, 1200));
}

let lastReelKey = null, stuck = 0;
async function cycle(cfg) {
  await ensureConnected();
  let o = await observe();
  if (o.kind !== 'reel') o = await ensureReel('cycle-start');   // sheet / profile / other app left over, or user navigated by hand
  const reel = o.reel;
  if (reel.sponsored) trace('skip.sponsored');
  else if (!reel.username) {
    if (++state.noReel >= 5) return pauseWith('Reel author not detected 5 times (screen: ' + o.kind + '). Open the Reels feed, then Resume. Use "Download diagnostics" if it keeps happening.', 'info');
  } else {
    state.noReel = 0;
    if (reel.key !== lastReelKey) { lastReelKey = reel.key; stuck = 0; state.reelsScanned++; }
    else { stuck++; state.diag.stuck++; trace('stuck', stuck); }
    if (stuck >= 4) { stuck = 0; return pauseWith('Swipe is not moving to the next Reel (4 tries). If you saw an INJECT_EVENTS error: ' + injectHint(), 'error'); }
    if (stuck === 0 && !seen.has(reel.username.toLowerCase())) {
      if (rateOk(cfg)) {
        const p = await pauseReel(o);              // pause first, then use the fresh dump's coordinates
        if (!p.reel || !p.reel.username || p.reel.username.toLowerCase() !== reel.username.toLowerCase()) { trace('skip.reel-changed'); return; }
        await visitProfile(p.reel, cfg); pausedUser = null; await nap(rand(cfg.profileDelayMin, cfg.profileDelayMax) * 1000); }
      else { state.reason = 'rate cap reached, waiting'; await nap(20000); return; }
    }
  }
  if (state.status !== 'running') return;
  if (state.screen !== 'reel') await ensureReel('pre-swipe');
  await swipeNext(stuck >= 2);
  await nap(rand(cfg.dwellMin, cfg.dwellMax) * 1000);
}

async function runLoop() {
  if (loopRunning) return; loopRunning = true;
  let consecutiveErr = 0;
  try {
    while (state.status !== 'stopped') {
      if (state.status === 'paused') { await sleep(700); continue; }
      try { await cycle(state.config); consecutiveErr = 0; }
      catch (e) {
        if (e instanceof Halt) { await sleep(300); continue; }
        const kind = e.kind || errKind(e.message);
        state.errors++; consecutiveErr++;
        emit('error', { message: '[' + kind + '] ' + e.message }); trace('cycle.error', { kind, msg: e.message.slice(0, 160) });
        if (kind === 'inject_denied') { pauseWith('Phone refuses simulated taps/swipes (INJECT_EVENTS). ' + injectHint(), 'error'); consecutiveErr = 0; }
        else if (consecutiveErr >= 5) { pauseWith('5 consecutive errors [' + kind + ']: ' + e.message, 'error'); consecutiveErr = 0; }
        else await sleep(1500 * consecutiveErr);
      }
    }
  } finally { loopRunning = false; }
}

// Checks everything the loop depends on and says exactly what is wrong.
async function preflight() {
  const checks = []; let ok = true, problem = '';
  const add = (name, pass, detail, hint, fatal = true) => { checks.push({ name, pass, detail: String(detail || '').slice(0, 200), hint: hint || '' }); if (!pass && fatal) { ok = false; if (!problem) problem = name + ': ' + detail + (hint ? ' - ' + hint : ''); } };
  try { await ensureConnected(); add('phone connected', true, 'ok'); } catch (e) { add('phone connected', false, e.message); return { ok, checks, problem }; }
  const g = async (p) => String(await adb(['shell', 'getprop', p]).catch(() => '')).trim();
  state.brand = (await g('ro.product.manufacturer')) || (await g('ro.product.brand'));
  state.device = [state.brand, await g('ro.product.model'), 'Android ' + await g('ro.build.version.release')].join(' ').trim();
  add('device', true, state.device);
  try { const [w, h] = await screenSize(); add('screen size', true, w + 'x' + h); } catch (e) { add('screen size', false, e.message); }
  try { await adb(['shell', 'input', 'keyevent', '0']); add('input injection (taps/swipes)', true, 'allowed'); }
  catch (e) { add('input injection (taps/swipes)', false, e.message.slice(0, 140), injectHint()); }
  try {
    const nodes = await dump(); const c = classifyScreen(nodes);
    add('screen reading (uiautomator)', true, nodes.length + ' nodes, mode ' + dumpMode);
    add('Instagram on screen', c.pkg === 'com.instagram.android', 'screen=' + c.kind + ' pkg=' + c.pkg, 'Open Instagram > Reels (the script will also try to navigate there)', false);
  } catch (e) { add('screen reading (uiautomator)', false, e.message, 'see README: "uiautomator errors"'); }
  state.preflight = { at: Date.now(), ok, checks }; trace('preflight', { ok, problem });
  return { ok, checks, problem };
}

const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) && v !== '' && v != null ? +v : d));
function start(body) {
  if (state.status === 'running') return;
  const c = body || {};
  const cfg = { dwellMin: num(c.dwellMin, 4, 2, 120), dwellMax: num(c.dwellMax, 9, 3, 240),
    profilesPerHour: num(c.profilesPerHour, 40, 1, 120), dailyCap: num(c.dailyCap, 300, 1, 1000),
    profileDelayMin: num(c.profileDelayMin, 3, 1, 120), profileDelayMax: num(c.profileDelayMax, 8, 2, 240),
    maxFollowers: num(c.maxFollowers, 3000, 0, 1e9), minFollowers: num(c.minFollowers, 0, 0, 1e9), maxPosts: num(c.maxPosts, 60, 0, 1e6),
    fetchWhatsApp: c.fetchWhatsApp !== false, fetchContact: c.fetchContact !== false, fetchCountry: c.fetchCountry !== false, pauseTapFallback: c.pauseTapFallback !== false, pauseBeforeTap: c.pauseBeforeTap !== false };
  if (cfg.dwellMax < cfg.dwellMin) cfg.dwellMax = cfg.dwellMin + 1;
  if (cfg.profileDelayMax < cfg.profileDelayMin) cfg.profileDelayMax = cfg.profileDelayMin + 1;
  if (c.resetSeen) { seen = new Set(); saveSeen(); }
  Object.assign(state, { status: 'running', reason: '', config: cfg, startedAt: Date.now(), noReel: 0, parseFailures: 0, openFails: 0, screen: '' });
  lastReelKey = null; stuck = 0; state.videoPaused = false;
  emit('info', { note: 'started', config: cfg });
  adb(['shell', 'svc', 'power', 'stayon', 'usb']).catch(() => {});  // keep phone screen on while plugged in
  preflight().then((pf) => {
    for (const ch of pf.checks) if (!ch.pass) emit(pf.ok ? 'info' : 'error', { message: 'preflight FAILED: ' + ch.name + ' - ' + ch.detail + (ch.hint ? ' | ' + ch.hint : ''), note: 'preflight warning: ' + ch.name + ' - ' + ch.detail });
    if (!pf.ok) { if (state.status === 'running') pauseWith('Preflight failed - ' + pf.problem, 'error'); } else runLoop();
  }).catch((e) => { pauseWith('Preflight crashed: ' + e.message, 'error'); });
}

const tokOk = (t) => { const a = Buffer.from(String(t || '')), b = Buffer.from(TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
function readBody(req) {
  return new Promise((res) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 1e5) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch (_) { res({}); } }); });
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-token, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/health') return json(200, { ok: true });
  if (!tokOk(req.headers['x-token'])) return json(401, { ok: false, error: 'bad token' });
  try {
    if (u.pathname === '/state') return json(200, { ok: true, state, lastId: nextId - 1, seen: seen.size });
    if (u.pathname === '/events') {
      const since = +u.searchParams.get('since') || 0, limit = Math.min(500, +u.searchParams.get('limit') || 200);
      return json(200, { ok: true, lastId: nextId - 1, events: events.filter((e) => e.id > since).slice(0, limit) });
    }
    if (req.method === 'POST' && u.pathname === '/start') { start(await readBody(req)); return json(200, { ok: true, state }); }
    if (req.method === 'POST' && u.pathname === '/pause') { if (state.status === 'running') { state.status = 'paused'; state.reason = 'paused by user'; } return json(200, { ok: true, state }); }
    if (req.method === 'POST' && u.pathname === '/resume') { if (state.status === 'paused') { state.status = 'running'; state.reason = ''; state.noReel = 0; state.parseFailures = 0; state.openFails = 0; state.screen = ''; if (!loopRunning) runLoop(); } return json(200, { ok: true, state }); }
    if (req.method === 'POST' && u.pathname === '/stop') { state.status = 'stopped'; state.reason = 'stopped by user'; return json(200, { ok: true, state }); }
    if (u.pathname === '/trace') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('STATE ' + JSON.stringify(state) + '\n\n' + traceBuf.join('\n')); }
    if (req.method === 'POST' && u.pathname === '/preflight') { return json(200, { ok: true, ...(await preflight()) }); }
    if (u.pathname === '/dump') { await ensureConnected(); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(await dumpXml()); }
    if (u.pathname === '/screenshot.png') { await ensureConnected(); const b = await adb(['exec-out', 'screencap', '-p'], { raw: true }); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(b); }
    return json(404, { ok: false, error: 'not found' });
  } catch (e) { return json(500, { ok: false, error: e.message }); }
}).listen(PORT, HOST, () => console.log('bridge on ' + HOST + ':' + PORT));
