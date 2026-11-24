#!/usr/bin/env bash
# 从已放行 SSH 的机器部署到 Lightsail（本机 IP 需在 22 白名单内）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${DEPLOY_SSH_KEY_FILE:-$HOME/.ssh/lightsail/ema-mgt-oa-key.pem}"
HOST="${DEPLOY_HOST:-54.168.48.231}"
USER="${DEPLOY_USER:-ubuntu}"

rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude '.env' \
  -e "ssh -i $KEY -o IdentitiesOnly=yes" \
  "$ROOT/" "$USER@$HOST:/opt/reply-stats/"

ssh -i "$KEY" -o IdentitiesOnly=yes "$USER@$HOST" 'bash -s' <<'EOF'
set -euo pipefail
cd /opt/reply-stats
sudo cp deploy/reply-stats.nginx.conf /etc/nginx/sites-available/reply-stats
sudo nginx -t
sudo systemctl reload nginx
npm ci --omit=dev
sudo systemctl restart reply-stats
sleep 2
curl -fsS http://127.0.0.1:3100/healthz
echo
EOF
