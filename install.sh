#!/bin/bash
# =====================================================
#  Installatie radio / weer / klok-app op Raspberry Pi OS (met bureaublad)
#  Gebruik:  bash install.sh
#  Mag je opnieuw draaien (bijv. na het vervangen van je logo).
# =====================================================
set -e

BRON="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/radio-app"

echo "==> App kopiëren naar $APP_DIR"
if [ "$BRON" != "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  cp -r "$BRON"/. "$APP_DIR"/
fi
chmod +x "$APP_DIR/start-kiosk.sh" "$APP_DIR/server.py"
GEBRUIKER="$(id -un)"

echo "==> Pakketten installeren"
sudo apt-get update
sudo apt-get install -y fonts-noto-color-emoji librsvg2-bin python3 git
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  sudo apt-get install -y chromium
fi

echo "==> Systeemhulp installeren (uitzetten, herstarten, wifi, updates, helderheid)"
sudo install -o root -g root -m 755 "$APP_DIR/radio-helper" /usr/local/sbin/radio-helper
SUDOERS="$(mktemp)"
echo "$GEBRUIKER ALL=(root) NOPASSWD: /usr/local/sbin/radio-helper" > "$SUDOERS"
sudo visudo -cf "$SUDOERS" >/dev/null
sudo install -o root -g root -m 440 "$SUDOERS" /etc/sudoers.d/radio-app
rm -f "$SUDOERS"

echo "==> Lokale server als dienst installeren"
sudo tee /etc/systemd/system/radio-app.service >/dev/null <<DIENST
[Unit]
Description=Radio-app lokale server
After=network.target

[Service]
User=$GEBRUIKER
ExecStart=/usr/bin/python3 $APP_DIR/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
DIENST
sudo systemctl daemon-reload
sudo systemctl enable radio-app.service
sudo systemctl restart radio-app.service

command -v nmcli >/dev/null || echo "    Let op: NetworkManager (nmcli) ontbreekt, wifi kiezen op het scherm werkt dan niet."

echo "==> Automatisch inloggen op bureaublad, labwc, geen schermbeveiliging"
sudo raspi-config nonint do_boot_behaviour B4 || true   # bureaublad + automatisch inloggen
sudo raspi-config nonint do_wayland W3 || true          # labwc als desktop
sudo raspi-config nonint do_blanking 1 || true          # scherm niet uitzetten

echo "==> Autostart instellen"
mkdir -p "$HOME/.config/labwc"
AUTOSTART="$HOME/.config/labwc/autostart"
if ! grep -q "start-kiosk.sh" "$AUTOSTART" 2>/dev/null; then
  echo "$APP_DIR/start-kiosk.sh &" >> "$AUTOSTART"
fi
# Voor oudere installaties met X11
if [ -d /etc/xdg/lxsession/LXDE-pi ]; then
  mkdir -p "$HOME/.config/lxsession/LXDE-pi"
  LX="$HOME/.config/lxsession/LXDE-pi/autostart"
  grep -q "start-kiosk.sh" "$LX" 2>/dev/null || echo "@$APP_DIR/start-kiosk.sh" >> "$LX"
fi

echo "==> Opstartscherm met eigen logo"
BOOT=/boot/firmware
[ -d "$BOOT" ] || BOOT=/boot

# Regenboogscherm uit
grep -q '^disable_splash=1' "$BOOT/config.txt" || echo 'disable_splash=1' | sudo tee -a "$BOOT/config.txt" >/dev/null

# Geen frambozen-logo's en geen knipperende cursor tijdens het opstarten
for p in quiet splash logo.nologo vt.global_cursor_default=0 plymouth.ignore-serial-consoles; do
  grep -qF -- "$p" "$BOOT/cmdline.txt" || sudo sed -i "1 s|\$| $p|" "$BOOT/cmdline.txt"
done

LOGO=$(sed -n "s/^[[:space:]]*logo:[[:space:]]*'\([^']*\)'.*/\1/p" "$APP_DIR/config.js" | head -1)
THEMA=/usr/share/plymouth/themes/pix
if [ -n "$LOGO" ] && [ -f "$APP_DIR/$LOGO" ]; then
  sudo apt-get install -y plymouth rpd-plym-splash >/dev/null 2>&1 || true
  if [ -d "$THEMA" ]; then
    [ -f "$THEMA/splash.png.origineel" ] || sudo cp "$THEMA/splash.png" "$THEMA/splash.png.origineel" 2>/dev/null || true
    case "$LOGO" in
      *.svg|*.SVG) rsvg-convert -w 420 "$APP_DIR/$LOGO" -o /tmp/radio-splash.png ;;
      *)           cp "$APP_DIR/$LOGO" /tmp/radio-splash.png ;;
    esac
    sudo cp /tmp/radio-splash.png "$THEMA/splash.png"
    sudo plymouth-set-default-theme pix || true
    echo "    initramfs bijwerken (kan even duren)…"
    sudo update-initramfs -u >/dev/null 2>&1 || true
  else
    echo "    Plymouth-thema 'pix' niet gevonden — opstartlogo overgeslagen."
  fi
else
  echo "    Logo '$LOGO' niet gevonden — opstartlogo overgeslagen."
fi

echo ""
echo "Klaar! Herstart de Pi met:  sudo reboot"
