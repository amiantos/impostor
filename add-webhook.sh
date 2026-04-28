#!/usr/bin/env bash
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <owner/repo>"
  echo "Example: $0 amiantos/impostor"
  exit 1
fi

REPO="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/conf/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: $CONFIG_FILE not found"
  exit 1
fi

GITHUB_WEBHOOK_SECRET=$(node -e "process.stdout.write(require('$CONFIG_FILE').github_webhook?.secret ?? '')")

if [ -z "$GITHUB_WEBHOOK_SECRET" ]; then
  echo "Error: github_webhook.secret not set in $CONFIG_FILE"
  exit 1
fi

WEBHOOK_URL="${IMPOSTOR_WEBHOOK_URL:-https://webhook.bradroot.me/webhook}"
EVENTS='["fork","issues","pull_request","release","watch"]'

echo "Creating webhook on $REPO -> $WEBHOOK_URL ..."

gh api "repos/$REPO/hooks" \
  --method POST \
  --input - <<EOF
{
  "name": "web",
  "active": true,
  "events": $EVENTS,
  "config": {
    "url": "$WEBHOOK_URL",
    "content_type": "json",
    "secret": "$GITHUB_WEBHOOK_SECRET",
    "insecure_ssl": "0"
  }
}
EOF

echo "Webhook created on $REPO"
