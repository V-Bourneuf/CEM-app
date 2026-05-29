# CEM App

A reference application that demonstrates **two distinct ways** to integrate
a custom SaaS app with **Okta Identity Governance — Customer Entitlement Management
(CEM)** — and runs **both flows simultaneously** in the same server, on
separate paths, with their own SAML configurations, their own SCIM endpoints,
their own user namespaces, and their own visual themes.

| URL                  | Flow                                       | Theme                | Okta integration                            |
|----------------------|--------------------------------------------|----------------------|---------------------------------------------|
| `/`                  | Landing page (flow picker + admin CTA)     | Neutral / Okta navy  | —                                           |
| `/byo`               | **BYO Entitlements**                       | 🟧 Orange + Navy     | Plain SAML 2.0 app on Okta                  |
| `/byo/scim/v2/*`     | SCIM 2.0 endpoint for the BYO Okta app     | —                    | Provisions into the BYO user namespace      |
| `/scim`              | **Governance with SCIM 2.0**               | 🟪 Purple + Navy     | (Header Auth) Governance with SCIM 2.0      |
| `/scim/scim/v2/*`    | SCIM 2.0 endpoint for the SCIM Okta app    | —                    | Provisions into the SCIM user namespace     |
| `/admin`             | Admin UI (catalog, integrations, users)    | Neutral              | SAML-gated by either flow's session         |

The bundled demo dataset uses a kitefoil designer/retailer scenario for
illustration; replace `db/profiles.js` with whatever entitlements fit your
own use case.

---

## Architecture

```
                    ┌────────────────────────┐    ┌────────────────────────┐
                    │  Okta App #1 — BYO     │    │  Okta App #2 — SCIM    │
                    │  (plain SAML 2.0)      │    │  (Governance w/ SCIM)  │
                    └─────┬───────────┬──────┘    └─────┬───────────┬──────┘
                          │ SAML       │ SCIM           │ SAML       │ SCIM
                          ▼            ▼                ▼            ▼
                       ┌──────────────────────────────────────────────────┐
                       │                  CEM App (this repo)              │
                       │ ┌─────────┐ ┌─────────────┐ ┌────────┐ ┌──────────┐ │
                       │ │  /byo   │ │ /byo/scim/v2 │ │ /scim  │ │/scim/scim│ │
                       │ │  🟧 SAML │ │ 🟧 SCIM API │ │ 🟪 SAML │ │ 🟪 /v2   │ │
                       │ └────┬────┘ └──────┬──────┘ └───┬────┘ └────┬────┘ │
                       │      │ BYO users   │            │ SCIM users │     │
                       │      ▼             ▼            ▼            ▼     │
                       │       ┌──────────────────────────────────────┐   │
                       │       │  SQLite — entitlements (shared) +    │   │
                       │       │  users (per-flow, UNIQUE(flow,name)) │   │
                       │       │  + user_entitlements                 │   │
                       │       └──────────────────────────────────────┘   │
                       │                                          /admin  │
                       └──────────────────────────────────────────────────┘
```

The two flows share:
- The entitlement catalog (`db/profiles.js`, edited via `/admin/profiles`)
- The admin authorization model (`admin/auth.js` — SAML + breakglass)

The two flows differ in:
- The Okta app integration that authenticates each `/byo/login/callback`
  vs `/scim/login/callback` (different signing certs, entry points, audiences)
- The SCIM endpoint each Okta app provisions to (`/byo/scim/v2` vs `/scim/scim/v2`)
- The user namespace each Okta app writes into — users are isolated per flow
  via `UNIQUE(flow, user_name)` in the `users` table
