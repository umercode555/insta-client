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

## If it breaks
Phone on a Reel, then run:
`curl -H "x-token: $(cat .token)" http://127.0.0.1:8787/dump > reel.xml`
Tap a profile, again > `profile.xml`. Send me both files + extension Log text.
