/**
 * Admin UI router — CRUD over the entitlement catalog and a read-only
 * view of provisioned users + their grants.
 *
 * Auth is decided at request time:
 *   1. If process.env.ADMIN_EMAILS is set (comma-separated), gate by Okta SAML
 *      session + email allowlist. The user must have logged in via the main
 *      `/auth/saml` flow first; their nameID must match one of the allowlisted
 *      emails (case-insensitive).
 *   2. Otherwise, fall back to HTTP Basic auth using ADMIN_USER + ADMIN_PASS.
 *   3. If neither is configured, the entire /admin namespace returns 503.
 *
 * The SAML path keeps everything in one identity provider and lets you give
 * specific users admin without a separate password. Basic auth remains for
 * environments where SAML hasn't been wired up yet.
 */

const express = require('express');
const path    = require('path');
const basicAuth = require('express-basic-auth');
const db = require('../db');
const { Entitlements, Users, Grants, Profiles } = db;

const router = express.Router();

router.use((req, res, next) => {
    res.locals.basePath = '/admin';
    next();
});

router.use(express.urlencoded({ extended: false }));
router.use(express.json());

// ---------- auth ----------

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function deniedPage(res, status, headline, body, ctaHref, ctaText) {
    res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(headline)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/styles.css">
</head><body>
<div class="message-shell"><div class="message-card">
<h1>${escapeHtml(headline)}</h1>
<p>${body}</p>
<a class="btn-okta" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaText)}</a>
</div></div></body></html>`);
}

// Admin authorization is granted via two paths:
//   1. Bootstrap allowlist — emails listed in ADMIN_EMAILS env var (intended for the
//      first/initial admin and emergency access; doesn't require a DB record).
//   2. Entitlement-based — the SAML-authenticated user is provisioned in our DB
//      and holds at least one entitlement flagged grants_admin = 1 (the canonical,
//      delegable path; assign someone the App Admin role in Okta IGA and they
//      become an admin in the CEM App after SCIM provisioning).
function isAdminRequest(req) {
    if (!req.isAuthenticated || !req.isAuthenticated()) return { ok: false, reason: 'unauthenticated' };
    const email = String(req.user.nameID || req.user.email || '').toLowerCase();

    const allowlist = (process.env.ADMIN_EMAILS || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allowlist.includes(email)) return { ok: true, via: 'bootstrap', email };

    const dbUser = Users.findByUserName(email) || (email && Users.findByEmail(email));
    if (dbUser && Grants.hasAdminGrant(dbUser.id)) {
        return { ok: true, via: 'entitlement', email, dbUserId: dbUser.id };
    }

    return { ok: false, reason: 'not-admin', email };
}

function adminGate(basicAuthInstance) {
    return (req, res, next) => {
        const samlConfigured = (process.env.ADMIN_EMAILS || '').trim().length > 0
                            || db && true;   // SAML mode whenever the gate has any allowlist or DB

        if (samlConfigured) {
            const verdict = isAdminRequest(req);
            if (verdict.ok) {
                req.adminVerdict = verdict;
                return next();
            }
            if (verdict.reason === 'unauthenticated') {
                return deniedPage(res, 401,
                    'Sign in required',
                    'Admin pages are gated by Okta. Please sign in first, then return to <code>/admin</code>.',
                    '/', 'Sign in with Okta');
            }
            return deniedPage(res, 403,
                'Access denied',
                `Your account <code>${escapeHtml(verdict.email || '(unknown)')}</code> isn't on the CEM App admin allowlist ` +
                `and hasn't been granted an admin entitlement (e.g. the <code>App Admin</code> role).`,
                '/', 'Back to home');
        }

        // Legacy HTTP-basic fallback (kept for backwards-compat; only fires if neither
        // ADMIN_EMAILS nor any admin-granting entitlement exists in the system)
        if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
            return res.status(503).type('text/plain').send(
                'Admin UI disabled. Configure one of:\n' +
                '  ADMIN_EMAILS=user1@example.com   (bootstrap)\n' +
                '  enable the Administration profile and grant App Admin to a user\n' +
                '  ADMIN_USER=admin  ADMIN_PASS=secret  (HTTP basic auth)\n'
            );
        }
        return basicAuthInstance(req, res, next);
    };
}

const basicAuthInstance = basicAuth({
    authorizer: (user, pass) => {
        const u = process.env.ADMIN_USER;
        const p = process.env.ADMIN_PASS;
        if (!u || !p) return false;
        return basicAuth.safeCompare(user, u) & basicAuth.safeCompare(pass, p);
    },
    challenge: true,
    realm:     'CEM App Admin',
    unauthorizedResponse: 'Authentication required',
});

router.use(adminGate(basicAuthInstance));

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
    renderAdmin(res, 'dashboard.ejs', {
        page: 'dashboard',
        counts: {
            roles:   entitlementsByType.role,
            access:  entitlementsByType.access,
            users:   allUsers.length,
            active:  allUsers.filter(u => u.active).length,
            grants:  totalGrants,
        },
        adminUser: req.user ? (req.user.nameID || '') : null,
    });
});

// ---------- entitlements (now nested under /admin/profiles) ----------

// Old listing → unified profiles page
router.get('/entitlements', (req, res) => res.redirect('/admin/profiles'));

router.get('/entitlements/:id/edit', (req, res) => {
    const editing = Entitlements.findById(req.params.id);
    if (!editing) return res.redirect('/admin/profiles?error=' + encodeURIComponent('Entitlement not found'));
    renderAdmin(res, 'entitlements.ejs', {
        page: 'entitlements',
        editing,
        flash: null,
        error: null,
    });
});

router.post('/entitlements/:id', (req, res) => {
    const { type, displayName, value, columnHint, description, grantsAdmin } = req.body;
    try {
        const updated = Entitlements.update(req.params.id, {
            type, displayName, value, columnHint, description,
            grantsAdmin: grantsAdmin === 'on' || grantsAdmin === '1' || grantsAdmin === 'true',
        });
        if (!updated) return res.redirect('/admin/profiles?error=' + encodeURIComponent('Not found'));
        res.redirect('/admin/profiles?flash=' + encodeURIComponent('Saved: ' + displayName));
    } catch (e) {
        res.redirect('/admin/profiles?error=' + encodeURIComponent(e.message));
    }
});

router.post('/entitlements/:id/delete', (req, res) => {
    const e = Entitlements.findById(req.params.id);
    if (!e) return res.redirect('/admin/profiles?error=' + encodeURIComponent('Not found'));
    Entitlements.delete(req.params.id);
    res.redirect('/admin/profiles?flash=' + encodeURIComponent('Deleted: ' + e.display_name));
});

// ---------- users ----------

router.get('/users', (req, res) => {
    const users = Users.listAll().map(u => ({
        ...u,
        grants: Grants.listForUser(u.id),
    }));
    renderAdmin(res, 'users.ejs', { page: 'users', users });
});

// ---------- profiles ----------

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

module.exports = router;
