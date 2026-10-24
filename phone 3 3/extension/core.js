'use strict';
// Shared logic: sync with bridge, classify leads, store. Runs in the service worker.
const Core = (() => {
  const DEFAULTS = {
    bridgeUrl: 'http://127.0.0.1:8787', token: '', niche: '', keywords: '',
    maxFollowers: 3000, minFollowers: 0, maxPosts: 60, requireContact: false,
    geminiKey: '', geminiModel: 'gemini-3.5-flash-lite',
    profilesPerHour: 40, dailyCap: 300, dwellMin: 4, dwellMax: 9,
    fetchWhatsApp: true, fetchContact: true, fetchCountry: true, countries: '',
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get: (k) => chrome.storage.local.get(k),
    set: (o) => chrome.storage.local.set(o),
  };
  // Only write keys whose value really changed. The old code wrote `syncedAt: Date.now()` every 2.5 s, which fired
  // storage.onChanged in the dashboard, which rebuilt the whole lead table => constant flicker.
  async function setIfChanged(o) {
    const cur = await store.get(Object.keys(o)), out = {};
    for (const k of Object.keys(o)) if (JSON.stringify(cur[k]) !== JSON.stringify(o[k])) out[k] = o[k];
    if (Object.keys(out).length) await store.set(out);
  }
  async function getSettings() { const { settings } = await store.get('settings'); return { ...DEFAULTS, ...(settings || {}) }; }

  async function bridge(path, opts = {}) {
    const s = await getSettings();
    if (!s.token) throw new Error('Set bridge token in Settings');
    const r = await fetch(s.bridgeUrl.replace(/\/+$/, '') + path, {
      method: opts.method || 'GET',
      headers: { 'x-token': s.token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (opts.text) { if (!r.ok) throw new Error('bridge HTTP ' + r.status); return r.text(); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || 'bridge HTTP ' + r.status);
    return j;
  }

  // Works for any industry: explicit keywords win; else niche phrase + niche without generic words (exporters, suppliers...).
  const GENERIC = /\b(exporters?|importers?|suppliers?|manufacturers?|brands?|companies|company|business(es)?|shops?|stores?|services?|dealers?|wholesalers?|vendors?|sellers?|agency|agencies|owners?)\b/g;
  const keywordList = (s) => {
    if ((s.keywords || '').trim()) return s.keywords.split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const n = (s.niche || '').trim().toLowerCase(); if (!n) return [];
    const stripped = n.replace(GENERIC, ' ').replace(/\s+/g, ' ').trim();
    return [...new Set([n, stripped].filter(Boolean))];
  };

  const hasContact = (d) => !!(d.waNumber || d.whatsapp || d.phone || d.email);
  const countryList = (s) => String(s.countries || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  // Cheap, explainable hints that an account is a real small business (shown in the UI; they never override a rejection)
  function signals(d) {
    const t = [d.bio, d.category, d.fullName].filter(Boolean).join(' ').toLowerCase(), out = [];
    if (d.category) out.push('category');
    if (d.hasContactButton || d.hasWhatsAppButton) out.push('contact button');
    if (d.waNumber || d.whatsapp) out.push('whatsapp'); else if (d.phone) out.push('phone');
    if (/\b(order|pre-?order|dm to order|book|booking|delivery|deliver|shipping|custom|bespoke|catalog|menu|price|shop|store|whatsapp)\b/.test(t)) out.push('selling words');
    return out;
  }
  // Pure: size/contact/country filters + keyword match. Returns {verdict:'reject'|'match'|'unclear', reason, missing}
  function prefilter(d, s) {
    const missing = [];
    if (d.followers == null) missing.push('followers');
    if (d.posts == null) missing.push('posts');
    if (d.followers != null && d.followers > s.maxFollowers) return { verdict: 'reject', reason: 'followers ' + d.followers + ' > ' + s.maxFollowers };
    if (d.followers != null && d.followers < s.minFollowers) return { verdict: 'reject', reason: 'followers ' + d.followers + ' < ' + s.minFollowers };
    if (d.posts != null && d.posts > s.maxPosts) return { verdict: 'reject', reason: 'posts ' + d.posts + ' > ' + s.maxPosts };
    if (s.requireContact && !hasContact(d)) return { verdict: 'reject', reason: 'no public contact' };
    const cl = countryList(s);
    if (cl.length && d.country && d.country !== 'unknown' && !cl.includes(String(d.country).toLowerCase())) return { verdict: 'reject', reason: 'country ' + d.country + ' not in [' + cl.join(', ') + ']' };
    const text = [d.bio, d.category, d.fullName, d.caption, d.username].filter(Boolean).join(' \n ').toLowerCase();
    const fallback = d.bio ? '' : (d.visible || '').toLowerCase();
    const kws = keywordList(s);
    const hit = kws.find((k) => text.includes(k) || (fallback && fallback.includes(k)));
    if (hit) return { verdict: 'match', reason: 'keyword: ' + hit, missing };
    return { verdict: 'unclear', reason: kws.length ? 'no keyword match' : 'no niche/keywords set', missing };
  }

  let lastAi = 0;
  async function askGemini(d, s) {
    const gap = 4500 - (Date.now() - lastAi); if (gap > 0) await wait(gap);
    lastAi = Date.now();
    const prompt = 'You classify Instagram business accounts.\nTarget niche: ' + s.niche + '\nUsername: ' + d.username +
      '\nName: ' + (d.fullName || '') + '\nCategory: ' + (d.category || '') + '\nBio: ' + (d.bio || '') +
      '\nReel caption: ' + (d.caption || '') + '\nOther visible profile text: ' + (d.visible || '').slice(0, 800) +
      '\n\nDoes this account belong to a business in the target niche (sells or offers products/services in it)? ' +
      'Use ONLY the text above. If the text is insufficient, answer "unsure". Never guess.\n' +
      'Reply JSON only: {"verdict":"yes"|"no"|"unsure","reason":"max 20 words"}';
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(s.geminiModel) + ':generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.geminiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
    });
    if (!r.ok) throw new Error('Gemini HTTP ' + r.status);
    const j = await r.json();
    const t = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts[0].text;
    const o = JSON.parse(String(t || '{}').replace(/```json|```/g, '').trim());
    if (!['yes', 'no', 'unsure'].includes(o.verdict)) throw new Error('Gemini bad verdict');
    return { verdict: o.verdict, reason: String(o.reason || '').slice(0, 200) };
  }

  async function classify(d, s) {
    const p = prefilter(d, s);
    if (p.verdict === 'reject') return p;
    let status, reason = p.reason;
    if (p.verdict === 'match') status = 'Match';
    else if (s.geminiKey && s.niche) {
      try {
        const a = await askGemini(d, s);
        if (a.verdict === 'yes') { status = 'Match'; reason = 'AI: ' + a.reason; }
        else if (a.verdict === 'no') return { verdict: 'reject', reason: 'AI no: ' + a.reason };
        else { status = 'Uncertain'; reason = 'AI unsure: ' + a.reason; }
      } catch (e) { status = 'Uncertain'; reason = 'AI error: ' + e.message; }
    } else { status = 'Uncertain'; reason = p.reason + ', AI off'; }
    if (p.missing && p.missing.length) { status = 'Uncertain'; reason += '; missing ' + p.missing.join('+'); }
    return { verdict: 'save', status, reason };
  }

  const blankStats = () => ({ received: 0, saved: 0, matched: 0, uncertain: 0, rejected: 0, duplicates: 0 });
  const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
  function toRecord(d, s, c, status) {
    const now = new Date().toISOString();
    return { status, niche: s.niche, username: d.username, full_name: d.fullName || '', category: d.category || '', profile_url: d.profileUrl || '', reel_url: d.reelUrl || '',
      likes: d.likes, followers: d.followers, following: d.following, posts: d.posts, bio: d.bio || '', caption: d.caption || '',
      country: d.country || '', country_status: d.countryStatus || '', joined: d.joined || '',
      whatsapp_number: d.waNumber || '', whatsapp_link: d.whatsapp || '', whatsapp_source: d.waSource || '',
      phone: d.phone || '', phone_e164: d.phoneE164 || '', email: d.email || '', address: d.address || '', links: (d.links || []).join(' '),
      has_contact_button: !!d.hasContactButton, signals: signals(d).join(', '), reason: c.reason, notes: (d.notes || []).join('; '), visible: (d.visible || '').slice(0, 600),
      collected_at: now, updated_at: now };
  }
  async function processLead(d, s) {
    const key = String(d.username || '').toLowerCase(); if (!key) return;
    const { leads = {}, stats = blankStats(), rejected = {} } = await store.get(['leads', 'stats', 'rejected']);
    stats.received++;
    if (leads[key] || rejected[key]) {                // duplicate: never create a second row, but fill in data the first visit missed
      stats.duplicates++;
      const old = leads[key];
      if (old) {
        const neu = toRecord(d, s, { reason: old.reason }, old.status); let changed = false;
        for (const k of Object.keys(neu)) if (!['status', 'niche', 'collected_at', 'updated_at', 'reason'].includes(k) && empty(old[k]) && !empty(neu[k])) { old[k] = neu[k]; changed = true; }
        if (changed) { old.updated_at = new Date().toISOString(); return store.set({ stats, leads }); }
      }
      return store.set({ stats });
    }
    const c = await classify(d, s);
    const status = c.verdict === 'reject' ? 'Rejected' : c.status;
    leads[key] = toRecord(d, s, c, status);           // rejected leads are saved too (status Rejected) so they are visible and de-duplicated
    if (status === 'Rejected') stats.rejected++; else { stats.saved++; if (status === 'Match') stats.matched++; else stats.uncertain++; }
    await store.set({ leads, stats });
  }
  // Re-run the cheap filters on everything already saved (after changing niche/keywords/limits). AI "Match" verdicts are kept.
  async function reclassify() {
    const s = await getSettings(), { leads = {} } = await store.get('leads'), stats = blankStats(); let changed = 0;
    for (const l of Object.values(leads)) {
      const d = { username: l.username, followers: l.followers, posts: l.posts, bio: l.bio, category: l.category, fullName: l.full_name, caption: l.caption, visible: l.visible,
        whatsapp: l.whatsapp_link, waNumber: l.whatsapp_number, phone: l.phone, email: l.email, country: l.country };
      const p = prefilter(d, s); let st = l.status, why = l.reason;
      if (p.verdict === 'reject') { st = 'Rejected'; why = p.reason; }
      else if (/^AI:/.test(l.reason || '') && l.status === 'Match') st = 'Match';
      else if (p.verdict === 'match') { st = 'Match'; why = p.reason; }
      else { st = 'Uncertain'; why = p.reason + ', AI off'; }
      if (st !== l.status) { l.status = st; l.reason = why; l.updated_at = new Date().toISOString(); changed++; }
      stats.received++; if (l.status === 'Rejected') stats.rejected++; else { stats.saved++; if (l.status === 'Match') stats.matched++; else stats.uncertain++; }
    }
    await store.set({ leads, stats }); return changed;
  }

  let chain = Promise.resolve();
  function sync() { chain = chain.then(doSync).catch((e) => setIfChanged({ connected: false, lastError: String(e.message || e) })); return chain; }
  async function doSync() {
    const s = await getSettings(); if (!s.token) return;
    const st = await bridge('/state');
    await setIfChanged({ bridgeState: st.state, bridgeLastId: st.lastId, bridgeSeen: st.seen, connected: true, lastError: '' });
    let { cursor = 0 } = await store.get('cursor');
    if (cursor > st.lastId) cursor = 0; // bridge data was reset; dedupe protects us
    for (;;) {
      const r = await bridge('/events?since=' + cursor + '&limit=200');
      for (const ev of r.events) {
        if (ev.type === 'lead') await processLead(ev.data, s);
        else if (ev.type === 'blocked' || ev.type === 'error' || ev.type === 'info') {
          const { log = [] } = await store.get('log'); log.push({ t: ev.t, type: ev.type, msg: ev.data.reason || ev.data.message || ev.data.note || '' });
          await store.set({ log: log.slice(-200) });
        }
        cursor = ev.id; await store.set({ cursor });
      }
      if (r.events.length < 200) break;
    }
  }

  async function handle(m) {
    switch (m && m.type) {
      case 'sync': await sync(); return { ok: true };
      case 'start': {
        const s = await getSettings();
        await bridge('/start', { method: 'POST', body: { dwellMin: s.dwellMin, dwellMax: s.dwellMax, profilesPerHour: s.profilesPerHour, dailyCap: s.dailyCap,
          maxFollowers: s.maxFollowers, minFollowers: s.minFollowers, maxPosts: s.maxPosts, fetchWhatsApp: s.fetchWhatsApp, fetchContact: s.fetchContact, fetchCountry: s.fetchCountry, resetSeen: !!m.resetSeen } });
        await sync(); return { ok: true };
      }
      case 'pause': case 'resume': case 'stop': await bridge('/' + m.type, { method: 'POST', body: {} }); await sync(); return { ok: true };
      case 'clear': await store.set({ leads: {}, rejected: {}, stats: blankStats(), log: [] }); return { ok: true };
      case 'reclassify': return { ok: true, changed: await reclassify() };
      case 'preflight': return { ok: true, result: await bridge('/preflight', { method: 'POST', body: {} }) };
      case 'diag': { const t = await bridge('/trace', { text: true }); const d = await store.get(['log', 'stats']); return { ok: true, text: t + '\n\nEXTENSION LOG\n' + (d.log || []).map((l) => new Date(l.t).toISOString() + ' [' + l.type + '] ' + l.msg).join('\n') + '\n\nSTATS ' + JSON.stringify(d.stats) }; }
      default: return { ok: false, error: 'unknown message' };
    }
  }
  return { DEFAULTS, prefilter, classify, handle, sync, getSettings, blankStats, signals };
})();
if (typeof module !== 'undefined') module.exports = Core;