- The SCIM bearer token — each flow has its own
- Whether grants flow over SAML attributes (BYO falls back to this when a
  user signs in but hasn't been SCIM-provisioned), or always over SCIM PATCH
- The visual theme of `/byo/*` (orange) vs `/scim/*` (purple)

---

## The two integration flows

### BYO Entitlements (`/byo`)

Use this when:
- The Okta app integration is a **plain SAML 2.0** application
- The entitlement catalog values are authored in Okta IGA's **Entitlement
  Management** UI (per-app-instance) and shipped to the app via SAML
- You want a separate user namespace for the BYO Okta app

The BYO flow is primarily SAML-driven (grants ride on the SAML assertion),
but it also exposes a SCIM endpoint at `/byo/scim/v2` so the same Okta app
can provision users + grants into the BYO user namespace. Both behaviors
coexist: if the signed-in user has been SCIM-provisioned, the dashboard
reads grants from the DB; otherwise it falls back to the SAML attributes.

**On the Okta side:**

1. App Catalog → search a generic SAML 2.0 template (e.g. *SAML 2.0 Test App (Header Auth)*) → **Add Integration**
2. Configure SAML sign-on:
   - Single sign-on URL: `https://<your-domain>/byo/login/callback`
   - Audience URI: `https://<your-domain>/byo`
   - Name ID format: `EmailAddress`
   - Application username: `Email`
3. **General → Edit Identity Governance → Governance Engine: Enabled** (requires Okta IGA license)
4. Enable Governance Engine surfaces an **Entitlement Management** view at
   `/admin/app/em/instance/<appId>/entitlements`. Define your entitlement
   attributes there — typically `access` (array) and `role` (array) — and
   populate them with the values from your app's catalog (visible at
   `/admin/profiles` in this app).
5. **Sign On → SAML Attribute Statements** — add the two attribute statements
   the app reads on each login (`req.user.attributes.access`, `req.user.attributes.role`):

   | Name      | Name format | Value (Expression)   |
   |-----------|-------------|----------------------|
   | `access`  | `Basic`     | `appuser.access`     |
   | `role`    | `Basic`     | `appuser.role`       |
6. (Optional but recommended) **Provisioning → Configure API Integration**:
   - SCIM 2.0 Base URL: `https://<your-domain>/byo/scim/v2`
   - Authentication: HTTP Header
   - Token: paste the SCIM bearer token from the BYO integration config
   - Unique identifier field: `userName`
   - Test API Credentials → Save
   - **To App** → enable Create / Update / Deactivate Users
7. **Assignments** — assign users; populate each one's `access` / `role` arrays.

**On the app side:** save the BYO integration in `/admin/integrations`
(or set up via `node server.js --setup byo`). The dashboard at
`/byo/dashboard` reads grants from the BYO user namespace if the user has
been SCIM-provisioned, otherwise from `req.user.attributes`.

### Governance with SCIM 2.0 (`/scim`)

Use this when:
- You want **automated catalog discovery** — Okta pulls roles + entitlements from the app's `/scim/scim/v2/Roles` and `/scim/scim/v2/Entitlements` endpoints (no manual mirroring)
- You want **bidirectional provisioning into the SCIM user namespace**
- You want full IGA features (bundles, access policies, certifications) backed by SCIM

> ⚠️ **The app must be reachable from Okta's egress IPs.** Okta's SCIM
> client calls `/scim/scim/v2/*` directly. For local dev, expose the server
> with `ngrok http 1337` / `cloudflared tunnel --url http://localhost:1337`
> / Tailscale Funnel.

**On the Okta side:**

1. App Catalog → search **"Governance"** → pick **(Header Auth) Governance with SCIM 2.0** → **Add Integration**
   *(this template stamps the AppInstance with `IMPORT_USER_SCHEMA`, required for
   entitlement sync. Generic SCIM 2.0 Test App templates do **not** have this flag.)*
