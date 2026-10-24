#!/bin/bash
# Double-click or run in Terminal. Starts bridge for USB Android phone. Free. No emulator.
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Node missing. Install Node 20 LTS (macOS pkg) from nodejs.org, then run again."; exit 1; fi
if [ -x ./platform-tools/adb ]; then ADB_BIN="$PWD/platform-tools/adb"
elif command -v adb >/dev/null; then ADB_BIN="$(command -v adb)"
else
  echo "Downloading Android platform-tools (adb)..."
  curl -fL -o pt.zip https://dl.google.com/android/repository/platform-tools-latest-darwin.zip && unzip -q -o pt.zip && rm pt.zip
  ADB_BIN="$PWD/platform-tools/adb"
fi
[ -x "$ADB_BIN" ] || { echo "adb not found"; exit 1; }
echo "Checking phone..."
"$ADB_BIN" start-server >/dev/null 2>&1
"$ADB_BIN" devices
if ! "$ADB_BIN" devices | grep -qw device; then
  echo; echo "NO PHONE. Do this: Settings > About phone > tap Build number 7 times > Developer options > USB debugging ON."
  echo "Plug USB cable. Tap ALLOW on phone popup. Run again."; exit 1
fi
[ -f .token ] || { openssl rand -hex 24 > .token; chmod 600 .token; }
echo; echo "TOKEN (paste in extension Settings):"; cat .token; echo
echo "Phone model: $("$ADB_BIN" shell getprop ro.product.model | tr -d '\r')  Android $("$ADB_BIN" shell getprop ro.build.version.release | tr -d '\r')"
echo "Instagram installed: $("$ADB_BIN" shell pm list packages | grep -c com.instagram.android)  (1 = yes)"
echo "Leave this window open. Ctrl+C to quit."
ADB_BIN="$ADB_BIN" BRIDGE_TOKEN="$(cat .token)" DATA_DIR="$PWD/data" node bridge/server.js
