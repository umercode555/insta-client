'use strict';
// Pure parsing helpers for uiautomator XML dumps. No dependencies.
function decode(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#10;/g, '\n').replace(/&#13;/g, '').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
}
function parseNodes(xml) {
  const nodes = [], re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = {}, ar = /([\w:-]+)="([^"]*)"/g;
    let k;
    while ((k = ar.exec(m[1]))) a[k[1]] = decode(k[2]);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds || '');
    nodes.push({
      text: a.text || '', desc: a['content-desc'] || '', pkg: a.package || '', cls: a.class || '',
      id: (a['resource-id'] || '').replace(/^.*:id\//, ''),
      clickable: a.clickable === 'true', bounds: b ? b.slice(1, 5).map(Number) : null,
    });
  }
  return nodes;
}
function parseCount(s) {
  if (s == null) return null;
  const m = /^(\d[\d.,]*)\s*([KkMm])?$/.exec(String(s).trim());
  if (!m) return null;
  let n = m[1];
  const suf = (m[2] || '').toUpperCase();
  if (suf) {
    n = n.includes('.') ? n.replace(/,/g, '') : n.replace(',', '.');
    return Math.round(parseFloat(n) * (suf === 'K' ? 1e3 : 1e6));
  }
  return parseInt(n.replace(/[.,]/g, ''), 10);
}
const center = (b) => b ? [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)] : null;
const USER_RE = /^[A-Za-z0-9._]{1,30}$/;

function findReel(nodes) {
  let username = null, tap = null, likes = null, caption = null;
  for (const n of nodes) {
    if (/clips_author_username|author_username|reel_.*username/i.test(n.id) && USER_RE.test(n.text.trim())) {
      username = n.text.trim(); tap = center(n.bounds); break;
    }
  }
  if (!username) for (const n of nodes) {
    const m = /^(?:Reel|Video|Clip) by ([A-Za-z0-9._]{1,30})\b/i.exec(n.desc) || /^Profile picture of ([A-Za-z0-9._]{1,30})$/i.exec(n.desc);
    if (m) { username = m[1]; tap = center(n.bounds); break; }
  }
  for (const n of nodes) {
    const m = /^Like number is (\d[\d.,]*[KkMm]?)/i.exec(n.desc) || /^(\d[\d.,]*[KkMm]?)\s+likes?\b/i.exec(n.desc);
    if (m) { likes = parseCount(m[1]); break; }
    if (/like_count/i.test(n.id) && n.text) { const c = parseCount(n.text); if (c != null) { likes = c; break; } }
  }
  for (const n of nodes) if (/caption/i.test(n.id) && (n.text || n.desc)) { caption = (n.text || n.desc).trim(); break; }
  let altTap = null;
  for (const n of nodes) { const m = /^Profile picture of ([A-Za-z0-9._]{1,30})$/i.exec(n.desc); if (m && (!username || m[1].toLowerCase() === username.toLowerCase())) { altTap = center(n.bounds); break; } }
  if (altTap && tap && altTap[0] === tap[0] && altTap[1] === tap[1]) altTap = null;
  const sponsored = nodes.some((n) => /^Sponsored$/i.test(n.text.trim()) || /^Sponsored$/i.test(n.desc.trim()));
  const isReelUi = nodes.some((n) => /^clips_|clips_viewer|reel_viewer/i.test(n.id));
  const key = username ? [username.toLowerCase(), (caption || '').slice(0, 40), likes].join('|') : null;
  return { username, tap, altTap, likes, caption, sponsored, isReelUi, key };
}

