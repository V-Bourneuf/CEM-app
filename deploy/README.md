# CEM App — EC2 deployment guide

This deploys the CEM App behind nginx + Let's Encrypt on a single EC2 instance. The result is a public HTTPS endpoint with three concerns:

| Path                | What it serves                                                     |
|---------------------|--------------------------------------------------------------------|
| `/`                 | Public landing page (flow picker + admin CTA)                      |
| `/byo`, `/scim`     | Per-flow SAML SSO demos (login → dashboard)                        |
| `/byo/scim/v2/*`    | SCIM 2.0 endpoint for the BYO Okta app (BYO user namespace)        |
| `/scim/scim/v2/*`   | SCIM 2.0 endpoint for the SCIM Okta app (SCIM user namespace)      |
| `/admin/*`          | Local admin UI for entitlement catalog management                  |

## Prerequisites

- An EC2 instance — Amazon Linux 2023 or Ubuntu 22.04+. t3.small is plenty.
- A DNS A record pointing your chosen subdomain (e.g. `cemapp.example.com`) at the instance.
- Security group allowing inbound 80 + 443 (and 22 for SSH).
- An Okta tenant with Identity Governance enabled.

## One-shot install

```bash
# On your laptop, copy the repo to the EC2 instance:
rsync -av --exclude='.git' --exclude='node_modules' --exclude='data/' \
  --exclude='profiles/' --exclude='saml-debug.log' \
  ./ ec2-user@<your-ec2-host>:/tmp/cemapp/

# SSH in and run setup:
ssh ec2-user@<your-ec2-host>
sudo bash /tmp/cemapp/deploy/setup-ec2.sh cemapp.example.com you@example.com
```

The setup script will:

1. Install Node 20 LTS, nginx, certbot, openssl
2. Create a `cemapp` system user
3. Copy the app to `/opt/cemapp` and install dependencies
4. Install the systemd unit (`cemapp.service`) and nginx reverse-proxy site
5. Provision a Let's Encrypt cert via `certbot --nginx`
6. Restart nginx

## After setup — configure the SAML profiles

This app runs **two parallel SAML flows**, each backed by its own Okta app
integration. Set up one or both:

```bash
# BYO flow (SAML attrs + optional SCIM provisioning)
sudo -u cemapp /usr/bin/node /opt/cemapp/server.js --setup byo

# SCIM flow (Governance with SCIM 2.0)
sudo -u cemapp /usr/bin/node /opt/cemapp/server.js --setup scim
```

Each prompts for:

| Field                    | What to put                                                                |
|--------------------------|-----------------------------------------------------------------------------|
| Okta SSO URL             | App's IdP SSO URL (Sign On tab → ...okta.com/.../sso/saml)                  |
| SP Issuer / Audience URI | `https://cemapp.example.com/byo` or `.../scim` (matches the flow path)      |
| Skip SAML attributes     | `firstName,lastName,email` (default is fine)                                |
| Path to signing cert     | Paste in the cert downloaded from Okta Sign On tab                          |
| SCIM bearer token        | Generate with `openssl rand -hex 32` (optional for BYO, required for SCIM)  |
| Admin emails             | Comma-separated Okta emails to allow into `/admin` (optional)               |

Profiles are saved at `/opt/cemapp/profiles/byo/` and `/opt/cemapp/profiles/scim/`.

Alternatively, configure them via the admin UI at `/admin/integrations`
once the service is running and you have at least one flow up to sign in with.

## Start the service

```bash
sudo systemctl start cemapp
sudo systemctl status cemapp        # should show "active (running)"
sudo journalctl -u cemapp -f        # tail logs
```

You should see:
```
CEM App listening on https://cemapp.example.com

Flows:
  /byo   → ✓ configured
           SCIM endpoint: https://cemapp.example.com/byo/scim/v2  (✓ token set)
  /scim  → ✓ configured
           SCIM endpoint: https://cemapp.example.com/scim/scim/v2 (✓ token set)

Admin UI:  https://cemapp.example.com/admin
```

## Configure Okta to point at the EC2 instance

You need **two separate Okta app integrations**, one per flow.

**1. BYO app — generic SAML 2.0 template:**
- Single sign-on URL: `https://cemapp.example.com/byo/login/callback`
- Audience URI: `https://cemapp.example.com/byo`
- Enable Identity Governance → Governance Engine
- Define entitlement attributes via Identity Governance → Entitlement Management
- SAML Attribute Statements:
  - `access` (Basic) → `appuser.access`
  - `role`   (Basic) → `appuser.role`
- (Optional) Provisioning → Configure API Integration:
  - Base URL: `https://cemapp.example.com/byo/scim/v2`
  - API Token: the SCIM token you saved in the `byo` profile
  - To App → enable Create / Update / Deactivate Users to populate the BYO user namespace

**2. SCIM app — (Header Auth) Governance with SCIM 2.0:**
- SSO ACS URL Override: `https://cemapp.example.com/scim/login/callback`
- Audience URI Override: `https://cemapp.example.com/scim`
- Enable Identity Governance → Governance Engine
- Provisioning → Configure API Integration:
  - Base URL: `https://cemapp.example.com/scim/scim/v2`
  - API Token: the SCIM token you saved in the `scim` profile
