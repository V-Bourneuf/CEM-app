# OpsApp — EC2 deployment guide

This deploys the OpsApp behind nginx + Let's Encrypt on a single EC2 instance. The result is a public HTTPS endpoint with three concerns:

| Path           | What it serves                                       |
|----------------|------------------------------------------------------|
| `/`            | Public SAML demo (login → dashboard)                 |
| `/scim/v2/*`   | SCIM 2.0 endpoint for Okta provisioning + discovery  |
| `/admin/*`     | Local admin UI for entitlement catalog management    |

## Prerequisites

- An EC2 instance — Amazon Linux 2023 or Ubuntu 22.04+. t3.small is plenty.
- A DNS A record pointing your chosen subdomain (e.g. `opsapp.example.com`) at the instance.
- Security group allowing inbound 80 + 443 (and 22 for SSH).
- An Okta tenant with Identity Governance enabled.

## One-shot install

```bash
# On your laptop, copy the repo to the EC2 instance:
rsync -av --exclude='.git' --exclude='node_modules' --exclude='data/' \
  --exclude='profiles/' --exclude='saml-debug.log' \
  ./ ec2-user@<your-ec2-host>:/tmp/opsapp/

# SSH in and run setup:
ssh ec2-user@<your-ec2-host>
sudo bash /tmp/opsapp/deploy/setup-ec2.sh opsapp.example.com you@example.com
```

The setup script will:

1. Install Node 20 LTS, nginx, certbot, openssl
2. Create an `opsapp` system user
3. Copy the app to `/opt/opsapp` and install dependencies
4. Install the systemd unit (`opsapp.service`) and nginx reverse-proxy site
5. Provision a Let's Encrypt cert via `certbot --nginx`
6. Restart nginx

## After setup — configure the SAML profile

The systemd unit is configured to load a profile named `production`. Create it once:

```bash
sudo -u opsapp /usr/bin/node /opt/opsapp/server.js --prompt
```

You'll be prompted for:

| Field                  | What to put                                              |
|------------------------|----------------------------------------------------------|
| Profile name           | `production`                                             |
| Okta Entry Point       | App's IdP SSO URL (Sign On tab → ...okta.com/.../sso/saml) |
| SP Issuer / Audience URI | `https://opsapp.example.com/opsapp` (your domain)      |
| Skip SAML attributes   | `firstName,lastName,email` (default is fine)             |
| Path to signing cert   | Paste in the cert downloaded from Okta Sign On tab       |
| SCIM bearer token      | Generate one: `openssl rand -hex 32`                     |
| Admin UI username      | e.g. `admin`                                             |
| Admin UI password      | A strong password                                        |

Stop the prompt with Ctrl-C once the profile is saved (it lives at `/opt/opsapp/profiles/production/`).

## Start the service

```bash
sudo systemctl start opsapp
sudo systemctl status opsapp        # should show "active (running)"
sudo journalctl -u opsapp -f        # tail logs
```

You should see:
```
Loaded profile:  production
SCIM endpoint:   https://opsapp.example.com/scim/v2
Admin UI:        https://opsapp.example.com/admin   (basic auth: enabled)
Listening on port 1337
```

## Configure Okta to point at the EC2 instance

In the Okta admin console, on your SAML app:

**1. Update SAML config** to point at the public URL:
- Single sign-on URL: `https://opsapp.example.com/login/callback`
- Audience URI: `https://opsapp.example.com/opsapp`

**2. Configure SCIM provisioning** (for entitlement discovery + assignment):
- App → **Provisioning → Configure API Integration**
- Base URL: `https://opsapp.example.com/scim/v2`
- API Token: the `SCIM_TOKEN` you set during profile setup
- ✅ Test API Credentials — should succeed
- Provisioning → To App → enable: Create Users, Update User Attributes
- Provisioning → Integration → **Import Resources** → discovers the entitlement catalog

**3. Verify discovery worked:**
- App → Entitlement Management tab → should show 15 entitlements imported (4 roles + 11 access)
- Define Entitlement Bundles, attach access policies, etc.

## Operations

### Updating the app

From your laptop:
```bash
rsync -av --exclude='.git' --exclude='node_modules' --exclude='data/' \
  --exclude='profiles/' ./ ec2-user@<host>:/tmp/opsapp/
ssh ec2-user@<host> 'sudo rsync -a --delete --exclude=node_modules --exclude=data --exclude=profiles /tmp/opsapp/ /opt/opsapp/ \
  && sudo -u opsapp -- sh -c "cd /opt/opsapp && npm ci --omit=dev && npm rebuild better-sqlite3" \
  && sudo systemctl restart opsapp'
```

### Backups

The DB is at `/opt/opsapp/data/opsapp.db`. Back it up with cron:
```bash
sudo crontab -u opsapp -e
# add: 0 4 * * * sqlite3 /opt/opsapp/data/opsapp.db ".backup /opt/opsapp/data/backup-$(date +\%F).db"
```

### Rotating the Okta SCIM token

Edit the production profile:
```bash
sudo -u opsapp vi /opt/opsapp/profiles/production/config.json
# update "scimToken" value
sudo systemctl restart opsapp
# Then update the matching value in Okta admin → Provisioning → API Integration
```

### Tightening basic-auth on /admin

For a real deployment, replace basic auth with proper SAML-gated admin access. Contributions welcome.

## Troubleshooting

**`opsapp.service` fails to start** → check `journalctl -u opsapp -n 100`. Most common cause: missing or unreadable `profiles/production/saml.pem` or `config.json`.

**Okta SCIM "Test API Credentials" fails** → verify the SCIM token in `config.json` matches what you pasted into Okta, and that nginx is forwarding to Node. Hit `https://your-domain/scim/v2/ServiceProviderConfig` with `Authorization: Bearer <token>` from anywhere — should return JSON.

**Cert renewal** → certbot installs a systemd timer automatically. Check with `sudo systemctl list-timers | grep certbot`.

**No entitlements showing in Okta after import** → verify the SCIM endpoint returns them: `curl -H "Authorization: Bearer <token>" https://your-domain/scim/v2/Entitlements | jq '.totalResults'`. Should be 15. If 0 or error, the DB wasn't seeded — check `data/opsapp.db` exists and is readable by `opsapp` user.
