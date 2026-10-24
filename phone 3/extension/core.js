'use strict';
// Shared logic: sync with bridge, classify leads, store. Runs in the service worker.
const Core = (() => {
  const DEFAULTS = {
    bridgeUrl: 'http://127.0.0.1:8787', token: '', niche: '', keywords: '',
    maxFollowers: 3000, minFollowers: 0, maxPosts: 60, requireContact: false,
    geminiKey: '', geminiModel: 'gemini-3.5-flash-lite',
    profilesPerHour: 40, dailyCap: 300, dwellMin: 4, dwellMax: 9,
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get: (k) => chrome.storage.local.get(k),
    set: (o) => chrome.storage.local.set(o),
  };
  async function getSettings() { const { settings } = await store.get('settings'); return { ...DEFAULTS, ...(settings || {}) }; }

  async function bridge(path, opts = {}) {
    const s = await getSettings();
    if (!s.token) throw new Error('Set bridge token in Settings');
    const r = await fetch(s.bridgeUrl.replace(/\/+$/, '') + path, {
      method: opts.method || 'GET',
      headers: { 'x-token': s.token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
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

  // Pure: size/contact filters + keyword match. Returns {verdict:'reject'|'match'|'unclear', reason, missing}
  function prefilter(d, s) {
    const missing = [];
    if (d.followers == null) missing.push('followers');
    if (d.posts == null) missing.push('posts');
    if (d.followers != null && d.followers > s.maxFollowers) return { verdict: 'reject', reason: 'followers > ' + s.maxFollowers };
    if (d.followers != null && d.followers < s.minFollowers) return { verdict: 'reject', reason: 'followers < ' + s.minFollowers };
    if (d.posts != null && d.posts > s.maxPosts) return { verdict: 'reject', reason: 'posts > ' + s.maxPosts };
    if (s.requireContact && !d.whatsapp && !d.phone) return { verdict: 'reject', reason: 'no public contact' };
    const text = [d.bio, d.category, d.fullName, d.caption, d.username].filter(Boolean).join(' \n ').toLowerCase();
    const fallback = d.bio ? '' : (d.visible || '').toLowerCase();
    const hit = keywordList(s).find((k) => text.includes(k) || (fallback && fallback.includes(k)));
    if (hit) return { verdict: 'match', reason: 'keyword: ' + hit, missing };
    return { verdict: 'unclear', reason: 'no keyword match', missing };
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
    } else { status = 'Uncertain'; reason = 'no keyword match, AI off'; }
    if (p.missing && p.missing.length) { status = 'Uncertain'; reason += '; missing ' + p.missing.join('+'); }
    return { verdict: 'save', status, reason };
  }

  const blankStats = () => ({ received: 0, saved: 0, matched: 0, uncertain: 0, rejected: 0, duplicates: 0 });
  async function processLead(d, s) {
    const key = String(d.username || '').toLowerCase(); if (!key) return;
    const { leads = {}, stats = blankStats(), rejected = {} } = await store.get(['leads', 'stats', 'rejected']);
    stats.received++;
    if (leads[key] || rejected[key]) { stats.duplicates++; return store.set({ stats }); }
    const c = await classify(d, s);
    if (c.verdict === 'reject') {
      stats.rejected++; rejected[key] = 1;
      return store.set({ stats, rejected });
    }
    leads[key] = {
      status: c.status, niche: s.niche, username: d.username, profile_url: d.profileUrl, reel_url: d.reelUrl || '',
      likes: d.likes, followers: d.followers, posts: d.posts, bio: d.bio || '', category: d.category || '',
      whatsapp: d.whatsapp || '', phone: d.phone || '', reason: c.reason, collected_at: new Date().toISOString(),
    };
    stats.saved++; if (c.status === 'Match') stats.matched++; else stats.uncertain++;
    await store.set({ leads, stats, rejected });
  }

  let chain = Promise.resolve();
  function sync() { chain = chain.then(doSync).catch((e) => store.set({ connected: false, lastError: String(e.message || e) })); return chain; }
  async function doSync() {
    const s = await getSettings(); if (!s.token) return;
    const st = await bridge('/state');
    await store.set({ bridgeState: st.state, bridgeLastId: st.lastId, bridgeSeen: st.seen, connected: true, lastError: '', syncedAt: Date.now() });
    let { cursor = 0 } = await store.get('cursor');
    if (cursor > st.lastId) cursor = 0; // bridge data was reset; dedupe protects us
    for (;;) {
      const r = await bridge('/events?since=' + cursor + '&limit=200');
      for (const ev of r.events) {
        if (ev.type === 'lead') await processLead(ev.data, s);
        else if (ev.type === 'blocked' || ev.type === 'error' || ev.type === 'info') {
          const { log = [] } = await store.get('log'); log.push({ t: ev.t, type: ev.type, msg: ev.data.reason || ev.data.message || ev.data.note || '' });
          await store.set({ log: log.slice(-100) });
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
        await bridge('/start', { method: 'POST', body: { dwellMin: s.dwellMin, dwellMax: s.dwellMax, profilesPerHour: s.profilesPerHour, dailyCap: s.dailyCap } });
        await sync(); return { ok: true };
      }
      case 'pause': case 'resume': case 'stop': await bridge('/' + m.type, { method: 'POST', body: {} }); await sync(); return { ok: true };
      case 'clear': await store.set({ leads: {}, rejected: {}, stats: blankStats(), log: [] }); return { ok: true };
      default: return { ok: false, error: 'unknown message' };
    }
  }
  return { DEFAULTS, prefilter, classify, handle, sync, getSettings, blankStats };
})();
if (typeof module !== 'undefined') module.exports = Core;