2. **General → Edit Identity Governance → Governance Engine: Enabled** → **Save → refresh**
3. **Sign On (SAML)** — fill in the override fields:
   - SSO ACS URL Override: `https://<your-domain>/scim/login/callback`
   - Audience URI Override: `https://<your-domain>/scim`
   - Recipient URL Override: `https://<your-domain>/scim/login/callback`
   - Destination URL Override: `https://<your-domain>/scim/login/callback`
   - SAML Attribute Statements: `firstName`, `lastName`, `email` (basic identity only — grants flow over SCIM, not SAML)
4. **Provisioning → Configure API Integration → Enable API integration**:
   - SCIM 2.0 Base URL: `https://<your-domain>/scim/scim/v2`
   - Authentication: **HTTP Header**
   - Token: paste the SCIM bearer token from your `/scim` integration config (raw — Okta's catalog template does **not** prepend `Bearer`; this app's `scim/auth.js` accepts both forms)
   - Unique identifier field for users: `userName`
   - **Import Groups: unchecked** (this app uses entitlements/roles, not groups)
   - **Test API Credentials** → must succeed → **Save**
5. **To App** subtab → enable: Create Users, Update User Attributes, Deactivate Users → **Save**
6. **Provisioning → Integration → Import Resources** → Okta probes `/scim/scim/v2/Roles` and `/scim/scim/v2/Entitlements`,
   populates the IGA catalog, and discovers the User schema from `/scim/scim/v2/Schemas`.
7. **Identity Governance → Entitlement Bundles** — group entitlements; attach to access policies / requests.
8. **Assignments → Assign people** — Okta SCIM-PATCHes the user to the app; the dashboard at `/scim/dashboard` reads grants from the local DB.

**On the app side:** save the SCIM integration in `/admin/integrations`
(or set up via `node server.js --setup scim`). The same SCIM bearer token
you paste here is the one Okta's API integration uses.

---

## Why two user namespaces?

Each flow corresponds to a different Okta app integration. Because both
apps now provision users, they could otherwise collide on `userName`.
The schema enforces `UNIQUE(flow, user_name)` instead of a global unique
constraint, so:
- Provisioning the same email (`alice@example.com`) into both apps creates
  two distinct user rows — one in the BYO namespace, one in the SCIM
  namespace — each with their own grants.
- A SAML login on `/byo` only sees the BYO row; a login on `/scim` only
  sees the SCIM row. Cross-flow access (e.g., guessing a user id from the
  other app) is rejected by the per-flow lookup.
- The admin UI at `/admin/users` shows all users from all flows in one table
  with a `Flow` column.

---

## Infrastructure prerequisites

A custom Okta-integrated app has a couple of unavoidable networking
requirements. Plan for these before you start.

| What you need | Why | Local-dev workaround |
|---------------|-----|----------------------|
| **Inbound HTTPS reachable from the user's browser** | Each flow's SAML callback (`/byo/login/callback` or `/scim/login/callback`) lands here after Okta authenticates the user. | `http://localhost:1337` is fine if you only need SAML — Okta only redirects the user's browser, not itself. |
| **Inbound HTTPS reachable from Okta's egress IPs** | Required for any flow with SCIM provisioning enabled — Okta's SCIM client calls `/<flow>/scim/v2/*` directly to probe the catalog and push grants. | Tunnel: `ngrok http 1337`, `cloudflared`, Tailscale Funnel. |
| **A valid TLS certificate** | Okta refuses to talk SCIM to a self-signed endpoint by default; SAML POSTs hit HTTPS only. | Tunnels above all hand you a free public HTTPS URL. For production, Let's Encrypt via certbot — `deploy/setup-ec2.sh` automates this. |
| **A domain name** | Let's Encrypt validates against a hostname; Okta's SAML/SCIM configs are URL-based. | Tunnel services give you a free `*.ngrok-free.app` / `*.trycloudflare.com` host. |

A domain is strongly recommended for any non-trivial demo. The bundled
EC2 deploy provisions a free Let's Encrypt cert; total cost is the
domain registration (~$10/yr).

### Firewall / security-group rules

For a production deploy on a typical cloud VM, open inbound:

