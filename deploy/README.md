# CEM App — EC2 deployment guide

This deploys the CEM App behind nginx + Let's Encrypt on a single EC2 instance. The result is a public HTTPS endpoint with three concerns:

| Path           | What it serves                                       |
|----------------|------------------------------------------------------|
| `/`            | Public SAML demo (login → dashboard)                 |
| `/scim/v2/*`   | SCIM 2.0 endpoint for Okta provisioning + discovery  |
| `/admin/*`     | Local admin UI for entitlement catalog management    |

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

## After setup — configure the SAML profile

The systemd unit is configured to load a profile named `production`. Create it once:

```bash
sudo -u cemapp /usr/bin/node /opt/cemapp/server.js --prompt
```

You'll be prompted for:

| Field                  | What to put                                              |
|------------------------|----------------------------------------------------------|
| Profile name           | `production`                                             |
| Okta Entry Point       | App's IdP SSO URL (Sign On tab → ...okta.com/.../sso/saml) |
| SP Issuer / Audience URI | `https://cemapp.example.com/cemapp` (your domain)      |
| Skip SAML attributes   | `firstName,lastName,email` (default is fine)             |
| Path to signing cert   | Paste in the cert downloaded from Okta Sign On tab       |
| SCIM bearer token      | Generate one: `openssl rand -hex 32`                     |
| Admin emails           | Comma-separated Okta emails to allow into `/admin`       |

Stop the prompt with Ctrl-C once the profile is saved (it lives at `/opt/cemapp/profiles/production/`).

## Start the service

```bash
sudo systemctl start cemapp
sudo systemctl status cemapp        # should show "active (running)"
sudo journalctl -u cemapp -f        # tail logs
```

You should see:
```
Loaded profile:  production
SCIM endpoint:   https://cemapp.example.com/scim/v2
Admin UI:        https://cemapp.example.com/admin   (auth: Okta SAML — you@example.com)
Listening on port 1337
```

## Configure Okta to point at the EC2 instance

In the Okta admin console, on your SAML app:

**1. Update SAML config** to point at the public URL:
- Single sign-on URL: `https://cemapp.example.com/login/callback`
- Audience URI: `https://cemapp.example.com/cemapp`

**2. Configure SCIM provisioning** (for entitlement discovery + assignment):
- App → **Provisioning → Configure API Integration**
- Base URL: `https://cemapp.example.com/scim/v2`
- API Token: the `SCIM_TOKEN` you set during profile setup
- ✅ Test API Credentials — should succeed
- Provisioning → To App → enable: Create Users, Update User Attributes
- Provisioning → Integration → **Import Resources** → discovers the entitlement catalog

**3. Verify discovery worked:**
- App → Entitlement Management tab → should show your active-profile entitlements imported
- Define Entitlement Bundles, attach access policies, etc.

## Operations

### Updating the app

From your laptop:
```bash
rsync -av --exclude='.git' --exclude='node_modules' --exclude='data/' \
  --exclude='profiles/' ./ ec2-user@<host>:/tmp/cemapp/
ssh ec2-user@<host> 'sudo rsync -a --delete --exclude=node_modules --exclude=data --exclude=profiles --exclude=".env*" --exclude=saml-debug.log /tmp/cemapp/ /opt/cemapp/ \
  && sudo -u cemapp -- sh -c "cd /opt/cemapp && npm ci --omit=dev && npm rebuild better-sqlite3" \
  && sudo systemctl restart cemapp'
```

### Backups

The DB is at `/opt/cemapp/data/cemapp.db`. Back it up with cron:
```bash
sudo crontab -u cemapp -e
# add: 0 4 * * * sqlite3 /opt/cemapp/data/cemapp.db ".backup /opt/cemapp/data/backup-$(date +\%F).db"
```

### Rotating the Okta SCIM token

Edit the production profile:
```bash
sudo -u cemapp vi /opt/cemapp/profiles/production/config.json
# update "scimToken" value
sudo systemctl restart cemapp
# Then update the matching value in Okta admin → Provisioning → API Integration
```

### Adding admin users

Either:
- Add the Okta email to `adminEmails` in `/opt/cemapp/profiles/production/config.json` and restart, OR
- Enable the **Administration** profile in `/admin/profiles`, then assign the **App Admin** role to the user via Okta IGA — the SCIM PATCH grants admin access automatically.

## Troubleshooting

**`cemapp.service` fails to start** → check `journalctl -u cemapp -n 100`. Most common cause: missing or unreadable `profiles/production/saml.pem` or `config.json`.

**Okta SCIM "Test API Credentials" fails** → verify the SCIM token in `config.json` matches what you pasted into Okta, and that nginx is forwarding to Node. Hit `https://your-domain/scim/v2/ServiceProviderConfig` with `Authorization: Bearer <token>` from anywhere — should return JSON.

**Cert renewal** → certbot installs a systemd timer automatically. Check with `sudo systemctl list-timers | grep certbot`.

**No entitlements showing in Okta after import** → verify the SCIM endpoint returns them: `curl -H "Authorization: Bearer <token>" https://your-domain/scim/v2/Entitlements | jq '.totalResults'`. If 0, the catalog is empty — enable a profile in `/admin/profiles` first. The DB lives at `/opt/cemapp/data/cemapp.db`.
