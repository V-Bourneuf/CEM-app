# CEM App

A reference application that demonstrates two distinct ways to integrate a custom
SaaS app with **Okta Identity Governance — Customer Entitlement Management (CEM)**.

It's a single Node.js / Express server running:

| Path | What it serves |
|------|----------------|
| `/`           | Public app — SAML SSO login + a dashboard that shows the live SAML assertion plus the user's role/access grants |
| `/scim/v2/*`  | SCIM 2.0 server — Users, Groups (stub), Roles, Entitlements, Schemas, ServiceProviderConfig, ResourceTypes |
| `/admin/*`    | Admin UI — entitlement catalog management, profile bundles, provisioned-user view (SAML-gated) |

The app is built around a Salteau-flavoured demo (kitefoil designer & retailer);
its entitlement catalog is organized into "profiles" — Retail, Engineering & Manufacturing,
R&D / Design, Software & DevOps, and an Administration profile that grants admin
access in-app.

---

## Architecture

```
                     ┌──────────────────────────────────────────────────┐
                     │                  Okta Tenant                      │
                     │  • SAML IdP    • SCIM provisioning   • IGA / CEM │
                     └────────┬───────────────────────────┬─────────────┘
                              │  SAML AuthnRequest          │  SCIM PATCH
                              │  (POST AssertionConsumer)   │  (Users + grants)
                              ▼                             ▼
                ┌──────────────────────────────────────────────────┐
                │                  CEM App (this repo)              │
                │ ┌────────────┐  ┌────────────┐  ┌──────────────┐ │
                │ │ Public app │  │ SCIM 2.0   │  │ Admin UI     │ │
                │ │ login →    │  │ /scim/v2/* │  │ /admin/*     │ │
                │ │ dashboard  │  │            │  │ (SAML-gated) │ │
                │ └─────┬──────┘  └─────┬──────┘  └──────┬───────┘ │
                │       └─────┬─────────┴─────────┬──────┘         │
                │             ▼                   ▼                 │
                │        ┌──────────────────────────────┐           │
                │        │  SQLite (better-sqlite3)     │           │
                │        │  entitlements + users +      │           │
                │        │  user_entitlements (grants)  │           │
                │        └──────────────────────────────┘           │
                └──────────────────────────────────────────────────┘
```

The **catalog of roles + access entitlements lives in the app's database**
(seeded from `db/profiles.js`, manageable via `/admin`). Both Okta integration
paths below treat this catalog as the source of truth — they differ only in
*how* Okta gets a copy of it and how user-grant assignments flow.

---

## Two Okta integration paths

This app supports **two completely different Okta CEM integration models**.
You can use either or both, depending on what you want to demonstrate.

### Path A — BYO Entitlements via SAML attribute statements

Use this when:
- The Okta app is a **plain SAML 2.0** application
- You want the entitlement catalog to live in the app's database, and you mirror
  the values into Okta manually (per-app-profile-attribute enums) — Okta is *not*
  configured to discover the catalog over SCIM
- Grants flow purely through SAML attributes — no SCIM provisioning required

**On the Okta side:**

1. App Catalog → search a generic SAML 2.0 template (e.g. *SAML 2.0 Test App (Header Auth)*) → **Add Integration**
2. Configure standard SAML sign-on:
   - Single sign-on URL: `https://<your-domain>/login/callback`
   - Audience URI: `https://<your-domain>/cemapp`
   - Name ID format: `EmailAddress`
   - Application username: `Email`
3. **General → Edit Identity Governance → Governance Engine: Enabled** (requires Okta IGA license)
4. **Directory → Profile Editor →** the app's user profile → add two custom attributes:
   - `access` — type **string array**
   - `role`   — type **string array**

   Then mirror the **values** from the app's catalog into each attribute's enum
   list. The exact values are whatever's currently in your app's catalog
   (visible in `/admin/profiles`); for the seeded Salteau demo profiles they
   include: `deploy_code_to_prod`, `process_pos_sale`, `approve_production_run`,
   `edit_cad_designs`, etc. for `access`; and `Software Dev`, `Store Associate`,
   `Production Engineer`, etc. for `role`.

5. **Sign On → SAML Attribute Statements** — add the **two attribute statements
   this app expects** (it reads `req.user.attributes.access` and
   `req.user.attributes.role` on each login):

   | Name      | Name format | Value (Expression)                  |
   |-----------|-------------|--------------------------------------|
   | `access`  | `Basic`     | `appuser.entitlements.access`        |
   | `role`    | `Basic`     | `appuser.entitlements.role`          |

   These expressions bind the per-user app-profile values into the outbound
   SAML assertion. Without them, the app sees the user but no grants.
6. **Assignments → Assign to People** — for each user, fill in their `access` / `role` arrays with the values they should have.
7. (Optional, IGA-side) **Identity Governance → Entitlements → Bundles** — group attribute values into bundles, attach to access policies / requests.

**On the app side:** nothing special. The SAML callback (`server.js`) reads
`req.user.attributes.access` and `req.user.attributes.role` directly when the
user has *not* been SCIM-provisioned. The dashboard shows the assertion verbatim
and highlights the granted entries against the local catalog.

