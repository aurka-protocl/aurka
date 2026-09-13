#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=""
REGION="us-central1"
ZONE="us-central1-a"
VM_NAME="aurka-sepolia-api"
API_HOSTNAME=":80"

usage() {
  echo "Usage: $0 --project PROJECT_ID [--region REGION] [--zone ZONE] [--vm-name NAME] [--api-hostname HOSTNAME]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_ID="${2:?missing project}"; shift 2 ;;
    --region) REGION="${2:?missing region}"; shift 2 ;;
    --zone) ZONE="${2:?missing zone}"; shift 2 ;;
    --vm-name) VM_NAME="${2:?missing VM name}"; shift 2 ;;
    --api-hostname) API_HOSTNAME="${2:?missing API hostname}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$PROJECT_ID" ]] || usage

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable compute.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com --project="$PROJECT_ID"

if ! gcloud compute addresses describe aurka-sepolia-ip --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute addresses create aurka-sepolia-ip --region="$REGION" --project="$PROJECT_ID"
fi

if ! gcloud compute firewall-rules describe aurka-sepolia-web --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute firewall-rules create aurka-sepolia-web \
    --project="$PROJECT_ID" \
    --network=default \
    --target-tags=aurka-sepolia \
    --allow=tcp:80,tcp:443 \
    --source-ranges=0.0.0.0/0 \
    --description="AURKA Sepolia API HTTPS edge"
fi

if ! gcloud compute firewall-rules describe aurka-sepolia-iap-ssh --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute firewall-rules create aurka-sepolia-iap-ssh \
    --project="$PROJECT_ID" \
    --network=default \
    --target-tags=aurka-sepolia \
    --allow=tcp:22 \
    --source-ranges=35.235.240.0/20 \
    --description="AURKA operator SSH through Google IAP"
fi

if ! gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --machine-type=e2-micro \
    --image-family=ubuntu-2404-lts-amd64 \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-standard \
    --address=aurka-sepolia-ip \
    --tags=aurka-sepolia \
    --scopes=cloud-platform \
    --metadata-from-file=startup-script="$(dirname "$0")/startup.sh"
else
  echo "VM already exists: $VM_NAME"
fi

IP="$(gcloud compute addresses describe aurka-sepolia-ip --region="$REGION" --project="$PROJECT_ID" --format='value(address)')"
cat <<SUMMARY
VM: $VM_NAME
Project: $PROJECT_ID
Region: $REGION
Zone: $ZONE
Public IP: $IP
Configured API listener: $API_HOSTNAME

No custom domain was found in the current Vercel account. Keep :80 for the
initial smoke deployment; replace it with an owned HTTPS hostname before final
public acceptance.
SUMMARY