| Port | Source | Purpose |
|------|--------|---------|
| 22   | your IP    | SSH (admin) |
| 80   | `0.0.0.0/0`| HTTP — Let's Encrypt HTTP-01 challenge; nginx redirects to 443 in production |
| 443  | `0.0.0.0/0`| HTTPS — public app + SAML callbacks (both flows) + SCIM endpoints (both flows) |

---

## Quick start (local dev)

```bash
git clone https://github.com/V-Bourneuf/CEM-app.git
cd CEM-app
npm install

# Set up the BYO profile (interactive)
node server.js --setup byo

# Set up the SCIM profile (interactive)
node server.js --setup scim

# Start the server (it loads both profiles automatically)
npm start
```

Each `--setup <flow>` writes `profiles/<flow>/config.json` + `saml.pem`.
You can also configure them later via the admin UI at `/admin/integrations`
(no terminal access required after first sign-in).

If you run `npm start` without configuring at least one flow, the
landing page shows a "not configured" placeholder for any missing flow.
The server still runs — `/admin` is reachable as long as you have at
least one configured flow (so you can sign in) or a breakglass account.

> For SCIM provisioning testing locally, expose with a tunnel and use the
> public URL as the Okta SCIM Base URL (`/<flow>/scim/v2`). If you only
> need SAML SSO with the BYO flow, you don't need a tunnel — Okta only
> talks to the user's browser.

---

## Production deployment

Full guide for AWS EC2 (Amazon Linux 2023 or Ubuntu) at
**[`deploy/README.md`](deploy/README.md)**. The flow:

```
laptop  →  rsync  →  /tmp/cemapp/  →  setup-ec2.sh
                                       ├── installs Node 20 + nginx + certbot
                                       ├── creates `cemapp` system user
                                       ├── installs systemd unit
                                       └── provisions Let's Encrypt
                                       
laptop  →  paste BYO + SCIM SAML profiles  →  /opt/cemapp/profiles/{byo,scim}/
                                       ↓
                                   sudo systemctl start cemapp
```

Production runs at `https://<your-domain>/`, fronted by nginx with TLS.

---

## Security & access model

### SAML
- Two passport-saml strategies (`saml-byo` and `saml-scim`), one per profile
- Sessions track which flow authenticated (`req.session.authFlow`); cross-flow
  navigation re-authenticates so each dashboard reflects the current flow's IdP
- Every SAML callback appended to `saml-debug.log` (gitignored) for tenant troubleshooting
- Helmet sets standard security headers; trust-proxy for nginx X-Forwarded-* support

### SCIM
- Bearer auth on every `/<flow>/scim/v2/*` endpoint (`scim/auth.js`)
- Each flow has its **own** bearer token (`profiles/<flow>/config.json`)
- Accepts both `Authorization: Bearer <token>` and raw `Authorization: <token>`
- The router resolves the token at request time so token rotation in the admin
  UI applies without a server restart (SAML strategy changes still require restart)

### `/admin` UI access — four paths to admin
Authoritative source: `admin/auth.js` (`getAdminVerdict`).

0. **Breakglass** — local username + password configured at install. Bypasses
   SAML entirely; the safety net when Okta is unreachable.
