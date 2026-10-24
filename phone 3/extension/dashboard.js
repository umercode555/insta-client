'use strict';
const $ = (id) => document.getElementById(id);
const FIELDS = ['bridgeUrl', 'token', 'niche', 'keywords', 'maxFollowers', 'minFollowers', 'maxPosts', 'requireContact', 'geminiKey', 'geminiModel', 'profilesPerHour', 'dailyCap', 'dwellMin', 'dwellMax'];
const NUMS = new Set(['maxFollowers', 'minFollowers', 'maxPosts', 'profilesPerHour', 'dailyCap', 'dwellMin', 'dwellMax']);
const DEF = { bridgeUrl: 'http://127.0.0.1:8787', maxFollowers: 3000, minFollowers: 0, maxPosts: 60, geminiModel: 'gemini-3.5-flash-lite', profilesPerHour: 40, dailyCap: 300, dwellMin: 4, dwellMax: 9 };
const send = (m) => chrome.runtime.sendMessage(m);
const flash = (t) => { $('saved').textContent = t; setTimeout(() => ($('saved').textContent = ''), 3000); };

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings'); const s = { ...DEF, ...settings };
  for (const k of FIELDS) { const el = $('f').elements[k]; if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k] ?? ''; }
}
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = {};
  for (const k of FIELDS) { const el = $('f').elements[k]; s[k] = el.type === 'checkbox' ? el.checked : NUMS.has(k) ? Number(el.value) : el.value.trim(); }
  try {
    const o = new URL(s.bridgeUrl); const host = o.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
      const ok = await chrome.permissions.request({ origins: [o.origin + '/*'] });
      if (!ok) return flash('Permission for bridge host denied');
    }
  } catch (_) { return flash('Bad bridge URL'); }
  await chrome.storage.local.set({ settings: s }); flash('Saved'); send({ type: 'sync' });
});
for (const [id, type] of [['start', 'start'], ['pause', 'pause'], ['resume', 'resume'], ['stop', 'stop']]) {
  $(id).onclick = async () => { const r = await send({ type }); if (r && r.ok === false) alert(r.error); };
}
$('clear').onclick = async () => { if (confirm('Delete all saved leads from this browser? Export first.')) await send({ type: 'clear' }); };

const COLS = ['status', 'niche', 'username', 'profile_url', 'reel_url', 'likes', 'followers', 'posts', 'bio', 'category', 'whatsapp', 'phone', 'reason', 'collected_at'];
const SAFE = new Set(['bio', 'username', 'category', 'reason', 'niche']); // neutralise spreadsheet formulas in untrusted text
function cell(k, v) { if (v == null) return ''; let s = String(v); if (SAFE.has(k) && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return s; }
function download(name, mime, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function rows() { const { leads = {} } = await chrome.storage.local.get('leads'); return Object.values(leads).sort((a, b) => a.collected_at < b.collected_at ? 1 : -1); }
$('csv').onclick = async () => {
  const q = (s) => '"' + s.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const out = [COLS.join(',')];
  for (const r of await rows()) out.push(COLS.map((k) => q(cell(k, r[k]))).join(','));
  download('leads-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv;charset=utf-8', '\ufeff' + out.join('\r\n'));
};
$('xls').onclick = async () => {
  const h = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let t = '<html><head><meta charset="utf-8"></head><body><table border="1"><tr>' + COLS.map((c) => '<th>' + c + '</th>').join('') + '</tr>';
  for (const r of await rows()) { const red = r.status === 'Uncertain'; t += '<tr' + (red ? ' style="background:#ffcccc;color:#b00000"' : '') + '>' + COLS.map((k) => '<td>' + h(cell(k, r[k])) + '</td>').join('') + '</tr>'; }
  download('leads-' + new Date().toISOString().slice(0, 10) + '.xls', 'application/vnd.ms-excel', t + '</table></body></html>');
};

function td(tr, text, cls) { const c = document.createElement('td'); c.textContent = text == null ? '' : String(text); if (cls) c.className = cls; tr.appendChild(c); }
async function render() {
  const d = await chrome.storage.local.get(['stats', 'bridgeState', 'connected', 'lastError', 'log']);
  const st = d.stats || {}, b = d.bridgeState || {};
  $('conn').textContent = d.connected ? 'bridge connected' : 'bridge offline'; $('conn').className = 'pill ' + (d.connected ? 'on' : 'bad');
  $('run').textContent = b.status || 'stopped'; $('run').className = 'pill ' + (b.status === 'running' ? 'on' : b.status === 'paused' ? 'mid' : '');
  const msg = d.lastError || (b.status !== 'running' && b.reason) || (b.status === 'running' && b.reason) || '';
  $('reason').hidden = !msg; $('reason').textContent = msg;
  const set = (id, v) => ($(id).textContent = v ?? 0);
  set('c-scanned', b.reelsScanned); set('c-visited', b.profilesVisited); set('c-saved', st.saved); set('c-match', st.matched);
  set('c-unc', st.uncertain); set('c-rej', st.rejected); set('c-dup', st.duplicates); set('c-hour', b.hourCount);
  const tb = document.querySelector('#t tbody'); tb.textContent = '';
  const all = await rows(); $('count').textContent = '(' + all.length + ')';
  for (const r of all.slice(0, 300)) {
    const tr = document.createElement('tr'); if (r.status === 'Uncertain') tr.className = 'unc';
    td(tr, r.status); const u = document.createElement('td'); const a = document.createElement('a');
    a.textContent = r.username; a.href = r.profile_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; u.appendChild(a); tr.appendChild(u);
    td(tr, r.followers); td(tr, r.posts); td(tr, r.likes); td(tr, r.whatsapp); td(tr, r.phone); td(tr, r.reason); td(tr, r.bio, 'bio'); tb.appendChild(tr);
  }
  $('log').textContent = (d.log || []).slice(-30).map((l) => new Date(l.t).toLocaleTimeString() + ' [' + l.type + '] ' + l.msg).join('\n');
}
chrome.storage.onChanged.addListener(render);
loadSettings().then(render);
setInterval(() => send({ type: 'sync' }), 2500);
