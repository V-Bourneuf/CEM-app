/**
 * Admin UI router — entitlement catalog + integrations + users.
 *
 * Auth: SAML-only via getAdminVerdict() (admin/auth.js), with a local
 * breakglass account as a tertiary option.
 * Three SAML-based admin paths (any one suffices, plus breakglass):
 *   1. Bootstrap allowlist — email matches a value in ADMIN_EMAILS env
 *   2. SAML assertion-based — user holds a grants_admin entitlement carried
 *      in the SAML attributes (BYO flow, when not yet SCIM-provisioned)
 *   3. SCIM grant-based — user is provisioned in our DB (in the same flow
 *      they signed in through) and holds a grants_admin entitlement
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const db = require('../db');
const { Entitlements, Users, Grants, Profiles } = db;
const { getAdminVerdict } = require('./auth');
const {
    loadProfile, saveProfile, KNOWN_FLOWS,
    loadBreakglass, verifyBreakglassPassword,
} = require('../profileManager');

const router = express.Router();

router.use((req, res, next) => {
    res.locals.basePath = '/admin';
    next();
});

router.use(express.urlencoded({ extended: false, limit: '256kb' }));
router.use(express.json({ limit: '256kb' }));

// ---------- auth ----------

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function deniedPage(res, status, headline, body, ctaHref, ctaText) {
    res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(headline)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/styles.css">
</head><body>
<div class="message-shell"><div class="message-card">
<h1>${escapeHtml(headline)}</h1>
<p>${body}</p>
<a class="btn-okta" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaText)}</a>
</div></div></body></html>`);
}

// Render helper that uses admin/views and skips the shared layout
function renderAdmin(res, view, locals = {}) {
    res.render(path.join(__dirname, 'views', view), { ...locals, layout: false });
}

// ---------- public sub-routes (BEFORE the admin gate) ----------

// Login page — combined Okta CTA + breakglass form.
router.get('/login', (req, res) => {
    if (getAdminVerdict(req).ok) return res.redirect('/admin/dashboard');
    renderAdmin(res, 'admin-login.ejs', {
        page:        'login',
        host:        req.headers.host || 'localhost',
        breakglass:  !!loadBreakglass(),
        flows:       KNOWN_FLOWS.map(k => ({ key: k, configured: !!loadProfile(k) })),
        flash:       req.query.flash || null,
        error:       req.query.error || null,
    });
});

// Breakglass POST — verify local creds, set session flag.
router.post('/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const ok = await verifyBreakglassPassword(username, password);
    if (!ok) {
        return res.redirect('/admin/login?error=' +
            encodeURIComponent('Invalid breakglass credentials, or breakglass not configured on this server.'));
    }
    req.session.breakglass = { username: username.toLowerCase(), since: Date.now() };
    res.redirect('/admin/dashboard');
});

// Sign out of /admin — clears the breakglass flag (does NOT clear the SAML
// passport session; the public /logout route does that for both).
router.post('/logout', (req, res) => {
    if (req.session) delete req.session.breakglass;
    res.redirect('/admin/login?flash=' + encodeURIComponent('Signed out of /admin.'));
});

// First configured SAML flow, used to auto-trigger SP-initiated login when an
// unauthenticated request hits /admin or /admin/<anything>. /admin/login is still
// reachable by direct navigation for breakglass and explicit flow choice.
function pickAuthFlow() {
    for (const k of KNOWN_FLOWS) {
        if (loadProfile(k)) return k;
    }
    return null;
}

// ---------- admin gate (everything below requires admin) ----------

router.use((req, res, next) => {
    const verdict = getAdminVerdict(req);
    if (verdict.ok) {
        req.adminVerdict = verdict;
        return next();
    }
    if (verdict.reason === 'unauthenticated') {
        // Auto-trigger the first configured flow's SAML SSO. Stash the original
        // URL so the flow callback returns the user here after auth instead of
        // dumping them on /<flow>/dashboard.
        const flow = pickAuthFlow();
        if (flow) {
            req.session.postLoginRedirect = req.originalUrl;
            return res.redirect(`/${flow}/auth/saml`);
        }
        // No flow configured at all — fall back to the manual login page (breakglass).
        return res.redirect('/admin/login');
    }
    return deniedPage(res, 403,
        'Access denied',
        `Your account <code>${escapeHtml(verdict.email || '(unknown)')}</code> isn't on the CEM App admin allowlist, ` +
        `doesn't carry an admin-granting SAML attribute (e.g. <code>App Admin</code> in the <code>role</code> array), ` +
        `and hasn't been granted an admin entitlement via SCIM. ` +
        `If Okta is unreachable, sign out and use the breakglass account at <code>/admin/login</code>.`,
        '/', 'Back to landing');
});

// ---------- routes ----------

router.get('/', (req, res) => res.redirect('/admin/dashboard'));

router.get('/dashboard', (req, res) => {
    const entitlementsByType = {
        role:   Entitlements.list({ type: 'role' }).length,
        access: Entitlements.list({ type: 'access' }).length,
    };
    const allUsers   = Users.listAll();
    const totalGrants = allUsers.reduce((acc, u) => acc + Grants.listForUser(u.id).length, 0);
    const integrations = KNOWN_FLOWS.map(k => ({ key: k, configured: !!loadProfile(k) }));

    renderAdmin(res, 'dashboard.ejs', {
        page: 'dashboard',
        counts: {
            roles:   entitlementsByType.role,
            access:  entitlementsByType.access,
            users:   allUsers.length,
            active:  allUsers.filter(u => u.active).length,
            grants:  totalGrants,
        },
        integrations,
        adminUser: req.user ? (req.user.nameID || '') : null,
    });
});

// ---------- entitlements: flat catalog list + edit form (does not gate on profile activation) ----------

router.get('/entitlements', (req, res) => {
    const all = Entitlements.list();
    renderAdmin(res, 'entitlement-list.ejs', {
        page:           'entitlements',
        entitlements:   all,
        flash:          req.query.flash || null,
        error:          req.query.error || null,
    });
});

router.get('/entitlements/:id/edit', (req, res) => {
    const editing = Entitlements.findById(req.params.id);
    if (!editing) return res.redirect('/admin/entitlements?error=' + encodeURIComponent('Entitlement not found'));

    // All defined profile keys (from db/profiles.js) — including currently-disabled ones,
    // because re-assigning an entitlement should not require its destination profile to be
    // enabled first.
    const profileKeys = Profiles.list().map(p => ({ id: p.id, name: p.name, active: p.active }));
    const columnHints = Entitlements.distinctColumnHints();

    renderAdmin(res, 'entitlements.ejs', {
        page:         'entitlements',
        editing,
        profileKeys,
        columnHints,
        returnTo:     req.query.from === 'profiles' ? '/admin/profiles' : '/admin/entitlements',
        flash:        null,
        error:        req.query.error || null,
    });
});

router.post('/entitlements/:id', (req, res) => {
    const { type, displayName, value, columnHint, description, profile, grantsAdmin } = req.body;
    const returnTo = req.body.returnTo === '/admin/profiles' ? '/admin/profiles' : '/admin/entitlements';
    try {
        const updated = Entitlements.update(req.params.id, {
            type,
            displayName,
            value,
            columnHint,
            description,
            profile: profile && profile.length > 0 ? profile : null,
            grantsAdmin: grantsAdmin === 'on' || grantsAdmin === '1' || grantsAdmin === 'true',
        });
        if (!updated) return res.redirect(`${returnTo}?error=` + encodeURIComponent('Not found'));
        res.redirect(`${returnTo}?flash=` + encodeURIComponent('Saved: ' + displayName));
    } catch (e) {
        res.redirect(`${returnTo}?error=` + encodeURIComponent(e.message));
    }
});

router.post('/entitlements/:id/delete', (req, res) => {
    const e = Entitlements.findById(req.params.id);
    const returnTo = req.body.returnTo === '/admin/profiles' ? '/admin/profiles' : '/admin/entitlements';
    if (!e) return res.redirect(`${returnTo}?error=` + encodeURIComponent('Not found'));
    Entitlements.delete(req.params.id);
    res.redirect(`${returnTo}?flash=` + encodeURIComponent('Deleted: ' + e.display_name));
});

// ---------- users ----------

router.get('/users', (req, res) => {
    const users = Users.listAll().map(u => ({
        ...u,
        grants: Grants.listForUser(u.id),
    }));
    renderAdmin(res, 'users.ejs', {
        page:  'users',
        users,
        flows: KNOWN_FLOWS,
        flash: req.query.flash || null,
        error: req.query.error || null,
    });
});

// Local delete only. Okta still has the user assigned and may re-create
// them on the next SCIM sync — to remove fully, also unassign in Okta admin.
// FK on user_entitlements has ON DELETE CASCADE, so grants get cleaned up.
router.post('/users/:id/delete', (req, res) => {
    const u = Users.findById(req.params.id);
    if (!u) {
        return res.redirect('/admin/users?error=' + encodeURIComponent('User not found'));
    }
    Users.delete(req.params.id);
    res.redirect('/admin/users?flash=' +
        encodeURIComponent(`Deleted ${u.user_name} (${u.flow}). Okta may re-provision on the next sync.`));
});

// ---------- catalog profiles ----------

router.get('/profiles', (req, res) => {
    renderAdmin(res, 'profiles.ejs', {
        page:     'profiles',
        profiles: Profiles.list(),
        flash:    req.query.flash || null,
        error:    req.query.error || null,
    });
});

router.post('/profiles/:id/enable', (req, res) => {
    try {
        Profiles.enable(req.params.id);
        const p = Profiles.findById(req.params.id);
        res.redirect('/admin/profiles?flash=' + encodeURIComponent(`Enabled "${p.name}" — entitlements added to catalog`));
    } catch (e) {
        res.redirect('/admin/profiles?error=' + encodeURIComponent(e.message));
    }
});

router.post('/profiles/:id/disable', (req, res) => {
    try {
        const removed = Profiles.disable(req.params.id);
        const p = Profiles.findById(req.params.id);
        res.redirect('/admin/profiles?flash=' + encodeURIComponent(`Disabled "${p.name}" — removed ${removed} entitlements (and any grants)`));
    } catch (e) {
        res.redirect('/admin/profiles?error=' + encodeURIComponent(e.message));
    }
});

// Add a custom entitlement directly inside a profile (only valid when the profile is enabled)
router.post('/profiles/:profileId/entitlements', (req, res) => {
    const { profileId } = req.params;
    const profile = Profiles.findById(profileId);
    if (!profile) return res.redirect('/admin/profiles?error=' + encodeURIComponent('Unknown profile: ' + profileId));

    const { id, type, displayName, value, columnHint, description, grantsAdmin } = req.body;
    if (!type || !displayName || !value) {
        return res.redirect('/admin/profiles?error=' + encodeURIComponent('type, displayName, value are required'));
    }
    try {
        Entitlements.create({
            id:          id?.trim() || undefined,
            type,
            displayName,
            value,
            columnHint:  columnHint || null,
            description: description || null,
            profile:     profileId,
            grantsAdmin: grantsAdmin === 'on' || grantsAdmin === '1' || grantsAdmin === 'true',
        });
        res.redirect('/admin/profiles?flash=' + encodeURIComponent(`Added "${displayName}" to ${profile.name}`));
    } catch (e) {
        res.redirect('/admin/profiles?error=' + encodeURIComponent(e.message));
    }
});

// ---------- integrations (BYO + SCIM SAML connections) ----------

function maskToken(token) {
    if (!token) return '';
    if (token.length <= 8) return '••••';
    return token.slice(0, 4) + '…' + token.slice(-4);
}

function summarizeProfile(name) {
    const p = loadProfile(name);
    if (!p) return { name, configured: false };
    return {
        name,
        configured:     true,
        entryPoint:     p.entryPoint,
        issuer:         p.issuer,
        skipAttributes: p.skipAttributes,
        scimToken:      p.scimToken,
        scimTokenMask:  maskToken(p.scimToken),
        adminEmails:    p.adminEmails,
        certPreview:    (p.cert || '').split('\n').slice(0, 2).join('\n') + '\n…',
    };
}

router.get('/integrations', (req, res) => {
    renderAdmin(res, 'integrations.ejs', {
        page:     'integrations',
        flows:    KNOWN_FLOWS.map(summarizeProfile),
        flash:    req.query.flash || null,
        error:    req.query.error || null,
    });
});

router.get('/integrations/:flow/edit', (req, res) => {
    if (!KNOWN_FLOWS.includes(req.params.flow)) {
        return res.redirect('/admin/integrations?error=' + encodeURIComponent('Unknown flow: ' + req.params.flow));
    }
    const flow = req.params.flow;
    const profile = loadProfile(flow);
    // Public URL — used to render the "paste into Okta" callback / audience / SCIM URLs.
    // Honors X-Forwarded-Proto from nginx so we get https:// in production.
    const publicUrl = (req.protocol || 'https') + '://' + (req.get('host') || 'localhost');

    // SAML targets differ per flow: BYO uses a plain SAML 2.0 app (sets the
    // SSO URL / Audience URI directly), while SCIM uses the (Header Auth)
    // Governance with SCIM 2.0 template (sets the override fields).
    const samlTargets = (flow === 'byo')
        ? {
              ssoUrl:        `${publicUrl}/byo/login/callback`,
              audienceUri:   `${publicUrl}/byo`,
              attrStatements: [
                  { name: 'firstName', format: 'Basic', value: 'user.firstName' },
                  { name: 'lastName',  format: 'Basic', value: 'user.lastName'  },
                  { name: 'email',     format: 'Basic', value: 'user.email'     },
                  { name: 'access',    format: 'Basic', value: 'appuser.access' },
                  { name: 'role',      format: 'Basic', value: 'appuser.role'   },
              ],
          }
        : {
              acsUrlOverride:        `${publicUrl}/scim/login/callback`,
              audienceUriOverride:   `${publicUrl}/scim`,
              recipientOverride:     `${publicUrl}/scim/login/callback`,
              destinationOverride:   `${publicUrl}/scim/login/callback`,
              attrStatements: [
                  { name: 'firstName', format: 'Basic', value: 'user.firstName' },
                  { name: 'lastName',  format: 'Basic', value: 'user.lastName'  },
                  { name: 'email',     format: 'Basic', value: 'user.email'     },
              ],
          };

    // Both flows now have their own SCIM endpoint (BYO can provision users in
    // addition to its SAML-attribute entitlements path). Each Okta app gets
    // its own SCIM Base URL and its own bearer token.
    const scimTargets = {
        scimBaseUrl: `${publicUrl}/${flow}/scim/v2`,
        scimToken:   profile ? (profile.scimToken || '') : '',
    };

    renderAdmin(res, 'integration-edit.ejs', {
        page: 'integrations',
        flow,
        profile,
        samlTargets,
        scimTargets,
        publicUrl,
        flash: null,
        error: req.query.error || null,
    });
});

router.post('/integrations/:flow', (req, res) => {
    const { flow } = req.params;
    if (!KNOWN_FLOWS.includes(flow)) {
        return res.redirect('/admin/integrations?error=' + encodeURIComponent('Unknown flow: ' + flow));
    }
    const { entryPoint, issuer, skipAttributes, scimToken, adminEmails, cert } = req.body;
    if (!entryPoint || !issuer || !cert) {
        return res.redirect(`/admin/integrations/${flow}/edit?error=` +
            encodeURIComponent('entryPoint, issuer, and cert are required'));
    }
    if (!cert.includes('-----BEGIN CERTIFICATE-----')) {
        return res.redirect(`/admin/integrations/${flow}/edit?error=` +
            encodeURIComponent('cert must be PEM-encoded (must include -----BEGIN CERTIFICATE-----)'));
    }
    try {
        saveProfile(flow, {
            entryPoint:     entryPoint.trim(),
            issuer:         issuer.trim(),
            skipAttributes: (skipAttributes || '').trim(),
            scimToken:      (scimToken || '').trim(),
            adminEmails:    (adminEmails || '').trim(),
            cert:           cert.trim() + '\n',
        });
        res.redirect('/admin/integrations?flash=' +
            encodeURIComponent(`Saved ${flow} integration. Restart the server to pick up the new SAML strategy.`));
    } catch (e) {
        res.redirect(`/admin/integrations/${flow}/edit?error=` + encodeURIComponent(e.message));
    }
});

module.exports = router;
