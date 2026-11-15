#!/usr/bin/env bash
# Installeert of werkt Thuishaven bij op Ubuntu Server, als systemd-dienst.
#
#   curl -fsSL https://raw.githubusercontent.com/TimonNL2/thuishaven/main/install.sh | sudo bash
#
# Andere poort:  ... | sudo PORT=80 bash
# Nog een keer draaien werkt het dashboard bij; je gegevens blijven staan.
set -euo pipefail

REPO="${REPO:-https://github.com/TimonNL2/thuishaven.git}"
DIR="${DIR:-/opt/thuishaven}"
PORT="${PORT:-8080}"
SERVICE=thuishaven
RUN_USER=dashboard

if [ "$(id -u)" -ne 0 ]; then
  echo "Draai dit script met sudo." >&2
  exit 1
fi

if ! command -v git >/dev/null || ! command -v python3 >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq git python3 ca-certificates
fi

if [ -d "$DIR/.git" ]; then
  echo "Bijwerken in $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "Installeren in $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
mkdir -p "$DIR/data"
chown -R "$RUN_USER":"$RUN_USER" "$DIR/data"

cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Thuishaven startpagina
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$DIR
Environment=PORT=$PORT
Environment=DASHBOARD_DATA=$DIR/data
ExecStart=/usr/bin/python3 $DIR/server.py
Restart=on-failure
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DIR/data

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Klaar. Open http://${IP:-localhost}:$PORT in je browser."
echo "Logboek bekijken: journalctl -u $SERVICE -f"
