'use strict';
// Runs the real bridge against the fake phone. Usage: node sim/run.js   (env: SIM_FAIL_DUMPS=1 SIM_FIRST_TAP_SHEET=1 SIM_INJECT_FAIL=1 SIM_NO_SCROLL=1)
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), http = require('http'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-')); const port = 18787 + Math.floor(Math.random() * 500);
try { fs.unlinkSync('/tmp/fake-adb-state.json'); } catch (_) {}
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: port, BRIDGE_TOKEN: 'x'.repeat(20), DATA_DIR: dir, ADB_BIN: path.join(__dirname, 'fake-adb.js') }, stdio: 'inherit' });
const call = (p, m = 'GET', b) => new Promise((res) => { const r = http.request({ port, path: p, method: m, headers: { 'x-token': 'x'.repeat(20), 'content-type': 'application/json' } }, (x) => { let s = ''; x.on('data', (d) => (s += d)); x.on('end', () => res(s)); }); r.end(b ? JSON.stringify(b) : undefined); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await wait(800);
  await call('/start', 'POST', { dwellMin: 2, dwellMax: 3, profileDelayMin: 1, profileDelayMax: 2, maxFollowers: 3000, maxPosts: 200, pauseBeforeTap: !process.env.SIM_NOPAUSE });
  const until = Date.now() + (+process.env.SIM_SECONDS || 70) * 1000;
  while (Date.now() < until) { await wait(2000); const st = JSON.parse(await call('/state')).state; if (st.status !== 'running') break; if (st.profilesVisited >= 6) break; }
  const st = JSON.parse(await call('/state')).state; const ev = JSON.parse(await call('/events?since=0&limit=500')).events;
  console.log('\nSTATE', st.status, st.reason, '| visited', st.profilesVisited, '| diag', JSON.stringify(st.diag));
  for (const e of ev) if (e.type === 'lead') { const d = e.data; console.log('LEAD', d.username, '| f', d.followers, '| wa', d.waNumber, d.waSource, '| phone', d.phone, d.phoneE164, '| email', d.email, '| country', d.country, d.countryStatus, '| notes', d.notes.join('; ')); } else if (e.type !== 'info') console.log(e.type.toUpperCase(), JSON.stringify(e.data).slice(0, 200));
  await call('/stop', 'POST'); srv.kill(); process.exit(0);
})();