const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_CTX = /whats\s*app|\bwa\b|call|order|contact|phone|tel\b|mobile|📞|📱|☎|✆|📲/i;
// Phone numbers found in free text. ctx=true when a WhatsApp/call/order word sits right before it.
function findPhones(text) {
  const out = [], s = String(text || '');
  PHONE_RE.lastIndex = 0;
  let m;
  while ((m = PHONE_RE.exec(s))) {
    const raw = m[1].trim(), d = raw.replace(/\D/g, '').length;
    if (d < 9 || d > 15) continue;
    if (!(/^\+/.test(raw) || /[\s().-]/.test(raw) || /^0/.test(raw) || d >= 10)) continue;
    if (/^(19|20)\d\d[-.\s]/.test(raw) && d <= 12 && /[-.]/.test(raw)) continue;   // looks like a date
    const before = s.slice(Math.max(0, m.index - 24), m.index);
    out.push({ raw, ctx: PHONE_CTX.test(before), wa: /whats\s*app|\bwa\b/i.test(before) });
  }
  const seen = new Set();
  return out.filter((x) => { const k = x.raw.replace(/\D/g, ''); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.wa - a.wa) || (b.ctx - a.ctx));
}
function findEmails(text) { return [...new Set(String(text || '').match(EMAIL_RE) || [])]; }
// Digits of a WhatsApp number from any wa.me / api.whatsapp.com / whatsapp:// string. Returns '+digits' or null.
function waFromUrl(s) {
  s = String(s || '');
  let m = /wa\.me\/(?:\+)?(\d{8,15})(?!\d)/i.exec(s) || /[?&]phone=(?:%2B|\+)?(\d{8,15})(?!\d)/i.exec(s)
    || /whatsapp\.com\/send\/?\?[^\s]*?phone=(?:%2B|\+)?(\d{8,15})/i.exec(s);
  return m ? '+' + m[1] : null;
}
const DIAL = { pakistan: '92', india: '91', indonesia: '62', bangladesh: '880', 'united arab emirates': '971', 'saudi arabia': '966',
  'united kingdom': '44', 'united states': '1', canada: '1', australia: '61', 'sri lanka': '94', nepal: '977', malaysia: '60', singapore: '65',
  philippines: '63', nigeria: '234', kenya: '254', 'south africa': '27', egypt: '20', turkey: '90', 'türkiye': '90', qatar: '974', kuwait: '965',
  oman: '968', bahrain: '973', 'new zealand': '64', germany: '49', france: '33', italy: '39', spain: '34', brazil: '55', mexico: '52',
  thailand: '66', vietnam: '84', ghana: '233', jordan: '962', lebanon: '961', morocco: '212', iraq: '964', 'hong kong': '852', russia: '7' };
// '+E164' or null. Local-format numbers are only completed when the country is known (never guessed).
function normalizePhone(raw, country) {
  let d = String(raw || '').replace(/[^\d+]/g, ''); if (!d) return null;
  let plus = d[0] === '+'; d = d.replace(/\+/g, '');
  if (!plus && d.startsWith('00')) { plus = true; d = d.slice(2); }
  if (plus) return /^\d{8,15}$/.test(d) ? '+' + d : null;
  const cc = country && DIAL[String(country).toLowerCase()];
  if (!cc) return null;
  if (d.startsWith(cc) && d.length >= cc.length + 9) return '+' + d;
  if (d.startsWith('0')) d = d.slice(1);
  return /^\d{7,12}$/.test(d) ? '+' + cc + d : null;
}
// All visible lines (text + content-desc split on newlines), with owning node, de-duplicated per node.
function flatLines(nodes) {
  const out = [];
  for (const n of nodes) {
    const seen = new Set();
    for (const part of [n.text, n.desc]) for (const l of String(part || '').split('\n')) { const t = l.trim(); if (t && !seen.has(t)) { seen.add(t); out.push({ t, n }); } }
  }
  return out;
}
const hasLine = (nodes, re) => flatLines(nodes).some((x) => re.test(x.t));
const findByLabel = (nodes, re) => { const x = flatLines(nodes).find((y) => re.test(y.t) && y.n.bounds); return x ? center(x.n.bounds) : null; };
function findProfileMenuButton(nodes) {
  for (const n of nodes) if (n.bounds && (/^(Options|More options|More|Menu|Profile options)$/i.test(n.desc.trim()) || /action_bar_overflow|profile_.*menu|overflow/i.test(n.id))) return center(n.bounds);
  return null;
}

