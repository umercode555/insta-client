'use strict';
const $ = (id) => document.getElementById(id);
const FIELDS = ['bridgeUrl', 'token', 'niche', 'keywords', 'maxFollowers', 'minFollowers', 'maxPosts', 'countries', 'requireContact', 'fetchWhatsApp', 'fetchContact', 'fetchCountry', 'geminiKey', 'geminiModel', 'profilesPerHour', 'dailyCap', 'dwellMin', 'dwellMax'];
const NUMS = new Set(['maxFollowers', 'minFollowers', 'maxPosts', 'profilesPerHour', 'dailyCap', 'dwellMin', 'dwellMax']);
const DEF = { bridgeUrl: 'http://127.0.0.1:8787', maxFollowers: 3000, minFollowers: 0, maxPosts: 60, geminiModel: 'gemini-3.5-flash-lite', profilesPerHour: 40, dailyCap: 300, dwellMin: 4, dwellMax: 9, fetchWhatsApp: true, fetchContact: true, fetchCountry: true, countries: '' };
const send = (m) => chrome.runtime.sendMessage(m);
const flash = (t) => { $('saved').textContent = t; setTimeout(() => ($('saved').textContent = ''), 4000); };
const setText = (el, v) => { v = v == null ? '' : String(v); if (el.textContent !== v) el.textContent = v; };   // never touch the DOM if nothing changed

