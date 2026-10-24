#!/usr/bin/env node
'use strict';
// Fake `adb` + fake Instagram for testing the bridge WITHOUT a phone (npm run sim). Not used in real runs.
const fs = require('fs');
const SF = process.env.SIM_STATE || '/tmp/fake-adb-state.json';
let S; try { S = JSON.parse(fs.readFileSync(SF, 'utf8')); } catch (_) { S = { screen: 'reel', reel: 0, dumps: 0, taps: 0, log: '', cur: null }; }
const save = () => fs.writeFileSync(SF, JSON.stringify(S));
const USERS = [
  { u: 'kookieverse', f: 2724, p: 45, kind: 'walink', country: 'India' },
  { u: 'dear.bento', f: 851, p: 124, kind: 'wabtn', country: 'India' },
  { u: 'bakedwithanaz', f: 825, p: 12, kind: 'contact', country: null },
  { u: 'bigbrand', f: 900000, p: 3000, kind: 'plain' },
  { u: 'mamaaabakess', f: 106, p: 11, kind: 'bio', country: 'Pakistan' },
];
const W = 720, H = 1600;
const N = (o) => Object.assign({ text: '', desc: '', id: '', pkg: 'com.instagram.android', b: [0, 0, 10, 10], go: null }, o);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function screenNodes() {
  const sc = S.screen, U = USERS[S.reel % USERS.length];
  const prof = (extra) => [
    N({ id: 'action_bar_title', text: U.u, b: [100, 60, 500, 140] }), N({ desc: 'Options', b: [620, 60, 700, 140], go: 'profile_menu', clickable: 1 }),
    N({ id: 'row_profile_header_textview_post_count', text: String(U.p), b: [200, 230, 300, 280] }),
    N({ id: 'row_profile_header_textview_followers_count', text: String(U.f), b: [340, 230, 440, 280] }),
    N({ id: 'row_profile_header_textview_following_count', text: '16', b: [520, 230, 600, 280] }),
    N({ id: 'profile_header_full_name', text: 'Name ' + U.u, b: [20, 300, 600, 340] }), ...extra];
  switch (sc) {
    case 'reel': return [N({ id: 'clips_viewer_view_pager', b: [0, 0, W, H] }), N({ id: 'clips_author_username', text: U.u, b: [100, 1300, 300, 1360], go: 'profile' }),
      N({ desc: 'Profile picture of ' + U.u, b: [20, 1300, 90, 1360], go: 'profile' }), N({ desc: 'Like number is 6,294', b: [600, 1000, 700, 1100] }), N({ id: 'clips_caption', text: 'yummy cookies', b: [20, 1380, 500, 1440] })];
    case 'reel_settings': return [N({ text: 'View fullscreen', b: [0, 1300, 700, 1360] }), N({ text: 'Speed', b: [0, 1380, 300, 1440] }), N({ text: 'Auto scroll', b: [0, 1460, 300, 1520] })];
    case 'profile': {
      const x = [];
      if (U.kind === 'bio') x.push(N({ id: 'profile_header_bio_text', text: 'Home baker. WhatsApp: 03001234567 order via DM', b: [20, 350, 700, 450] }));
      else x.push(N({ id: 'profile_header_bio_text', text: 'Cakes and cookies', b: [20, 350, 700, 450] }));
      if (U.kind === 'walink') x.push(N({ text: 'wa.me/918…', b: [60, 460, 300, 500], go: 'wa_web', clickable: 1 }));
      if (U.kind === 'wabtn') { x.push(N({ text: 'WhatsApp', b: [30, 520, 300, 580], go: 'whatsapp_app', clickable: 1 })); x.push(N({ text: 'Contact info', b: [320, 520, 600, 580], go: 'contact_sheet', clickable: 1 })); }
      if (U.kind === 'contact') x.push(N({ text: 'Contact info', b: [30, 520, 300, 580], go: 'contact_sheet', clickable: 1 }));
      return prof(x);
    }
    case 'contact_sheet': return [...prof([]), N({ text: 'Contact', b: [0, 1100, 700, 1160] }), N({ text: 'Call', b: [0, 1180, 700, 1220], go: null }), N({ text: '+62 812-5668-8338', b: [0, 1220, 700, 1260] }),
      N({ text: 'Email', b: [0, 1280, 700, 1320] }), N({ text: 'karinkamaryudi@gmail.com', b: [0, 1320, 700, 1360] }), N({ text: 'WhatsApp', b: [0, 1400, 700, 1480], go: 'whatsapp_app' })];
    case 'whatsapp_app': return [N({ pkg: 'com.whatsapp', id: 'conversation_contact_name', text: U.kind === 'contact' ? 'Chat' : '+971 50 123 4567', b: [100, 60, 600, 140] }), N({ pkg: 'com.whatsapp', text: 'Type a message', b: [0, 1500, 700, 1590] })];
    case 'wa_web': return [N({ id: 'action_bar_title', text: 'wa.me', b: [100, 60, 500, 140] }), N({ text: 'Chat on WhatsApp with +91 98765 43210', b: [20, 400, 700, 460] }), N({ text: 'Continue to Chat', b: [20, 500, 700, 560] })];
    case 'profile_menu': return [...prof([]), N({ text: 'Report', b: [0, 1100, 700, 1160] }), N({ text: 'About this account', b: [0, 1180, 700, 1240], go: 'about' }), N({ text: 'Block', b: [0, 1260, 700, 1320] })];
    case 'about': return [N({ id: 'action_bar_title', text: U.u, b: [100, 60, 500, 140] }), N({ text: 'About this account', b: [100, 150, 500, 200] }), N({ text: 'Date joined', b: [20, 300, 300, 340] }), N({ text: 'March 2022', b: [20, 340, 300, 380] })]
      .concat(U.country ? [N({ text: 'Account based in', b: [20, 420, 300, 460] }), N({ text: U.country, b: [20, 460, 300, 500] })] : []);
  }
  return [];
}
const toXml = (ns) => '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?><hierarchy rotation="0">' + ns.map((n) => `<node text="${esc(n.text)}" resource-id="${n.id ? 'com.instagram.android:id/' + n.id : ''}" class="x" package="${n.pkg}" content-desc="${esc(n.desc)}" clickable="${n.clickable ? 'true' : 'false'}" bounds="[${n.b[0]},${n.b[1]}][${n.b[2]},${n.b[3]}]"/>`).join('') + '</hierarchy>';
const a = process.argv.slice(2), cmd = a.join(' ');
const out = (s) => { process.stdout.write(s); save(); process.exit(0); };
const fail = (s) => { process.stderr.write(s); save(); process.exit(1); };
if (a[0] === '-s') a.splice(0, 2);
if (/^get-state/.test(a.join(' '))) out('device\n');
if (/wm size/.test(cmd)) out('Physical size: ' + W + 'x' + H + '\n');
if (/getprop ro.product.manufacturer/.test(cmd)) out('realme\n');
if (/getprop ro.product.model/.test(cmd)) out('RMX-SIM\n');
if (/getprop/.test(cmd)) out('11\n');
if (/uiautomator dump/.test(cmd) && !/pkill/.test(cmd)) {
  S.dumps++;
  if (process.env.SIM_FAIL_DUMPS && S.dumps % 3 === 1 && /\/dev\/tty/.test(cmd)) out('java.io.FileNotFoundException: /sys/board_info/user_cpu_freq: open failed: EACCES (Permission denied)\n\tat libcore.io.IoBridge.open(IoBridge.java:575)\n');
  const xml = toXml(screenNodes());
  if (/\/dev\/tty/.test(cmd)) out(xml + '\nUI hierchary dumped to: /dev/tty\n');
  S.file = xml; out('UI hierchary dumped to: /sdcard/__ui.xml\n');
}
if (a[0] === 'exec-out' && a[1] === 'cat') out(S.file || '');
if (/screencap/.test(cmd)) out('PNG');
if (/logcat -c/.test(cmd)) { S.log = ''; out(''); }
if (/logcat -d/.test(cmd)) out(S.log || '');
if (/input keyevent 0\b/.test(cmd) || /input (tap|swipe)/.test(cmd) && process.env.SIM_INJECT_FAIL) {
  if (process.env.SIM_INJECT_FAIL) fail("Exception occurred while executing 'swipe':\njava.lang.SecurityException: Injecting to another application requires INJECT_EVENTS permission\n");
  out('');
}
if (/input keyevent 4/.test(cmd)) {
  const back = { reel_settings: 'reel', profile: 'reel', contact_sheet: 'profile', whatsapp_app: 'profile', wa_web: 'profile', profile_menu: 'profile', about: 'profile_menu' };
  if (S.screen === 'profile') S.paused = false; S.screen = back[S.screen] || S.screen; S.log = ''; out('');
}
if (/input swipe/.test(cmd)) { S.paused = false; if (S.screen === 'reel' && !process.env.SIM_NO_SCROLL) S.reel++; out(''); }
if (/input tap/.test(cmd)) {
  const x = +a[a.indexOf('tap') + 1], y = +a[a.indexOf('tap') + 2]; S.taps++;
  const hit = screenNodes().reverse().find((n) => n.go && x >= n.b[0] - 6 && x <= n.b[2] + 6 && y >= n.b[1] - 6 && y <= n.b[3] + 6);
  if (S.screen === 'reel' && hit && process.env.SIM_FIRST_TAP_SHEET && !S.sheeted) { S.sheeted = 1; S.screen = 'reel_settings'; out(''); }
  if (S.screen === 'reel' && !hit && y > 400 && y < 900) { S.paused = !S.paused; out(''); }
  if (S.screen === 'reel' && hit && !S.paused && process.env.SIM_SHEET_UNLESS_PAUSED) { S.screen = 'reel_settings'; out(''); }
  if (hit) {
    S.screen = hit.go;
    if (hit.go === 'whatsapp_app' && USERS[S.reel % USERS.length].kind === 'contact') S.log = '05-01 I/ActivityTaskManager( 1): START u0 {act=android.intent.action.VIEW dat=https://wa.me/6281256668338?text pkg=com.whatsapp} from uid 10100\n';
  }
  out('');
}
out('');