**Trade-offs:**
- ✅ Simplest possible Okta setup — no SCIM token, no provisioning, no public ingress required by Okta.
- ✅ Catalog values live in the app; Okta just consumes assertions. App can run anywhere reachable by the *user's* browser.
- ❌ The mirror in Okta has to be **maintained by hand** — every time the catalog changes in the app, you update the app-profile attribute enums in Okta to match.
- ❌ **Grants only propagate at SAML login** — there's no live channel from Okta to the app between logins. If you change a user's grants in Okta, they take effect on the user's next sign-in.

### Path B — Governance with SCIM 2.0 *(Header Auth template)*

Use this when:
- You want **automated catalog discovery** — Okta pulls roles + entitlements from your `/Roles` and `/Entitlements` endpoints (no manual mirroring)
- You want **bidirectional provisioning** — Okta SCIM-PATCHes user grants to the app, app reads grants from its own DB at login time
- You want full IGA features (bundles, access policies, certifications) backed by SCIM

> ⚠️ **The app must be reachable from Okta's egress IPs.** Okta's SCIM client
> calls your `/scim/v2/*` endpoints directly to discover the catalog and push
> grants. For an EC2 deployment this means port 443 open to 0.0.0.0/0
> (HTTPS, fronted by Let's Encrypt — see `deploy/README.md`). For local
> development you'll need a public tunnel like `ngrok`, `cloudflared`, or
> Tailscale Funnel — Okta cannot reach `http://localhost:1337`.

**On the Okta side:**

1. App Catalog → search **"Governance"** → pick **(Header Auth) Governance with SCIM 2.0** → **Add Integration**
   *(this is the template you need — it stamps the AppInstance with `IMPORT_USER_SCHEMA`,
   which is required for entitlement sync. Generic SCIM 2.0 Test App templates do **not** have this flag.)*
2. **General → Edit Identity Governance → Governance Engine: Enabled** → **Save → refresh**
3. **Sign On (SAML)** — fill in the override fields:
   - SSO ACS URL Override: `https://<your-domain>/login/callback`
   - Audience URI Override: `https://<your-domain>/cemapp`
   - Recipient URL Override: `https://<your-domain>/login/callback`
   - Destination URL Override: `https://<your-domain>/login/callback`
   - SAML Attribute Statements: `firstName`, `lastName`, `email` (basic identity only — grants flow over SCIM, not SAML)
4. **Provisioning → Configure API Integration → Enable API integration**:
   - SCIM 2.0 Base URL: `https://<your-domain>/scim/v2`
   - Authentication: **HTTP Header**
   - Token: paste your `SCIM_TOKEN` value (raw — Okta does **not** prepend `Bearer `; this app's `scim/auth.js` accepts both forms)
   - Unique identifier field for users: `userName`
   - **Import Groups: unchecked** (this app uses entitlements/roles, not groups)
   - **Test API Credentials** → must succeed → **Save**
5. **To App** subtab → **Edit** → enable: Create Users, Update User Attributes, Deactivate Users → **Save**
6. **Provisioning → Integration → Import Resources** → Okta probes `/Roles` and `/Entitlements`,
   populates the IGA catalog, and discovers the User schema from `/Schemas`.
7. **Identity Governance → Entitlement Bundles** — group entitlements into bundles (e.g. *Workshop Foreman Bundle* = `role: Workshop Foreman` + `access: approve_production_run` + `access: halt_production_line`), attach to access policies / access requests.
8. **Assignments → Assign people** — assign bundles or individual entitlements; Okta SCIM-PATCHes the user to the app.

**On the app side:** The SAML callback prefers DB grants over SAML attributes when
the user is SCIM-provisioned. Dashboard shows the same SAML assertion *plus* the
DB-resolved grants, with a footer indicating provenance.

**Trade-offs:**
- ✅ Catalog is **discoverable by Okta** — no manual mirroring; enable a profile in `/admin/profiles` and Okta picks it up on the next Import.
- ✅ Full IGA workflows (bundles, access requests, certifications, separation of duties).
- ✅ Bidirectional: Okta pushes grants in real time over SCIM; app stores them in its DB.
- ❌ More moving parts (SCIM token rotation, schema sync, app template choice).
- ❌ Requires the app to be publicly reachable by Okta (see callout above).

---

## Quick start (local dev)

```bash
git clone https://github.com/V-Bourneuf/CEM-app.git
cd CEM-app
npm install

# Start the server — it'll prompt to create a SAML profile on first run
npm start
```

The first run drops you into an interactive **profile manager** that asks for:
- Okta App Embed Link (the Okta SSO URL from your Sign-On tab)
- SP Issuer / Audience URI (`http://localhost:1337/cemapp` is fine for local)
- Path to the signing certificate (download from Okta Sign-On tab → SAML Setup Instructions)
- (Optional) SCIM bearer token — generate with `openssl rand -hex 32`
- (Optional) Admin auth: comma-separated emails for SAML admin allowlist *or* basic-auth user/pass

Profiles are saved under `./profiles/<name>/` (gitignored). To skip the
prompt on subsequent runs:

```bash
node server.js --profile <name>
```

The app listens on **port 1337** by default; override with `PORT=…`.

> For Path B (SCIM-based) testing locally, expose the server with a tunnel
> (`ngrok http 1337` or `cloudflared tunnel --url http://localhost:1337`)
> and use the public URL as your SCIM Base URL in Okta. Path A (SAML-only)
> doesn't need a tunnel — Okta only ever talks to the user's browser.

---

## Production deployment

A complete deploy guide for AWS EC2 (Amazon Linux 2023 or Ubuntu) lives at
**[`deploy/README.md`](deploy/README.md)**. The flow:

```
laptop  →  rsync  →  /tmp/cemapp/  →  setup-ec2.sh
                                       ├── installs Node 20 + nginx + certbot
                                       ├── creates `cemapp` system user
                                       ├── installs systemd unit
                                       └── provisions Let's Encrypt
                                       
laptop  →  paste SAML profile config + cert  →  /opt/cemapp/profiles/production/
                                       ↓
                                   sudo systemctl start cemapp
```

Production runs at `https://<your-domain>/`, fronted by nginx with TLS.

---

## Security & access model

### SAML
- IdP-initiated and SP-initiated flows both supported
- New SAML callbacks logged to `saml-debug.log` (gitignored) for tenant troubleshooting
- Helmet middleware sets standard security headers
- Sessions are cookie-based (no Redis dependency for the demo)

### SCIM
- Bearer auth on every `/scim/v2/*` endpoint (`scim/auth.js`)
- Accepts both `Authorization: Bearer <token>` and raw `Authorization: <token>`
  (Okta's catalog Governance-with-SCIM template sends the latter)
- Token sourced from the active SAML profile's config or `SCIM_TOKEN` env var

### `/admin` UI access
Two paths, evaluated per request (`admin/router.js`):

1. **Bootstrap allowlist** — emails listed in the profile's `adminEmails`
   (or `ADMIN_EMAILS` env var). Doesn't require a DB record. Intended as
   initial / emergency access.
2. **Entitlement-based** — the SAML-authenticated user is provisioned in the
   app's DB **and** holds at least one entitlement flagged `grants_admin = 1`.
   The canonical, delegable path: assign the **App Admin** role (in the
   *Administration* profile) to a user via Okta IGA → Okta SCIM-PATCHes the
   grant to the app → user becomes admin.

The legacy `ADMIN_USER` / `ADMIN_PASS` HTTP basic auth is kept as a fallback
when neither of the above is configured.

---

## Entitlement profiles

The catalog is organized into profiles, each tailored to a Salteau business unit:

| Profile                        | Theme                                                            | Roles | Access |
|--------------------------------|------------------------------------------------------------------|-------|--------|
| **Administration**             | App Admin role + manage_cem_app — both `grants_admin = true`     | 1     | 1      |
| **Retail & E-commerce**        | Store associates, e-commerce, customer service, returns          | 4     | 8      |
| **Engineering & Manufacturing** | Production engineers, QA, workshop, composite specialists        | 4     | 8      |
| **R&D / Design**               | Hydrofoil designers, naval architects, **test pilots**, materials | 4     | 8      |
| **Software & DevOps**          | Internal platform engineering (legacy seed)                      | 4     | 11     |

Admins toggle profiles in `/admin/profiles`. **Only entitlements from
*enabled* profiles are returned by `/scim/v2/Roles` and `/scim/v2/Entitlements`** —
i.e. only enabled-profile entitlements are discoverable by Okta during
import. Disabling a profile cascades any existing user grants on those
entitlements.

You can also add **custom entitlements** inside any enabled profile via the
admin UI's inline form (the new entitlement gets stamped with that profile's
id, so it'll be swept too if the profile is later disabled).

---

## Repository layout

```
.
├── server.js               # Express app, SAML callback, profile loader
├── profileManager.js       # Interactive CLI for SAML profile create/select
├── db/
│   ├── schema.sql          # SQLite DDL
│   ├── index.js            # Connection, idempotent migrations, Entitlements/Users/Grants/Profiles APIs
│   └── profiles.js         # Static profile templates (Salteau bundles)
├── scim/
│   ├── router.js           # SCIM 2.0 mount: /Users /Groups /Roles /Entitlements /<discovery>
│   ├── auth.js             # Bearer-token middleware, SCIM error helper
│   ├── users.js            # Full /Users CRUD, PATCH ops mapping role+entitlement arrays
│   ├── groups.js           # /Groups stub (empty list — Okta probes this during sync)
│   ├── roles.js            # /Roles (type='role' subset of catalog)
│   ├── entitlements.js     # /Entitlements (type='access' subset of catalog)
│   └── schemas.js          # /ServiceProviderConfig /ResourceTypes /Schemas
├── admin/
│   ├── router.js           # Admin auth gate + catalog/profile/user routes
│   └── views/              # EJS templates for admin UI
├── public/
│   ├── views/              # Public app templates: login, dashboard
│   ├── css/                # styles.css (public), admin.css (admin)
│   └── js/                 # init.js (legacy, dashboard now renders server-side)
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
