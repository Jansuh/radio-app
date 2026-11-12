#!/bin/bash
# Start de radio-app schermvullend in Chromium (kioskmodus).
# Wordt automatisch gestart na het inloggen op het bureaublad.

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFIEL="$HOME/.config/radio-kiosk"
BROWSER="$(command -v chromium || command -v chromium-browser)"

# Wacht (max. 30 sec) tot de lokale server draait
URL="file://$APP_DIR/index.html"
for i in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null; then
    URL="http://localhost:8080/index.html"
    break
  fi
  sleep 1
done

while true; do
  # Voorkom de melding "Chromium is niet correct afgesloten"
  PREFS="$PROFIEL/Default/Preferences"
  if [ -f "$PREFS" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS"
  fi

  "$BROWSER" \
    --kiosk \
    --user-data-dir="$PROFIEL" \
    --password-store=basic \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=Translate \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required \
    "$URL"

  # Crasht of sluit Chromium? Na 3 seconden opnieuw starten.
  sleep 3
done
