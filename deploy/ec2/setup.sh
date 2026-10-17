#!/usr/bin/env bash
# One-time (and safe to re-run) server setup for Watch Party on a fresh Ubuntu EC2 instance.
# Installs Node 22, Caddy (automatic HTTPS) and coturn (TURN relay for webcams / screen share),
# then runs the app as a systemd service behind Caddy.
#
#   sudo DOMAIN=watch.example.com bash setup.sh      # DOMAIN optional: defaults to <public-ip>.sslip.io
#   EXTRA_ORIGINS=https://my-site.netlify.app        # optional: other sites whose client uses this server
#   YOUTUBE_API_KEY=AIza...                          # optional: turns on YouTube search (kept across runs)
#
# The app itself is copied to /opt/watchparty by deploy.sh before this runs.
set -euo pipefail

APP_DIR=/opt/watchparty
ENV_FILE=/etc/watchparty.env
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
. /etc/os-release
if [[ "${ID}" != "ubuntu" && "${ID_LIKE:-}" != *debian* ]]; then
  echo "This script supports Ubuntu/Debian. Found: ${PRETTY_NAME}" >&2; exit 1
fi

# ── instance facts (IMDSv2) ─────────────────────────────────────────
TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' || true)
md() { curl -fsS -H "X-aws-ec2-metadata-token: ${TOKEN}" "http://169.254.169.254/latest/meta-data/$1" || true; }
PUBLIC_IP=$(md public-ipv4)
PRIVATE_IP=$(md local-ipv4)
[[ -z "${PUBLIC_IP}" ]] && PUBLIC_IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '\n')
[[ -z "${PRIVATE_IP}" ]] && PRIVATE_IP=$(hostname -I | awk '{print $1}')
DOMAIN=${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}
echo "==> Public IP ${PUBLIC_IP}, private IP ${PRIVATE_IP}, domain ${DOMAIN}"

# ── packages ───────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https rsync

if ! command -v node >/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 22 ]]; then
  echo "==> Installing Node 22"
  # NodeSource's "nodistro" repo works on any Ubuntu release; fall back to the distro package
  if curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs; then :; else
    apt-get install -y -qq nodejs npm
  fi
fi

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

if ! command -v turnserver >/dev/null; then
  echo "==> Installing coturn"
  apt-get install -y -qq coturn
fi

if ! command -v ffmpeg >/dev/null; then
  echo "==> Installing ffmpeg (checks and converts uploaded videos)"
  apt-get install -y -qq --no-install-recommends ffmpeg
fi

# a little swap so `npm ci` + the Vite build never get OOM-killed
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── secrets / env ──────────────────────────────────────────────────
id -u watchparty >/dev/null 2>&1 || useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin watchparty
mkdir -p "${APP_DIR}"
TURN_SECRET=$(grep -s '^TURN_SECRET=' "${ENV_FILE}" | cut -d= -f2- || true)
[[ -z "${TURN_SECRET}" ]] && TURN_SECRET=$(openssl rand -hex 32)
YOUTUBE_API_KEY=${YOUTUBE_API_KEY:-$(grep -s '^YOUTUBE_API_KEY=' "${ENV_FILE}" | cut -d= -f2- || true)}
cat > "${ENV_FILE}" <<ENV
NODE_ENV=production
PORT=4000
TURN_HOST=${DOMAIN}
TURN_SECRET=${TURN_SECRET}
ALLOWED_ORIGIN=https://${DOMAIN}${EXTRA_ORIGINS:+,${EXTRA_ORIGINS}}
UPLOAD_DIR=/var/lib/watchparty/uploads
UPLOAD_MAX_GB=4
UPLOAD_TOTAL_GB=12
YOUTUBE_API_KEY=${YOUTUBE_API_KEY}
ENV
chmod 640 "${ENV_FILE}"
chgrp watchparty "${ENV_FILE}"

# ── coturn ─────────────────────────────────────────────────────────
cat > /etc/turnserver.conf <<CONF
# Watch Party TURN relay. Credentials are short-lived HMACs minted by the app (/api/ice).
listening-port=3478
listening-ip=${PRIVATE_IP}
relay-ip=${PRIVATE_IP}
external-ip=${PUBLIC_IP}/${PRIVATE_IP}
min-port=${TURN_MIN_PORT}
max-port=${TURN_MAX_PORT}
realm=${DOMAIN}
use-auth-secret
static-auth-secret=${TURN_SECRET}
fingerprint
no-cli
no-tls
no-dtls
no-multicast-peers
total-quota=100
stale-nonce=600
# never relay into private networks or the EC2 metadata service
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
log-file=syslog
simple-log
CONF
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl enable --now coturn
systemctl restart coturn

# ── Caddy: HTTPS + websockets in front of the app ─────────────────
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4000
}
CADDY
systemctl enable --now caddy
systemctl reload caddy

# ── the app ────────────────────────────────────────────────────────
cat > /etc/systemd/system/watchparty.service <<UNIT
[Unit]
Description=Watch Party
After=network-online.target
Wants=network-online.target

[Service]
User=watchparty
Group=watchparty
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${APP_DIR}/node_modules/.bin/tsx server/src/index.ts
Restart=always
RestartSec=2
# ffmpeg conversions run inside this service's memory budget
MemoryMax=2500M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}
StateDirectory=watchparty
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable watchparty >/dev/null

echo "${DOMAIN}" > /etc/watchparty.domain
echo "==> Setup done. https://${DOMAIN}"