// ---------- settings ----------
async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings'); const s = { ...DEF, ...settings };
  for (const k of FIELDS) { const el = $('f').elements[k]; if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k] ?? ''; }
  $('settings').open = !s.token;
}
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = {};
  for (const k of FIELDS) { const el = $('f').elements[k]; s[k] = el.type === 'checkbox' ? el.checked : NUMS.has(k) ? Number(el.value) : el.value.trim(); }
  try {
    const o = new URL(s.bridgeUrl); const host = o.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') { const ok = await chrome.permissions.request({ origins: [o.origin + '/*'] }); if (!ok) return flash('Permission for bridge host denied'); }
  } catch (_) { return flash('Bad bridge URL'); }
  await chrome.storage.local.set({ settings: s }); flash('Saved'); send({ type: 'sync' });
});
$('reclass').onclick = async () => { $('f').requestSubmit(); await new Promise((z) => setTimeout(z, 400)); const r = await send({ type: 'reclassify' }); flash(r && r.ok ? 'Re-applied: ' + r.changed + ' leads changed status' : (r && r.error) || 'failed'); };

// ---------- controls ----------
for (const t of ['pause', 'resume', 'stop']) $(t).onclick = async () => { const r = await send({ type: t }); if (r && r.ok === false) alert(r.error); };
$('start').onclick = async () => { const r = await send({ type: 'start', resetSeen: $('reset').checked }); if (r && r.ok === false) alert(r.error); };
$('clear').onclick = async () => { if (confirm('Delete ALL saved leads (including rejected) from this browser? Export first.')) { await send({ type: 'clear' }); data.leads = {}; data.stats = {}; schedule('leads'); schedule('status'); } };
$('test').onclick = async () => {
  const box = $('pf'); box.hidden = false; box.textContent = 'Testing phone…';
  const r = await send({ type: 'preflight' }); box.textContent = '';
  if (!r || r.ok === false) { box.textContent = (r && r.error) || 'failed'; return; }
  for (const c of r.result.checks) { const d = document.createElement('div'); d.className = c.pass ? 'ok' : 'no'; d.textContent = (c.pass ? '✓ ' : '✗ ') + c.name + ' — ' + c.detail; if (c.hint) { const i = document.createElement('i'); i.textContent = '  → ' + c.hint; d.appendChild(i); } box.appendChild(d); }
};
function download(name, mime, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
$('diag').onclick = async () => { const r = await send({ type: 'diag' }); download('diagnostics-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.txt', 'text/plain', r && r.ok ? r.text : 'failed: ' + ((r && r.error) || '')); };

// ---------- data cache (updated from storage events, so rendering never re-reads storage) ----------
const data = { leads: {}, stats: {}, bridgeState: {}, connected: false, lastError: '', log: [] };
const F = { tab: 'all', q: '', sort: 'new', limit: 150 };
const digits = (s) => String(s || '').replace(/\D/g, '');
const waNum = (r) => r.whatsapp_number || '';
const fmt = (n) => n == null || n === '' ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const hasContact = (r) => !!(waNum(r) || r.whatsapp_link || r.phone || r.email);

function filtered() {
  const q = F.q.toLowerCase();
  let a = Object.values(data.leads).filter((r) => {
    if (F.tab === 'Match' || F.tab === 'Uncertain' || F.tab === 'Rejected') { if (r.status !== F.tab) return false; }
    else if (F.tab === 'contact') { if (!hasContact(r) || r.status === 'Rejected') return false; }
    else if (F.tab === 'wa') { if (!waNum(r) || r.status === 'Rejected') return false; }
    if (!q) return true;
    return [r.username, r.full_name, r.bio, r.category, r.country, r.phone, r.phone_e164, r.whatsapp_number, r.email, r.reason].some((v) => v && String(v).toLowerCase().includes(q));
  });
  const rank = { Match: 0, Uncertain: 1, Rejected: 2 };
  if (F.sort === 'followers') a.sort((x, y) => (y.followers || 0) - (x.followers || 0));
  else if (F.sort === 'status') a.sort((x, y) => (rank[x.status] - rank[y.status]) || (x.collected_at < y.collected_at ? 1 : -1));
  else a.sort((x, y) => (x.collected_at < y.collected_at ? 1 : -1));
  return a;
}

// ---------- exports ----------
const COLS = ['status', 'username', 'full_name', 'category', 'country', 'whatsapp_number', 'wa_chat_link', 'phone', 'phone_e164', 'email', 'address', 'followers', 'following', 'posts', 'likes', 'bio', 'links', 'profile_url', 'niche', 'reason', 'signals', 'whatsapp_source', 'country_status', 'joined', 'notes', 'collected_at'];
const TEXTY = new Set(['bio', 'username', 'full_name', 'category', 'reason', 'niche', 'notes', 'address', 'links', 'signals', 'country']);
const NUMBERY = new Set(['whatsapp_number', 'phone', 'phone_e164']);
function cell(k, v) {
  if (v == null) return ''; let s = String(v);
  if (TEXTY.has(k) && /^[=+\-@\t\r]/.test(s)) s = "'" + s;                       // neutralise spreadsheet formulas in untrusted text
  if (NUMBERY.has(k) && s && !/^\+?[\d\s().-]*$/.test(s)) s = "'" + s;
  return s;
}
const exportRows = () => filtered().map((r) => ({ ...r, wa_chat_link: waNum(r) ? 'https://wa.me/' + digits(waNum(r)) : '' }));
$('csv').onclick = () => {
  const q = (s) => '"' + s.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const out = [COLS.join(',')]; for (const r of exportRows()) out.push(COLS.map((k) => q(cell(k, r[k]))).join(','));
  download('leads-' + F.tab + '-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv;charset=utf-8', '\ufeff' + out.join('\r\n'));
};
$('xls').onclick = () => {
  const h = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let t = '<html><head><meta charset="utf-8"></head><body><table border="1"><tr>' + COLS.map((c) => '<th>' + c + '</th>').join('') + '</tr>';
  for (const r of exportRows()) { const st = r.status === 'Uncertain' ? ' style="background:#ffcccc;color:#b00000"' : r.status === 'Rejected' ? ' style="background:#eeeeee;color:#777777"' : ''; t += '<tr' + st + '>' + COLS.map((k) => '<td>' + h(cell(k, r[k])) + '</td>').join('') + '</tr>'; }
  download('leads-' + F.tab + '-' + new Date().toISOString().slice(0, 10) + '.xls', 'application/vnd.ms-excel', t + '</table></body></html>');
};
$('copywa').onclick = async () => {
  const nums = [...new Set(filtered().map(waNum).filter(Boolean))];
  try { await navigator.clipboard.writeText(nums.join('\n')); } catch (_) { return alert('Clipboard blocked'); }
  const b = $('copywa'), o = b.textContent; b.textContent = 'Copied ' + nums.length; setTimeout(() => (b.textContent = o), 1800);
};

// ---------- lead table: keyed reconcile, rows are only rebuilt when their data changed ----------
const rows = new Map(); // username -> { tr, sig }
const open = new Set();
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function chip(label, value, href, cls) {
  const c = el('span', 'chip ' + (cls || '')); const a = el(href ? 'a' : 'span', '', label); if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  c.appendChild(a); const b = el('button', 'copy', '⧉'); b.dataset.v = value; b.title = 'Copy'; c.appendChild(b); return c;
}
function buildRow(tr, r) {
  tr.textContent = ''; tr.className = 's-' + r.status;
  const cls = r.status === 'Match' ? 'm' : r.status === 'Uncertain' ? 'u' : 'r';
  const t1 = el('td'); t1.appendChild(el('span', 'badge ' + cls, r.status)); tr.appendChild(t1);
  const t2 = el('td'); const a = el('a', 'a', r.username); a.href = r.profile_url || 'https://www.instagram.com/' + r.username + '/'; a.target = '_blank'; a.rel = 'noopener noreferrer'; t2.appendChild(a);
  if (r.full_name) t2.appendChild(el('span', 'sub', r.full_name)); if (r.category) t2.appendChild(el('span', 'sub', r.category)); tr.appendChild(t2);
  const t3 = el('td'); t3.appendChild(document.createTextNode(fmt(r.followers) + ' followers')); t3.appendChild(el('span', 'sub', fmt(r.posts) + ' posts · ' + fmt(r.likes) + ' likes')); tr.appendChild(t3);
  const t4 = el('td'); const wn = waNum(r);
  if (wn) t4.appendChild(chip('WhatsApp ' + wn, wn, 'https://wa.me/' + digits(wn), 'wa'));
  else if (r.phone_e164) t4.appendChild(chip('Try WA ' + r.phone_e164, r.phone_e164, 'https://wa.me/' + digits(r.phone_e164), 'wa'));
  else if (r.whatsapp_link) t4.appendChild(chip('WhatsApp link', r.whatsapp_link, r.whatsapp_link, 'wa'));
  if (r.phone && r.phone_e164 !== wn) t4.appendChild(chip('☎ ' + r.phone, r.phone, null));
  if (r.email) t4.appendChild(chip('✉ ' + r.email, r.email, 'mailto:' + r.email));
  if (r.address) t4.appendChild(el('span', 'sub', r.address));
  if (!hasContact(r)) t4.appendChild(el('span', 'chip soft', r.has_contact_button ? 'contact button not read' : 'no public contact'));
  tr.appendChild(t4);
  const t5 = el('td'); if (!r.country) t5.appendChild(el('span', 'unk', 'not checked')); else t5.appendChild(el('span', r.country === 'unknown' ? 'unk' : '', r.country)); tr.appendChild(t5);
  const t6 = el('td'); t6.appendChild(el('span', 'why', r.reason)); if (r.signals) t6.appendChild(el('span', 'sub sig', 'signals: ' + r.signals)); if (r.notes) t6.appendChild(el('span', 'sub note', r.notes)); tr.appendChild(t6);
  const t7 = el('td'); const key = r.username.toLowerCase();
  if (r.bio) { const d = el('details'); d.appendChild(el('summary', '', r.bio.replace(/\s+/g, ' ').slice(0, 70) + (r.bio.length > 70 ? '…' : ''))); d.appendChild(el('div', '', r.bio)); d.open = open.has(key); d.addEventListener('toggle', () => (d.open ? open.add(key) : open.delete(key))); t7.appendChild(d); }
  tr.appendChild(t7);
}
function renderLeads() {
  const all = filtered(), shown = all.slice(0, F.limit), tb = $('tb');
  setText($('count'), '(' + all.length + ' of ' + Object.keys(data.leads).length + ')');
  $('empty').hidden = shown.length > 0; $('more').hidden = all.length <= F.limit;
  const keep = new Set(); let prev = null;
  for (const r of shown) {
    const key = r.username.toLowerCase(); keep.add(key);
    const sig = JSON.stringify(r); let e = rows.get(key);
    if (!e) { e = { tr: document.createElement('tr'), sig: '' }; rows.set(key, e); }
    if (e.sig !== sig) { buildRow(e.tr, r); e.sig = sig; }
    const want = prev ? prev.nextSibling : tb.firstChild;
    if (e.tr !== want) tb.insertBefore(e.tr, want);
    prev = e.tr;
  }
  for (const [k, e] of rows) if (!keep.has(k)) { e.tr.remove(); rows.delete(k); }
}
$('tb').addEventListener('click', async (e) => {
  const b = e.target.closest('.copy'); if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.v); b.textContent = '✓'; setTimeout(() => (b.textContent = '⧉'), 1200); } catch (_) {}
});
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; F.tab = b.dataset.f; F.limit = 150; for (const x of $('tabs').children) x.classList.toggle('on', x === b); renderLeads(); });
let qt; $('q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => { F.q = $('q').value.trim(); F.limit = 150; renderLeads(); }, 150); });
$('sort').onchange = () => { F.sort = $('sort').value; renderLeads(); };
$('more').onclick = () => { F.limit += 150; renderLeads(); };

// ---------- status / log ----------
function renderStatus() {
  const st = data.stats || {}, b = data.bridgeState || {}, L = Object.values(data.leads);
  setText($('conn'), data.connected ? 'bridge connected' : 'bridge offline'); $('conn').className = 'pill ' + (data.connected ? 'on' : 'bad');
  setText($('run'), b.status || 'stopped'); $('run').className = 'pill ' + (b.status === 'running' ? 'on' : b.status === 'paused' ? 'mid' : '');
  const sc = $('screen'); sc.classList.toggle('hide', !(b.status === 'running' && b.screen)); setText(sc, 'phone: ' + (b.screen || ''));
  const msg = data.lastError || b.reason || ''; $('reason').hidden = !msg; setText($('reason'), msg);
  const set = (id, v) => setText($(id), v ?? 0), cnt = (s) => L.filter((r) => r.status === s).length;
  set('c-scanned', b.reelsScanned); set('c-visited', b.profilesVisited); set('c-match', cnt('Match')); set('c-unc', cnt('Uncertain')); set('c-rej', cnt('Rejected'));
  set('c-wa', L.filter((r) => waNum(r)).length); set('c-ctry', L.filter((r) => r.country && r.country !== 'unknown').length); set('c-dup', st.duplicates); set('c-hour', b.hourCount);
}
function renderLog() { const t = (data.log || []).slice(-60).map((l) => new Date(l.t).toLocaleTimeString() + ' [' + l.type + '] ' + l.msg).join('\n'); if ($('log').textContent !== t) { const p = $('log'), atEnd = p.scrollTop + p.clientHeight >= p.scrollHeight - 8; p.textContent = t; if (atEnd) p.scrollTop = p.scrollHeight; } }

let pending = {}, raf = 0;
function schedule(k) { pending[k] = true; if (!raf) raf = requestAnimationFrame(() => { raf = 0; const p = pending; pending = {}; if (p.status) renderStatus(); if (p.leads) renderLeads(); if (p.log) renderLog(); }); }
chrome.storage.onChanged.addListener((ch, area) => {            // only react to keys that matter, and only to real changes
  if (area !== 'local') return;
  for (const k of ['leads', 'stats', 'bridgeState', 'connected', 'lastError', 'log']) if (ch[k]) data[k] = ch[k].newValue === undefined ? (k === 'leads' ? {} : k === 'log' ? [] : data[k]) : ch[k].newValue;
  if (ch.leads) { schedule('leads'); schedule('status'); }
  if (ch.stats || ch.bridgeState || ch.connected || ch.lastError) schedule('status');
  if (ch.log) schedule('log');
});
(async () => {
  Object.assign(data, await chrome.storage.local.get(['leads', 'stats', 'bridgeState', 'connected', 'lastError', 'log']));
  data.leads = data.leads || {}; data.log = data.log || [];
  await loadSettings(); renderStatus(); renderLeads(); renderLog(); send({ type: 'sync' });
})();
setInterval(() => send({ type: 'sync' }), 2500);