1. **Bootstrap allowlist** — email matches `ADMIN_EMAILS` (sourced from either
   profile's `adminEmails` field at startup, unioned). Set during installation;
   doesn't require a DB record. For first/initial admin and emergency access.
2. **SAML assertion-based** — the SAML attributes contain a `role` or `access`
   value matching an entitlement flagged `grants_admin = 1` (e.g. `App Admin`
   in the bundled Administration profile). The BYO flow uses this when a
   user is signed in but hasn't been SCIM-provisioned yet.
3. **SCIM grant-based** — user is provisioned in the DB (in the same flow they
   signed in through) and holds a `grants_admin = 1` entitlement. Assign
   **App Admin** in Okta IGA → SCIM PATCH → admin.

The login pages are intentionally minimal — a single "Sign in with Okta" button
per flow. The dashboard renders an "Admin →" chip in the header once the verdict
above resolves to admin; non-admins never see it. The landing page exposes a
secondary "Sign in to admin" CTA that routes to `/admin/login`.

---

## Entitlement profiles

The catalog is organized into profiles. The bundled dataset uses a kitefoil
designer/retailer scenario for illustration:

| Profile                        | Theme                                                             | Roles | Access |
|--------------------------------|-------------------------------------------------------------------|-------|--------|
| **Administration**             | App Admin role + manage_cem_app — both `grants_admin = true`      | 1     | 1      |
| **Retail & E-commerce**        | Store associates, e-commerce, customer service, returns           | 4     | 8      |
| **Engineering & Manufacturing** | Production engineers, QA, workshop, composite specialists         | 4     | 8      |
| **R&D / Design**               | Hydrofoil designers, naval architects, test pilots, materials      | 4     | 8      |
| **Software & DevOps**          | Internal platform engineering                                     | 4     | 11     |

Admins toggle profiles in `/admin/profiles`. **Enabling a profile inserts its
entitlements into the catalog table; disabling deletes them** (the FK on
`user_entitlements` cascades, revoking any user grants tied to those
entitlements). Disabled profiles have zero rows in the table — so
`/<flow>/scim/v2/Roles` and `/<flow>/scim/v2/Entitlements` only ever expose
entitlements from currently-enabled profiles.

---

## Repository layout

```
.
├── server.js               # Express app — loads both profiles, mounts /byo + /scim, /admin, /<flow>/scim/v2
├── profileManager.js       # Load/save SAML profiles + interactive `--setup` CLI
├── db/
│   ├── schema.sql          # SQLite DDL (entitlements, users with flow column, grants)
│   ├── index.js            # Connection, migrations, Entitlements/Users (flow-scoped)/Grants/Profiles APIs
│   └── profiles.js         # Static catalog templates (demo bundles)
├── scim/                   # All routers are factories taking a flowKey
│   ├── router.js           # buildScimRouter({flowKey, getScimToken}) — mounts the flow's SCIM 2.0 API
│   ├── auth.js             # buildBearerAuth(getExpectedToken) — flow-scoped bearer middleware
│   ├── users.js            # /Users CRUD; PATCH ops map roles+entitlements arrays into DB (flow-scoped)
│   ├── groups.js           # /Groups stub (Okta probes during sync)
│   ├── roles.js            # /Roles (type='role' subset; catalog is shared)
│   ├── entitlements.js     # /Entitlements (type='access' subset; catalog is shared)
│   └── schemas.js          # /ServiceProviderConfig /ResourceTypes /Schemas
├── admin/
│   ├── router.js           # Catalog/profile/user/integrations routes + denied-page renderer
│   ├── auth.js             # getAdminVerdict() — single source of truth for admin authz (flow-aware)
│   └── views/              # EJS templates for admin UI
├── public/
│   ├── views/              # landing.ejs (flow picker + admin CTA), login.ejs, dashboard.ejs, placeholder.ejs
│   └── css/                # styles.css (Okta palette + Playfair Display + theme classes), admin.css
└── deploy/
    ├── README.md           # EC2 deploy guide
    ├── setup-ec2.sh        # One-shot installer
    ├── nginx.conf          # Reverse proxy + Let's Encrypt
    ├── cemapp.service      # systemd unit
    └── .env.production.example
```

---

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

Reference architecture inspired by Okta's
[SCIM with Entitlements developer guide](https://developer.okta.com/docs/guides/scim-with-entitlements/main/)
and the
[BYO entitlements support article](https://support.okta.com/help/s/article/managing-custom-entitlements-or-bring-your-own-byo-entitlements-using-okta-identity-governance-oig-entitlement-management).
