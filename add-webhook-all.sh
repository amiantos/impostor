#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Get all public, non-fork, non-archived repos for the authenticated user
REPOS=$(gh repo list --no-archived --source --visibility public --json nameWithOwner --jq '.[].nameWithOwner' --limit 200)

if [ -z "$REPOS" ]; then
  echo "No matching repos found."
  exit 0
fi

echo "Will add webhook to the following repos:"
echo "$REPOS"
echo ""
read -p "Continue? (y/N) " -r
if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

for REPO in $REPOS; do
  echo ""
  "$SCRIPT_DIR/add-webhook.sh" "$REPO" || echo "  Failed on $REPO (may already have the webhook)"
done

echo ""
echo "Done."
