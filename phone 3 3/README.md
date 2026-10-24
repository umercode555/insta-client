# Reels Lead Finder — USB phone version (free)

Real Android phone + real Instagram + MacBook. No emulator. No server. No cost.

## Once (10 min)
1. **Node**: https://nodejs.org → download **v20 LTS** macOS installer (works on Catalina). Install.
2. **Phone**: Settings > About phone > tap *Build number* 7 times. Settings > Developer options > turn on *USB debugging*.
3. Plug phone to MacBook with USB cable. Phone popup "Allow USB debugging?" → tick Always allow → **Allow**.
4. Unzip this folder. Open Terminal:
   `cd ~/Downloads/phone && chmod +x start-mac.command && ./start-mac.command`
   (First run downloads adb from Google. Catalina may ask permission: System Preferences > Security > Allow.)
5. Copy TOKEN it prints. Keep window open.
6. Chrome > `chrome://extensions` > Developer mode ON > Load unpacked > pick `extension` folder.
7. Click extension icon > Settings: paste Token. Bridge URL stays `http://127.0.0.1:8787`.
8. Gemini key (free): https://aistudio.google.com > API Keys > Create. Paste in Settings. Model: `gemini-3.5-flash-lite` (check exact name in AI Studio; edit if different). Save.

## Every run
1. Phone: open Instagram > Reels > pick your topic ("Watch Reels"). Stay on a Reel.
2. Extension: type **Niche** (any industry: skincare, printing machine exporters, solar panels...). Optional keywords. Limits: followers 3000, posts 60. Save.
3. Press **Start**. Don't touch phone. Screen stays on while plugged.
4. Pause / Resume / Stop anytime. **Export CSV** anytime.

## Rules
- Use a secondary Instagram account. Automation breaks Instagram terms. Ban risk real.
- Lower limits: 40 visits/hour, 300/day by default. Start with 20/hour for first test.
- Auto-pause on Instagram warning screens. Fix by hand, press Resume.
- Uncertain = red. Check by hand. Missing data never guessed.
- Reel URL column empty in v1.

## What's new in 0.2 (all bugs below were found in the code)
- **Why it opened the Speed / Auto-scroll sheet:** when `uiautomator dump` failed, the old code fired a 1.8 s long-press *without waiting for it*; it overlapped the next tap and Instagram opened its settings sheet. Pressing Pause "fixed" it because the loop stopped overlapping. Now: no long-press, dump retried in 3 modes, stale uiautomator killed, and every step first checks *which screen it is on* (reel / sheet / profile / contact / about / WhatsApp / other app) and recovers with Back instead of blind taps.
- **Rejected leads** were never saved (only a `1` flag). Now saved with status Rejected + reason, visible under the **Rejected** tab, de-duplicated, and exported.
- **Flicker:** the dashboard wrote `syncedAt` to storage every 2.5 s, which re-built the whole table each time. Writes happen only on real change and rows are updated in place.
- **Duplicates:** a second sighting now fills in fields the first visit missed instead of being dropped. Profiles that failed to open are no longer marked "seen" forever.
- **Swipe silently failing** (older adb returns exit 0 on SecurityException) is now detected, and "same Reel after 4 swipes" pauses with the fix.
- **WhatsApp / contact / country** extraction (below).

## Real WhatsApp numbers (no extra Android app needed)
The bridge already controls the phone over ADB, so it reads results itself. In order, per profile (only for profiles that pass your follower/post limits):
1. Number already readable in bio / full `wa.me/<number>` link -> used directly, nothing tapped.
2. **WhatsApp button** on profile (e.g. dear.bento), **Contact info > WhatsApp row** (e.g. bakedwithanaz) or a truncated bio link (`wa.me/918…`, e.g. the.kookieverse) is tapped. The number is then read from (a) `adb logcat` - Android logs the launch intent `dat=https://wa.me/<number>`, (b) the on-screen `wa.me` page text, or (c) the WhatsApp chat header. Then it presses Back until the same profile is shown again; if the profile changed, the result is discarded.
3. Contact sheet also gives Call number, email, address. Local numbers (`0300…`) become `+92…` **only if** the country is known from About this account.
Country: ⋮ > About this account > "Account based in". Not shown = stored as `unknown`, never guessed.
Limits: saved WhatsApp contacts show a name, not a number; short links (`wa.link/xyz`) work only if the page shows the number; clipboard reading needs a helper app so it is not used; each extra tap is more Instagram activity (turn the three "Open..." boxes off in Settings for a faster, safer run).

## Phone errors
- `INJECT_EVENTS permission` -> your phone blocks simulated taps. Xiaomi/vivo: Developer options > **USB debugging (Security settings)**. Oppo/realme/OnePlus: Developer options > **Disable permission monitoring**. Replug USB. The tool now checks this at Start (and via **Test phone**) and pauses with this exact hint.
- `uiautomator ... /sys/board_info/user_cpu_freq ... EACCES` -> a harmless vendor-ROM bug inside uiautomator that happens intermittently. The bridge now retries via file mode, switches dump mode automatically and kills a stuck uiautomator; you only see it in the log if all attempts fail.
- Turn off the realme/ColorOS **app timer** for Instagram (the "Used for 50m" pill): its time-limit screen blocks Instagram.

## If it breaks
Click **Download diagnostics** in the dashboard (step-by-step trace + errors). Failures also save a screenshot and XML into `data/debug/`. Send those. Offline test without a phone: `cd bridge && npm run sim`.

(Old method) Phone on a Reel, then run:
Phone on a Reel, then run:
`curl -H "x-token: $(cat .token)" http://127.0.0.1:8787/dump > reel.xml`
Tap a profile, again > `profile.xml`. Send me both files + extension Log text.