function parseProfile(nodes) {
  const texts = [];
  for (const n of nodes) { if (n.text) texts.push(n.text); if (n.desc) texts.push(n.desc); }
  let followers = null, following = null, posts = null;
  const put = (kind, v) => {
    const c = parseCount(v); if (c == null) return;
    if (/^post/i.test(kind) && posts == null) posts = c;
    else if (/^follower/i.test(kind) && followers == null) followers = c;
    else if (/^following/i.test(kind) && following == null) following = c;
  };
  for (const n of nodes) {
    if (!n.text) continue;
    if (/followers_count/i.test(n.id)) put('followers', n.text.trim());
    else if (/following_count/i.test(n.id)) put('following', n.text.trim());
    else if (/post_count|posts_count/i.test(n.id)) put('posts', n.text.trim());
  }
  for (const t of texts) {
    const flat = t.replace(/\s+/g, ' ').trim();
    const m = /^(\d[\d.,]*[KkMm]?)\s*(posts?|followers?|following)$/i.exec(flat);
    if (m) put(m[2], m[1]);
  }
  // stacked layout: a number node directly followed by its label node ("851" then "followers")
  const fl = flatLines(nodes);
  for (let i = 0; i + 1 < fl.length; i++) {
    if (/^\d[\d.,]*[KkMm]?$/.test(fl[i].t) && /^(posts?|followers?|following)$/i.test(fl[i + 1].t)) put(fl[i + 1].t, fl[i].t);
  }
  let bio = null, fullName = null, category = null, profileUser = null;
  for (const n of nodes) {
    if (!bio && /profile_header_bio|bio_text/i.test(n.id) && n.text) bio = n.text.trim();
    if (!fullName && /full_name/i.test(n.id) && n.text) fullName = n.text.trim();
    if (!category && /category/i.test(n.id) && n.text) category = n.text.trim();
    if (!profileUser && /action_bar_title|action_bar_large_title|profile_header_username|action_bar_username/i.test(n.id) && USER_RE.test(n.text.trim())) profileUser = n.text.trim();
  }
  const visible = [...new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' | ').slice(0, 2000);
  const linkRe = /(https?:\/\/[^\s|]+|(?:wa\.me|wa\.link|api\.whatsapp\.com|chat\.whatsapp\.com|whatsapp\.com)\/[^\s|]+)/gi;
  const hay = [bio || '', visible].join(' | ');
  const links = [...new Set((hay.match(linkRe) || []).map((s) => s.replace(/[.,;)]+$/, '')))];
  const whatsapp = links.find((l) => /wa\.me|wa\.link|whatsapp\.com/i.test(l)) || null;
  const waNumber = links.map(waFromUrl).find(Boolean) || null;
  // Link node we can tap when the displayed link is truncated ("wa.me/918…") or a short link
  let waLinkTap = null;
  for (const n of nodes) if (n.bounds && /(wa\.me|wa\.link|whatsapp\.com)/i.test(n.text + ' ' + n.desc) && !/^https?:\/\/chat\.whatsapp/i.test(n.text)) { waLinkTap = center(n.bounds); break; }
  const phoneList = findPhones([bio || '', category || '', visible].join(' | '));
  const emails = findEmails([bio || '', visible].join(' | '));
  const buttons = { whatsapp: findByLabel(nodes, /^WhatsApp$/i), contact: findByLabel(nodes, /^Contact( info)?$/i),
    email: findByLabel(nodes, /^Email$/i), call: findByLabel(nodes, /^Call$/i), text: findByLabel(nodes, /^Text$/i) };
  const isProfile = followers != null || posts != null;
  return { isProfile, followers, following, posts, bio, fullName, category, links, whatsapp, waNumber, waLinkTap, buttons, profileUser,
    phone: (phoneList[0] || {}).raw || null, phoneList, emails, visible, isPrivate: /This account is private/i.test(visible) };
}

