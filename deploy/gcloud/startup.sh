#!/usr/bin/env bash
set -euo pipefail

exec > >(tee -a /var/log/aurka-startup.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends docker.io docker-compose-v2 ca-certificates
systemctl enable --now docker
install -d -m 0700 -o 1000 -g 1000 /srv/aurka/data
install -d -m 0755 /srv/aurka/releases

echo "AURKA startup prerequisites ready"
