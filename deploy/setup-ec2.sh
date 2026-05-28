#!/usr/bin/env bash
#
# setup-ec2.sh — one-shot installer for CEM App on a fresh EC2 instance.
# Tested on Amazon Linux 2023 and Ubuntu 22.04+.
#
# Usage (as a sudo-capable user):
#   sudo bash deploy/setup-ec2.sh cemapp.example.com you@example.com
#
# Steps performed:
#   1. Install Node 20 LTS, nginx, certbot
#   2. Create cemapp user
#   3. Copy app to /opt/cemapp, install deps, build native module
#   4. Install systemd unit + nginx site
#   5. Provision Let's Encrypt cert via certbot --nginx
#   6. Start the service
#
# Pre-reqs the operator must do AFTER this script:
#   - cd /opt/cemapp && sudo -u cemapp node server.js --prompt   (creates 'production' profile)
#     OR populate /opt/cemapp/.env.production with OKTA_ENTRYPOINT/OKTA_ISSUER/SCIM_TOKEN/etc.
#   - Place saml.pem at /opt/cemapp/profiles/production/saml.pem (or root if using .env mode)

set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <email>}"
EMAIL="${2:?Usage: $0 <domain> <email>}"

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="/opt/cemapp"

echo "==> Detecting OS"
. /etc/os-release
DISTRO="$ID"
echo "    Distro: $DISTRO ($PRETTY_NAME)"

# ---------- 1. Install packages ----------
echo "==> Installing system packages"
case "$DISTRO" in
    amzn)
        # AL2023's default 'nodejs' is v18 — better-sqlite3@12 requires Node 20+.
        # Pull from NodeSource and install build tools for native module compile.
        dnf remove -y nodejs nodejs-libs nodejs-npm nodejs-full-i18n nodejs-docs 2>/dev/null || true
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        dnf install -y nodejs nginx git python3-certbot-nginx openssl gcc-c++ make rsync
        ;;
    ubuntu|debian)
        export DEBIAN_FRONTEND=noninteractive
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs nginx git certbot python3-certbot-nginx openssl build-essential rsync
        ;;
    *)
        echo "Unsupported distro: $DISTRO" >&2; exit 1 ;;
esac

# ---------- 2. Create app user ----------
echo "==> Creating cemapp user"
id -u cemapp >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" --create-home cemapp

# ---------- 3. Install app ----------
echo "==> Copying app to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
      --exclude='.git/' \
      --exclude='node_modules/' \
      --exclude='data/*.db*' \
      --exclude='profiles/' \
      --exclude='saml-debug.log' \
      --exclude='.env' --exclude='.env.production' \
      "$SRC_DIR/" "$APP_DIR/"
chown -R cemapp:cemapp "$APP_DIR"

echo "==> Installing npm dependencies"
sudo -u cemapp -- env HOME="$APP_DIR" sh -c "cd '$APP_DIR' && npm ci --omit=dev || npm install --omit=dev"
# Rebuild native bindings against the system node
sudo -u cemapp -- sh -c "cd '$APP_DIR' && npm rebuild better-sqlite3"

# ---------- 4. systemd + nginx ----------
echo "==> Installing systemd unit"
cp "$APP_DIR/deploy/cemapp.service" /etc/systemd/system/cemapp.service
systemctl daemon-reload
systemctl enable cemapp

echo "==> Installing nginx site"
sed "s/cemapp.example.com/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/cemapp || \
    sed "s/cemapp.example.com/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/conf.d/cemapp.conf

# On Ubuntu we need to symlink into sites-enabled
if [ -d /etc/nginx/sites-enabled ]; then
    ln -sf /etc/nginx/sites-available/cemapp /etc/nginx/sites-enabled/cemapp
    rm -f /etc/nginx/sites-enabled/default
fi

# Make sure ACME challenge dir exists for certbot HTTP-01
mkdir -p /var/www/certbot
chown -R nginx:nginx /var/www/certbot 2>/dev/null || chown -R www-data:www-data /var/www/certbot 2>/dev/null || true

systemctl enable nginx
systemctl restart nginx

# ---------- 5. Let's Encrypt ----------
echo "==> Provisioning Let's Encrypt cert for $DOMAIN"
certbot --nginx --non-interactive --agree-tos --email "$EMAIL" -d "$DOMAIN" --redirect

# ---------- 6. Final ----------
echo
echo "==> Done. Next steps for the operator:"
echo
echo "   1) Configure the SAML profile interactively:"
echo "        sudo -u cemapp node $APP_DIR/server.js --prompt"
echo "      (Choose 'create new', name it 'production', supply Okta entry point + cert + SCIM token + admin creds.)"
echo "      Stop with Ctrl-C once profile is saved."
echo
echo "   2) Start the service:"
echo "        sudo systemctl start cemapp"
echo "        sudo systemctl status cemapp"
echo
echo "   3) Tail logs:"
echo "        sudo journalctl -u cemapp -f"
echo
echo "   The app will be reachable at: https://$DOMAIN"
echo "   SCIM base URL for Okta:        https://$DOMAIN/scim/v2"
echo "   Admin UI:                       https://$DOMAIN/admin"
