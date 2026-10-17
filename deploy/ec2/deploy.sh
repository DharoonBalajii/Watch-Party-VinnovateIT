#!/usr/bin/env bash
# Ship this checkout to the EC2 instance, build it there and restart the service.
#
#   deploy/ec2/deploy.sh ubuntu@13.48.10.20 ~/Downloads/watchparty.pem [domain]
#
# EXTRA_ORIGINS=https://my-site.netlify.app lets a separately hosted client use this server.
# YOUTUBE_API_KEY=AIza... turns on YouTube search (stored on the server; later runs keep it).
# First run also performs the one-time server setup (Node, Caddy, coturn, systemd).
set -euo pipefail
HOST=${1:?usage: deploy.sh user@host path/to/key.pem [domain]}
KEY=${2:?usage: deploy.sh user@host path/to/key.pem [domain]}
DOMAIN=${3:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

echo "==> Copying the app to ${HOST}"
"${SSH[@]}" "$HOST" 'sudo mkdir -p /opt/watchparty && sudo chown -R "$(id -u):$(id -g)" /opt/watchparty'
rsync -az --delete -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules --exclude .git --exclude client/dist --exclude .claude --exclude docs/results \
  --exclude 'server/media/test-clip.mp4' \
  "$ROOT/" "$HOST:/opt/watchparty/"

echo "==> Server setup (idempotent)"
"${SSH[@]}" "$HOST" "sudo DOMAIN='${DOMAIN}' EXTRA_ORIGINS='${EXTRA_ORIGINS:-}' YOUTUBE_API_KEY='${YOUTUBE_API_KEY:-}' bash /opt/watchparty/deploy/ec2/setup.sh"

echo "==> Installing dependencies and building"
"${SSH[@]}" "$HOST" 'cd /opt/watchparty && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null && sudo chown -R watchparty:watchparty /opt/watchparty && sudo systemctl restart watchparty'

D=$("${SSH[@]}" "$HOST" 'cat /etc/watchparty.domain')
echo "==> Waiting for https://${D}"
for i in $(seq 1 40); do
  if curl -fsS "https://${D}/api/health" >/dev/null 2>&1; then echo "==> Live: https://${D}"; exit 0; fi
  sleep 3
done
echo "Not answering yet. Check: ssh ... 'sudo journalctl -u watchparty -u caddy -n 80'" >&2
exit 1
