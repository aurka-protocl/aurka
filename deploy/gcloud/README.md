# AURKA Sepolia on Google Compute Engine

This is the persistent one-VM backend for the public Sepolia app. It runs the
real `sepolia-app.mjs` API gateway, Privy per-user agent worker, SQLite state,
faucet and Caddy edge. The frontend is deployed separately from the repository
root to Vercel.

## Current deployment choice

- Project: pass explicitly to every script; the current operator project is
  `gapwise-505217`.
- VM: `e2-micro`, Ubuntu 24.04 LTS, `pd-standard`, 30 GB, one replica.
- Default region/zone: `us-central1` / `us-central1-a`; verify quota and Free
  Tier eligibility before creation.
- Persistent state: `/srv/aurka/data` on the VM, mounted as `/data` in the API.
- Image: built locally, transferred as a compressed Docker image, and loaded on
  the VM. This avoids adding Artifact Registry storage for the first demo.
- Edge: Caddy listens on port 80 while no owned API domain is configured. Set
  `AURKA_API_HOSTNAME=api.example.com` after DNS points to the reserved IP;
  Caddy will then obtain HTTPS automatically.

The VM has a stable regional address named `aurka-sepolia-ip`. The only public
firewall ports are 80 and 443. SSH is limited to Google's IAP range and the
deployment script uses IAP tunnelling.

## Provision

Enablement and resource creation are idempotent and inspect the named resources
before creating them:

```bash
deploy/gcloud/provision.sh \
  --project gapwise-505217 \
  --region us-central1 \
  --zone us-central1-a \
  --vm-name aurka-sepolia-api \
  --api-hostname :80
```

The script enables Compute Engine, Secret Manager and Artifact Registry APIs,
creates the VM/firewall/static IP if absent, and never formats a disk. The
startup script installs Docker and creates the persistent directories.

## Runtime environment

Create a populated copy of `production.env.example` outside Git. It must use the
deployed mock-token addresses and Sepolia RPC from
`deploy/sepolia/sepolia-deployment.json`, all server-only Privy values, and the
actual Vercel hostname in `AURKA_ALLOWED_ORIGINS`. Keep
`AURKA_AGENT_TEST_MODE=false` on the hosted path; the cloud must not use the
local deterministic shortcut. The hosted provider is Vertex AI with
`GOOGLE_CLOUD_PROJECT=gapwise-505217`, `GOOGLE_CLOUD_LOCATION=global`, and
`gemini-3.1-flash-lite`. The API/worker VM must use ADC from its runtime service
account; do not put a model key in the env file, image, or browser. Treat
provider limits as an actionable unavailable state rather than a successful
trade.

Before starting the API, verify the runtime identity has Vertex AI User and the
VM has the `cloud-platform` OAuth scope:

```bash
gcloud projects add-iam-policy-binding gapwise-505217 \
  --member=serviceAccount:RUNTIME_SERVICE_ACCOUNT \
  --role=roles/aiplatform.user
gcloud compute instances describe aurka-sepolia-api \
  --zone=us-central1-a --format='value(serviceAccounts[0].scopes)'
```

The scope update is a VM lifecycle operation and should be performed during a
maintenance window after checking that no delegated session is mid-flight.

Do not put this file in Git, the Docker image, Vercel variables, VM metadata or
startup script. The deployment helper transfers it over the authenticated GCP
channel and stores it as `/srv/aurka/aurka.env` with mode 0600. Rotate it by
uploading a replacement and restarting only the API container.

## Build and deploy

The local checkout must already contain the reviewed generated contract
artifacts and Sepolia manifest. The image does not compile contracts at startup.

```bash
deploy/gcloud/deploy-image.sh \
  --project gapwise-505217 \
  --zone us-central1-a \
  --vm-name aurka-sepolia-api \
  --env-file /path/to/populated/aurka.env
```

The command builds with Node 24, includes compiled workspace packages and the
reviewed Sepolia ABI/manifest, uploads the image and compose files over IAP, and
restarts the API, bounded price operator, and Caddy. A failed new container
leaves the prior image available for rollback.

## Verify and operate

Before a domain is attached, use the stable IP for a basic HTTP check:

```bash
deploy/gcloud/smoke.sh http://PUBLIC_IP
gcloud compute ssh aurka-sepolia-api --project=gapwise-505217 \
  --zone=us-central1-a --tunnel-through-iap \
  --command 'cd /srv/aurka && sudo docker compose --env-file release.env ps'
```

After DNS and HTTPS are configured, use the API hostname instead. Caddy routes
`/api/*` by stripping `/api`; the Vercel rewrite therefore preserves the
browser's same-origin API path. `/health` checks process availability and
`/ready` includes service readiness. Neither endpoint exposes credentials.

For logs:

```bash
gcloud compute ssh aurka-sepolia-api --project=gapwise-505217 \
  --zone=us-central1-a --tunnel-through-iap \
  --command 'cd /srv/aurka && sudo docker compose --env-file release.env logs --tail=200 api edge'
```

The `price-operator` checks the mock oracle timestamps and live capacity every
30 seconds, with a 60-second freshness margin for the 120-second on-chain
price-age limit. It refreshes timestamps without resetting capacity, renews
capacity only when the directional budget is exhausted, and stops after 48
persistent operations so the deployer gas budget is bounded. Its structured
`started`, `idle`, `submitting`, `succeeded`, and `failed` messages are visible
with:

```bash
gcloud compute ssh aurka-sepolia-api --project=gapwise-505217 \
  --zone=us-central1-a --tunnel-through-iap \
  --command 'cd /srv/aurka && sudo docker compose --env-file release.env logs --tail=100 price-operator'
```

When the budget is exhausted, trading remains fail-closed and the operator log
reports the exact condition; renew it deliberately by redeploying/restarting the
operator with a reviewed budget and a funded deployer. The service never weakens
the on-chain 120-second price freshness rule.

For a safe SQLite backup, stop the API worker first, copy the database using
SQLite's `.backup` operation, then restart the exact release. Keep the backup
outside the image and VM boot disk. Never restore a backup over a running
database or replay a submitted transaction. A VM reboot must leave `/srv/aurka`
and the Docker restart policy intact.

## Rollback

Each release image is tagged with a UTC timestamp. On the VM, set
`AURKA_IMAGE=aurka-sepolia:TAG` in `/srv/aurka/release.env`, then run:

```bash
cd /srv/aurka
sudo docker compose --env-file release.env up -d --no-deps api
```

Do not delete the SQLite volume, alter the manifest, or start a second worker.
If a schema migration is incompatible, stop the API, restore the SQLite backup,
and redeploy the previous image instead of replaying operations.

## Cost and missing final step

An eligible `e2-micro` and standard persistent disk may fit Google's documented
Free Tier, but this is not a guaranteed zero-cost deployment. Public IPv4,
network egress, image transfer/storage, logs, backups and any larger machine can
still cost money; billing alerts are not a hard spending cap. No custom domain
is currently attached to the Vercel account, so final HTTPS API routing and
cross-device acceptance remain pending the user's DNS/domain choice.
