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
      text: a.text || '', desc: a['content-desc'] || '',
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
  return { username, tap, likes, caption };
}

const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g;
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
  let bio = null, fullName = null, category = null;
  for (const n of nodes) {
    if (!bio && /profile_header_bio|bio_text/i.test(n.id) && n.text) bio = n.text.trim();
    if (!fullName && /full_name/i.test(n.id) && n.text) fullName = n.text.trim();
    if (!category && /category/i.test(n.id) && n.text) category = n.text.trim();
  }
  const visible = [...new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' | ').slice(0, 2000);
  const linkRe = /(https?:\/\/[^\s|]+|(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|whatsapp\.com)\/[^\s|]+)/gi;
  const hay = [bio || '', visible].join(' | ');
  const links = [...new Set((hay.match(linkRe) || []).map((s) => s.replace(/[.,;)]+$/, '')))];
  const whatsapp = links.find((l) => /wa\.me|whatsapp\.com/i.test(l)) || null;
  const phones = [...new Set(((bio || '') + ' | ' + (category || '') + ' | ' + visible).match(PHONE_RE) || [])]
    .map((s) => s.trim()).filter((s) => { const d = s.replace(/\D/g, '').length; return d >= 9 && d <= 15 && (/^\+/.test(s) || /[\s().-]/.test(s) || /^0/.test(s)); });
  const isProfile = followers != null || posts != null;
  return { isProfile, followers, following, posts, bio, fullName, category, links, whatsapp, phone: phones[0] || null, visible,
    isPrivate: /This account is private/i.test(visible) };
}
const BLOCK_PATTERNS = [
  /try again later/i, /action blocked/i, /confirm it'?s you/i, /suspicious/i, /we restrict certain activity/i,
  /help us confirm/i, /temporarily blocked/i, /unusual activity/i, /verify (your )?(account|identity)/i, /enter the code/i,
  /your account has been (disabled|suspended)/i, /log in to instagram/i, /create new account/i, /we detected/i, /captcha/i,
];
function detectBlock(nodes) {
  const all = nodes.map((n) => n.text + ' ' + n.desc).join(' \n ');
  for (const p of BLOCK_PATTERNS) if (p.test(all)) return p.source;
  return null;
}
module.exports = { parseNodes, parseCount, findReel, parseProfile, detectBlock };
