#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=""
ZONE="us-central1-a"
VM_NAME="aurka-sepolia-api"
IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
ENV_FILE=""
PRESERVE_ENV=false

usage() {
  echo "Usage: $0 --project PROJECT_ID [--env-file FILE | --preserve-env] [--zone ZONE] [--vm-name NAME] [--tag TAG]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_ID="${2:?missing project}"; shift 2 ;;
    --zone) ZONE="${2:?missing zone}"; shift 2 ;;
    --vm-name) VM_NAME="${2:?missing VM name}"; shift 2 ;;
    --tag) IMAGE_TAG="${2:?missing tag}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?missing env file}"; shift 2 ;;
    --preserve-env) PRESERVE_ENV=true; shift ;;
    *) usage ;;
  esac
done
[[ -n "$PROJECT_ID" ]] || usage
if [[ "$PRESERVE_ENV" != true ]]; then
  [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] || usage
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "Building AURKA Sepolia backend image locally"
docker build -f "$ROOT/deploy/gcloud/Dockerfile.sepolia" -t "aurka-sepolia:$IMAGE_TAG" "$ROOT"
docker save "aurka-sepolia:$IMAGE_TAG" | gzip -1 > "$WORK/aurka-sepolia.tar.gz"

cp "$ROOT/deploy/gcloud/docker-compose.yml" "$WORK/docker-compose.yml"
cp "$ROOT/deploy/gcloud/Caddyfile" "$WORK/Caddyfile"
if [[ "$PRESERVE_ENV" != true ]]; then
  cp "$ENV_FILE" "$WORK/aurka.env"
  chmod 600 "$WORK/aurka.env"
fi
cat > "$WORK/release.env" <<EOF
AURKA_IMAGE=aurka-sepolia:$IMAGE_TAG
AURKA_API_HOSTNAME=:80
EOF

UPLOADS=(
  "$WORK/aurka-sepolia.tar.gz"
  "$WORK/docker-compose.yml"
  "$WORK/Caddyfile"
  "$WORK/release.env"
)
if [[ "$PRESERVE_ENV" != true ]]; then UPLOADS+=("$WORK/aurka.env"); fi
gcloud compute scp --project="$PROJECT_ID" --zone="$ZONE" \
  "${UPLOADS[@]}" "$VM_NAME:/tmp/aurka-release/"
ENV_INSTALL=""
if [[ "$PRESERVE_ENV" != true ]]; then
  ENV_INSTALL="sudo mv /tmp/aurka-release/aurka.env /srv/aurka/aurka.env; sudo chmod 600 /srv/aurka/aurka.env;"
else
  ENV_INSTALL="test -f /srv/aurka/aurka.env;"
fi
gcloud compute ssh "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE" --tunnel-through-iap --command \
  "set -e; sudo install -d -m 0700 -o 1000 -g 1000 /srv/aurka/data; sudo install -d -m 0755 /srv/aurka/releases; $ENV_INSTALL sudo mv /tmp/aurka-release/docker-compose.yml /tmp/aurka-release/Caddyfile /tmp/aurka-release/release.env /srv/aurka/; sudo gunzip -c /tmp/aurka-release/aurka-sepolia.tar.gz | sudo docker load; sudo rm -rf /tmp/aurka-release; cd /srv/aurka; sudo docker compose --env-file release.env up -d --remove-orphans; sudo docker image prune -f"

echo "Deployed image aurka-sepolia:$IMAGE_TAG to $VM_NAME"
