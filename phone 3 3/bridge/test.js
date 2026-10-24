'use strict';
const assert = require('assert');
const { parseCount, parseNodes, findReel, parseProfile, detectBlock } = require('./parse');
assert.strictEqual(parseCount('1,234'), 1234); assert.strictEqual(parseCount('2.3K'), 2300);
assert.strictEqual(parseCount('1,2K'), 1200); assert.strictEqual(parseCount('1.2M'), 1200000); assert.strictEqual(parseCount('abc'), null);
const x = `<hierarchy><node text="2,345followers" content-desc="" bounds="[0,0][2,2]"/><node text="" content-desc="56posts" bounds="[0,0][2,2]"/><node text="Hi &amp; bye +44 20 7946 0958 https://wa.me/447" resource-id="a:id/profile_header_bio_text" bounds="[0,0][2,2]"/></hierarchy>`;
const p = parseProfile(parseNodes(x));
assert.strictEqual(p.followers, 2345); assert.strictEqual(p.posts, 56); assert.ok(p.bio.includes('& bye'));
assert.strictEqual(p.whatsapp, 'https://wa.me/447'); assert.strictEqual(p.phone, '+44 20 7946 0958');
assert.strictEqual(parseProfile(parseNodes('<hierarchy></hierarchy>')).followers, null);
assert.ok(detectBlock(parseNodes('<hierarchy><node text="Try Again Later" bounds="[0,0][1,1]"/></hierarchy>')));
assert.strictEqual(findReel(parseNodes('<hierarchy><node content-desc="Reel by foo.bar. Double tap" bounds="[0,0][10,10]"/></hierarchy>')).username, 'foo.bar');

const P = require('./parse');
const node = (o) => '<node text="' + (o.t || '') + '" resource-id="' + (o.id || '') + '" package="' + (o.pkg || 'com.instagram.android') + '" content-desc="' + (o.d || '') + '" bounds="[0,0][10,10]"/>';
const X = (...a) => P.parseNodes('<hierarchy>' + a.map(node).join('') + '</hierarchy>');
// screen classification: overlays win over the page underneath, profile wins over reel-grid thumbnails
assert.strictEqual(P.classifyScreen(X({ t: 'View fullscreen' }, { t: 'Speed' }, { t: 'Auto scroll' }, { id: 'clips_author_username', t: 'foo' })).kind, 'reel_settings');
assert.strictEqual(P.classifyScreen(X({ id: 'clips_author_username', t: 'foo' })).kind, 'reel');
assert.strictEqual(P.classifyScreen(X({ t: '851 followers' }, { d: 'Reel by foo at row 1' })).kind, 'profile');
assert.strictEqual(P.classifyScreen(X({ t: 'Contact' }, { t: 'Call' }, { t: '+62 812-5668-8338' }, { t: '12 posts' })).kind, 'contact_sheet');
assert.strictEqual(P.classifyScreen(X({ t: 'Date joined' }, { t: 'March 2022' }, { t: 'About this account' })).kind, 'about');
assert.strictEqual(P.classifyScreen(X({ t: 'Report' }, { t: 'About this account' }, { t: '12 posts' })).kind, 'profile_menu');
assert.strictEqual(P.classifyScreen(X({ pkg: 'com.whatsapp', t: 'x' })).kind, 'whatsapp');
// contact sheet + about
const cs = P.parseContactSheet(X({ t: 'Contact' }, { t: 'Call' }, { t: '+62 812-5668-8338' }, { t: 'Email' }, { t: 'karinkamaryudi@gmail.com' }, { t: 'WhatsApp' }));
assert.strictEqual(cs.call, '+62 812-5668-8338'); assert.strictEqual(cs.email, 'karinkamaryudi@gmail.com'); assert.strictEqual(cs.whatsapp, null); assert.ok(cs.rowTap.whatsapp);
assert.strictEqual(P.parseAbout(X({ t: 'Date joined' }, { t: 'May 2021' }, { t: 'Account based in' }, { t: 'India' })).country, 'India');
assert.strictEqual(P.parseAbout(X({ t: 'Date joined' }, { t: 'May 2021' })).country, null);          // unavailable -> null, never guessed
// WhatsApp / phones
assert.strictEqual(P.waFromUrl('dat=https://wa.me/919266544785?text=hi'), '+919266544785');
assert.strictEqual(P.waFromUrl('https://api.whatsapp.com/send?phone=6281256668338'), '+6281256668338');
assert.strictEqual(P.waFromUrl('wa.me/918…'), null);                                                  // truncated link needs a tap
assert.strictEqual(P.normalizePhone('03001234567', 'Pakistan'), '+923001234567');
assert.strictEqual(P.normalizePhone('03001234567', null), null);                                      // no country -> not guessed
assert.strictEqual(P.normalizePhone('+91 92665 44785'), '+919266544785');
assert.strictEqual(P.findPhones('Order: WhatsApp 0300-1234567 or +44 20 7946 0958')[0].wa, true);
const sp = P.findReel(P.parseNodes('<hierarchy><node text="Sponsored" bounds="[0,0][1,1]"/><node resource-id="a:id/clips_author_username" text="brand" bounds="[0,0][9,9]"/></hierarchy>')); assert.ok(sp.sponsored);
console.log('parse tests ok');
