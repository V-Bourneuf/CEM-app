/**
 * Admin UI router — entitlement catalog + integrations + users.
 *
 * Auth: SAML-only via getAdminVerdict() (admin/auth.js).
 * Three paths to admin (any one suffices):
 *   1. Bootstrap allowlist — email matches a value in ADMIN_EMAILS env
 *   2. SAML assertion-based — user holds a grants_admin entitlement carried
 *      in the SAML attributes (Path A: BYO entitlements)
 *   3. SCIM grant-based — user is provisioned in our DB and holds a
 *      grants_admin entitlement (Path B: Governance with SCIM)
 * No HTTP basic-auth fallback — there is exactly one way to be an admin: SAML.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const db = require('../db');
const { Entitlements, Users, Grants, Profiles } = db;
const { getAdminVerdict } = require('./auth');
const { loadProfile, saveProfile, KNOWN_FLOWS } = require('../profileManager');

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

router.use((req, res, next) => {
    const verdict = getAdminVerdict(req);
    if (verdict.ok) {
        req.adminVerdict = verdict;
        return next();
    }
    if (verdict.reason === 'unauthenticated') {
        return deniedPage(res, 401,
            'Sign in required',
            'Admin pages are gated by Okta. Please sign in via either flow first, then return to <code>/admin</code>.',
            '/', 'Back to landing');
    }
    return deniedPage(res, 403,
        'Access denied',
        `Your account <code>${escapeHtml(verdict.email || '(unknown)')}</code> isn't on the CEM App admin allowlist, ` +
        `doesn't carry an admin-granting SAML attribute (e.g. <code>App Admin</code> in the <code>role</code> array), ` +
        `and hasn't been granted an admin entitlement via SCIM.`,
        '/', 'Back to landing');
});

// Render helper that uses admin/views and skips the shared layout
function renderAdmin(res, view, locals = {}) {
    res.render(path.join(__dirname, 'views', view), { ...locals, layout: false });
}

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
    renderAdmin(res, 'users.ejs', { page: 'users', users });
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
    renderAdmin(res, 'integration-edit.ejs', {
        page: 'integrations',
        flow: req.params.flow,
        profile: loadProfile(req.params.flow),
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
