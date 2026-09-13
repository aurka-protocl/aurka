#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:?Usage: $0 http://PUBLIC_IP or https://API_HOSTNAME}"
curl --fail --silent --show-error "$BASE_URL/health"
printf '\n'
curl --fail --silent --show-error "$BASE_URL/ready"
printf '\n'
curl --fail --silent --show-error "$BASE_URL/api/health"
printf '\n'
