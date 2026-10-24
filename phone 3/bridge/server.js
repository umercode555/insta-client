'use strict';
// Lead bridge: drives the Android Instagram app over adb, reads screen text via
// uiautomator, emits raw observations. Filtering/AI/CSV live in the Chrome extension.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFile } = require('child_process');
const { parseNodes, findReel, parseProfile, detectBlock } = require('./parse');

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
  noReel: 0, hourCount: 0, dayCount: 0, startedAt: null, lastUser: null, config: null, device: SERIAL || 'usb' };
let visits = [];       // timestamps of profile visits (rolling hour)
let dayKey = '', loopRunning = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
async function nap(ms) { const end = Date.now() + ms; while (Date.now() < end && state.status !== 'stopped') await sleep(Math.min(400, end - Date.now())); }

function adb(args, { timeout = 20000, raw = false } = {}) {
  return new Promise((res, rej) => execFile(ADB, SERIAL ? ['-s', SERIAL, ...args] : args,
    { timeout, maxBuffer: 64 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' },
    (e, so, se) => e ? rej(new Error(((se && se.toString()) || e.message).slice(0, 300))) : res(so)));
}
async function ensureConnected() {
  try { const o = await adb(['get-state'], { timeout: 5000 }); if (/device/.test(o)) return; } catch (_) {}
  if (SERIAL.includes(':')) await new Promise((r) => execFile(ADB, ['connect', SERIAL], { timeout: 8000 }, () => r()));
  else throw new Error('No Android phone found. Plug USB cable, enable USB debugging, tap Allow on phone.');
}
async function dumpXml() {
  const out = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 25000 });
  const i = out.indexOf('<?xml');
  if (i < 0 || !out.includes('</hierarchy>')) throw new Error('uiautomator dump failed: ' + out.slice(0, 160));
  return out.slice(i, out.indexOf('</hierarchy>') + 12);
}
let screen = null;
async function screenSize() {
  if (screen) return screen;
  const o = await adb(['shell', 'wm', 'size']); const m = /(\d+)x(\d+)/.exec(o);
  screen = m ? [+m[1], +m[2]] : [720, 1280]; return screen;
}
// Instagram Reels animate constantly, which can make uiautomator fail. Retry, pausing the video with a long-press.
async function dump() {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return parseNodes(await dumpXml()); } catch (e) {
      last = e;
      if (i >= 1) { const [w, h] = await screenSize(); adb(['shell', 'input', 'swipe', String(w >> 1), String(h >> 1), String(w >> 1), String(h >> 1), '1800']).catch(() => {}); }
      await sleep(900);
    }
  }
  throw last;
}
async function tap(x, y) { await adb(['shell', 'input', 'tap', String(x + Math.round(rand(-3, 3))), String(y + Math.round(rand(-3, 3)))]); }
async function back() { await adb(['shell', 'input', 'keyevent', '4']); }
async function swipeNext() {
  const [w, h] = await screenSize();
  const x = Math.round(w * rand(0.45, 0.58)), y1 = Math.round(h * rand(0.72, 0.8)), y2 = Math.round(h * rand(0.25, 0.33));
  await adb(['shell', 'input', 'swipe', String(x), String(y1), String(x + Math.round(rand(-12, 12))), String(y2), String(Math.round(rand(220, 420)))]);
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

async function visitProfile(reel, cfg) {
  if (!reel.tap) return;
  seen.add(reel.username.toLowerCase());
  await tap(reel.tap[0], reel.tap[1]);
  await nap(rand(2200, 3800));
  let nodes = await dump();
  const blk = detectBlock(nodes); if (blk) return pauseWith('Instagram prompt detected: /' + blk + '/');
  let prof = parseProfile(nodes);
  if (!prof.isProfile) { await nap(1500); nodes = await dump(); prof = parseProfile(nodes); }
  visits.push(Date.now()); state.dayCount++; state.profilesVisited++; state.lastUser = reel.username;
  if (prof.isProfile) {
    state.parseFailures = 0;
    emit('lead', { username: reel.username, profileUrl: 'https://www.instagram.com/' + reel.username + '/', reelUrl: null,
      likes: reel.likes, caption: reel.caption, followers: prof.followers, following: prof.following, posts: prof.posts,
      bio: prof.bio, fullName: prof.fullName, category: prof.category, links: prof.links, whatsapp: prof.whatsapp,
      phone: prof.phone, isPrivate: prof.isPrivate, visible: prof.visible });
  } else {
    state.parseFailures++;
    emit('info', { note: 'profile not parsed', username: reel.username });
    if (state.parseFailures >= 3) pauseWith('Profile screen not recognised 3 times. Check /dump and adjust parser.', 'error');
  }
  saveSeen();
  await back(); await nap(rand(1200, 2200));
}

async function cycle(cfg) {
  await ensureConnected();
  const nodes = await dump();
  const blk = detectBlock(nodes); if (blk) return pauseWith('Instagram prompt detected: /' + blk + '/');
  const reel = findReel(nodes);
  if (!reel.username) {
    if (++state.noReel >= 5) return pauseWith('Reel screen not detected 5 times. Open the topic Reels feed in Android, then Resume.', 'info');
  } else {
    state.noReel = 0; state.reelsScanned++;
    if (!seen.has(reel.username.toLowerCase())) {
      if (rateOk(cfg)) { await visitProfile(reel, cfg); await nap(rand(cfg.profileDelayMin, cfg.profileDelayMax) * 1000); }
      else { state.reason = 'rate cap reached, waiting'; await nap(20000); return; }
    }
  }
  if (state.status !== 'running') return;
  await swipeNext();
  await nap(rand(cfg.dwellMin, cfg.dwellMax) * 1000);
}

async function runLoop() {
  if (loopRunning) return; loopRunning = true;
  let consecutiveErr = 0;
  while (state.status !== 'stopped') {
    if (state.status === 'paused') { await sleep(700); continue; }
    try { await cycle(state.config); consecutiveErr = 0; }
    catch (e) {
      state.errors++; consecutiveErr++;
      emit('error', { message: e.message });
      if (consecutiveErr >= 5) { pauseWith('5 consecutive errors: ' + e.message, 'error'); consecutiveErr = 0; }
      else await sleep(1500 * consecutiveErr);
    }
  }
  loopRunning = false;
}

const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) && v !== '' && v != null ? +v : d));
function start(body) {
  if (state.status === 'running') return;
  const c = body || {};
  const cfg = { dwellMin: num(c.dwellMin, 4, 2, 120), dwellMax: num(c.dwellMax, 9, 3, 240),
    profilesPerHour: num(c.profilesPerHour, 40, 1, 120), dailyCap: num(c.dailyCap, 300, 1, 1000),
    profileDelayMin: num(c.profileDelayMin, 3, 1, 120), profileDelayMax: num(c.profileDelayMax, 8, 2, 240) };
  if (cfg.dwellMax < cfg.dwellMin) cfg.dwellMax = cfg.dwellMin + 1;
  if (cfg.profileDelayMax < cfg.profileDelayMin) cfg.profileDelayMax = cfg.profileDelayMin + 1;
  if (c.resetSeen) { seen = new Set(); saveSeen(); }
  Object.assign(state, { status: 'running', reason: '', config: cfg, startedAt: Date.now(), noReel: 0, parseFailures: 0 });
  emit('info', { note: 'started', config: cfg });
  adb(['shell', 'svc', 'power', 'stayon', 'usb']).catch(() => {});  // keep phone screen on while plugged in
  runLoop();
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
    if (req.method === 'POST' && u.pathname === '/resume') { if (state.status === 'paused') { state.status = 'running'; state.reason = ''; state.noReel = 0; state.parseFailures = 0; if (!loopRunning) runLoop(); } return json(200, { ok: true, state }); }
    if (req.method === 'POST' && u.pathname === '/stop') { state.status = 'stopped'; state.reason = 'stopped by user'; return json(200, { ok: true, state }); }
    if (u.pathname === '/dump') { await ensureConnected(); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(await dumpXml()); }
    if (u.pathname === '/screenshot.png') { await ensureConnected(); const b = await adb(['exec-out', 'screencap', '-p'], { raw: true }); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(b); }
    return json(404, { ok: false, error: 'not found' });
  } catch (e) { return json(500, { ok: false, error: e.message }); }
}).listen(PORT, HOST, () => console.log('bridge on ' + HOST + ':' + PORT));