- Provisioning → To App → enable Create Users / Update User Attributes / Deactivate Users
- Provisioning → Integration → Import Resources → populates the IGA catalog from `/scim/scim/v2/Roles` + `/scim/scim/v2/Entitlements`

**Verify:**
- `https://cemapp.example.com/` → flow picker landing
- `/byo` → orange-themed login → BYO app authenticates → `/byo/dashboard`
- `/scim` → purple-themed login → SCIM app authenticates → `/scim/dashboard`

## Operations

### Updating the app

The canonical "ship an iteration" flow is the **`cem-ship` Claude Code skill** at
`.claude/skills/cem-ship/SKILL.md` (project-local, gitignored). Configure it once
by copying `deploy/.deploy-target.example` → `deploy/.deploy-target` and filling
in the EC2 host, key path, app dir, system user, and service name. After that,
saying "ship it" / "iterate" / "deploy" in Claude Code triggers commit + push +
EC2 deploy + smoke checks in one shot.

Manual equivalent (use only if Claude isn't available):
```bash
# Variables — match deploy/.deploy-target
EC2_HOST=ec2-XX-XX-XX-XX.compute-1.amazonaws.com
EC2_KEY=~/Downloads/CEM.pem
APP_DIR=/opt/opsapp        # the live deploy on the reference instance
APP_USER=opsapp
SERVICE=opsapp.service

rsync -av -e "ssh -i $EC2_KEY" --exclude='.git' --exclude='node_modules' \
  --exclude='data/' --exclude='profiles/' --exclude='saml-debug.log' \
  --exclude='.env*' --exclude='.claude' \
  ./ ec2-user@$EC2_HOST:/tmp/$(basename $APP_DIR)/

ssh -i $EC2_KEY ec2-user@$EC2_HOST "set -e
  sudo rsync -a --delete --exclude=node_modules --exclude=data --exclude=profiles \
    --exclude='.env*' --exclude=saml-debug.log /tmp/$(basename $APP_DIR)/ $APP_DIR/
  sudo chown -R $APP_USER:$APP_USER $APP_DIR
  sudo runuser -u $APP_USER -- bash -c 'cd $APP_DIR && npm ci --omit=dev && npm rebuild better-sqlite3'
  sudo systemctl restart $SERVICE"
```

> **Note on `APP_DIR` / `APP_USER`:** The historical doc referenced `/opt/cemapp`
> and a `cemapp` system user. The reference instance at `cem.salteau.ca` actually
> runs as `opsapp` from `/opt/opsapp` under `opsapp.service`. New instances
> bootstrapped via `setup-ec2.sh` may use either — check `systemctl cat <service>`
> on your instance and update `deploy/.deploy-target` accordingly.

### Backups

The DB lives at `$APP_DIR/data/cemapp.db`. Back it up with cron:
```bash
sudo crontab -u $APP_USER -e
# add: 0 4 * * * sqlite3 $APP_DIR/data/cemapp.db ".backup $APP_DIR/data/backup-$(date +\%F).db"
```

### Rotating the Okta SCIM token

Each flow has its own token in `$APP_DIR/profiles/<flow>/config.json`. Either:
- Edit via the admin UI: `/admin/integrations/<flow>/edit` → update **SCIM bearer token** → Save. The router re-reads the token on every SCIM request, so no restart is needed for token rotation.
- Or edit the file directly:
  ```bash
  sudo -u $APP_USER vi $APP_DIR/profiles/scim/config.json   # or profiles/byo/
  # update "scimToken" value
  ```
- Then update the matching value in **Okta admin → Provisioning → API Integration** for the corresponding app.

### Adding admin users

Either:
- Add the Okta email to `adminEmails` in either `/opt/cemapp/profiles/byo/config.json` or `/opt/cemapp/profiles/scim/config.json` (both lists are unioned at startup) and restart, OR
- Enable the **Administration** profile in `/admin/profiles`, then assign the **App Admin** role to the user via Okta IGA — the SCIM PATCH grants admin access automatically.

## Troubleshooting

**`cemapp.service` fails to start** → check `journalctl -u cemapp -n 100`. Most common cause: malformed `profiles/byo/config.json` or `profiles/scim/config.json` (or unreadable `saml.pem`). The server tolerates a *missing* profile dir (the missing flow shows a placeholder) but will crash on a malformed one.

**Okta SCIM "Test API Credentials" fails** → verify the SCIM token in `profiles/<flow>/config.json` matches what you pasted into the matching Okta app, and that nginx is forwarding to Node. Hit `https://your-domain/<flow>/scim/v2/ServiceProviderConfig` with `Authorization: Bearer <token>` from anywhere — should return JSON. Make sure you're hitting the right per-flow URL (`/byo/scim/v2/...` for the BYO app, `/scim/scim/v2/...` for the SCIM app).

**Cert renewal** → certbot installs a systemd timer automatically. Check with `sudo systemctl list-timers | grep certbot`.

**No entitlements showing in Okta after import** → verify the SCIM endpoint returns them: `curl -H "Authorization: Bearer <token>" https://your-domain/<flow>/scim/v2/Entitlements | jq '.totalResults'`. If 0, the catalog is empty — enable a profile in `/admin/profiles` first. The DB lives at `/opt/cemapp/data/cemapp.db`.