// Which Instagram screen are we on? Overlays (sheets) are checked before the page underneath them.
const OVERLAY_KINDS = ['reel_settings', 'reel_menu', 'comments', 'share'];
function classifyScreen(nodes) {
  const cnt = {};
  for (const n of nodes) if (n.pkg) cnt[n.pkg] = (cnt[n.pkg] || 0) + 1;
  const pkg = (cnt['com.instagram.android'] >= 3) ? 'com.instagram.android' : (Object.keys(cnt).filter((k) => k !== 'com.android.systemui').sort((a, b) => cnt[b] - cnt[a])[0] || Object.keys(cnt)[0] || '');
  if (pkg && pkg !== 'com.instagram.android') return { kind: /whatsapp/.test(pkg) ? 'whatsapp' : 'foreign', pkg };
  const has = (re) => hasLine(nodes, re);
  if (has(/^(View fullscreen|Auto scroll)$/i) || (has(/^Speed$/i) && has(/^(\.5x|1x|1\.5x|2x)$/))) return { kind: 'reel_settings', pkg };
  if (has(/^(Not interested|Manage suggested content|Why you'?re seeing this post)$/i)) return { kind: 'reel_menu', pkg };
  if (has(/^(Add a comment\.{0,3}|Comments)$/i) || nodes.some((n) => /comment_composer|layout_comment_thread/i.test(n.id))) return { kind: 'comments', pkg };
  if (has(/^Add to story$/i) || (has(/^Copy link$/i) && has(/^Share to/i))) return { kind: 'share', pkg };
  if (has(/^Contact$/) && has(/^(Call|Email|Text|WhatsApp|Get directions|Address)$/i)) return { kind: 'contact_sheet', pkg };
  if (has(/^(Date joined|Account based in|Former usernames)$/i)) return { kind: 'about', pkg };
  if (has(/^About this account$/i)) return { kind: 'profile_menu', pkg };
  const prof = parseProfile(nodes);
  if (prof.isProfile) return { kind: 'profile', pkg, prof };
  const reel = findReel(nodes);
  if (reel.username || reel.isReelUi) return { kind: 'reel', pkg, reel };
  return { kind: 'unknown', pkg };
}

// "Contact" bottom sheet on business profiles: rows Call / Email / Text / WhatsApp / Address.
function parseContactSheet(nodes) {
  const fl = flatLines(nodes), out = { call: null, text: null, email: null, whatsapp: null, address: null, rowTap: {} };
  const LAB = /^(Call|Email|Text|WhatsApp|Address|Get directions|Directions|Contact|Cancel)$/i;
  for (let i = 0; i < fl.length; i++) {
    const m = /^(Call|Email|Text|WhatsApp|Address)$/i.exec(fl[i].t); if (!m) continue;
    const k = m[1].toLowerCase();
    if (fl[i].n.bounds && !out.rowTap[k]) out.rowTap[k] = center(fl[i].n.bounds);
    const nxt = fl[i + 1] && !LAB.test(fl[i + 1].t) ? fl[i + 1].t : null; if (!nxt) continue;
    if (k === 'email') { if (/@/.test(nxt)) out.email = findEmails(nxt)[0] || nxt; }
    else if (k === 'address') out.address = nxt;
    else if (/\d{7,}/.test(nxt.replace(/\D/g, '') ) && /^[+\d\s().-]+$/.test(nxt)) out[k] = nxt;
  }
  return out;
}
// "About this account" page → country ("Account based in") and join date.
function parseAbout(nodes) {
  const fl = flatLines(nodes); let country = null, joined = null, user = null;
  for (let i = 0; i < fl.length; i++) {
    let m;
    if (/^(Account based in|Based in)$/i.test(fl[i].t)) { const v = fl[i + 1] && fl[i + 1].t; if (v && !/^(Date joined|Verified|Former usernames)/i.test(v)) country = v; }
    else if ((m = /^(?:Account based in|Based in)\s*[:·-]?\s*(.+)$/i.exec(fl[i].t))) country = m[1].trim();
    else if (/^Date joined$/i.test(fl[i].t) && fl[i + 1]) joined = fl[i + 1].t;
    if (!user && USER_RE.test(fl[i].t) && /action_bar|title|username/i.test(fl[i].n.id)) user = fl[i].t;
  }
  return { country, joined, user };
}
const BLOCK_PATTERNS = [
  /try again later/i, /action blocked/i, /confirm it'?s you/i, /suspicious/i, /we restrict certain activity/i,
  /help us confirm/i, /temporarily blocked/i, /unusual activity/i, /verify (your )?(account|identity)/i, /enter the code/i,
  /your account has been (disabled|suspended)/i, /log in to instagram/i, /create new account/i, /we detected/i, /captcha/i,
];
function detectBlock(nodes) {
  const all = nodes.filter((n) => !/caption|bio|comment|description|username|full_name/i.test(n.id)).map((n) => n.text + ' ' + n.desc).join(' \n ');
  for (const p of BLOCK_PATTERNS) if (p.test(all)) return p.source;
  return null;
}
module.exports = { parseNodes, parseCount, findReel, parseProfile, detectBlock, classifyScreen, OVERLAY_KINDS, parseContactSheet, parseAbout,
  findPhones, findEmails, waFromUrl, normalizePhone, flatLines, hasLine, findByLabel, findProfileMenuButton, center };
