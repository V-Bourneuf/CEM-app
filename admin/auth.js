/**
 * Admin authorization decision — pure function over the SAML session.
 *
 * Three paths to admin (any one suffices):
 *
 *   1. Bootstrap allowlist — email matches a value in the ADMIN_EMAILS env
 *      var (or the active SAML profile's adminEmails field, which is loaded
 *      into ADMIN_EMAILS at startup). Doesn't require a DB record. Intended
 *      for the operator's first/initial admin and emergency access.
 *
 *   2. SAML assertion-based — the SAML attributes the IdP sent on this
 *      session contain a `role` or `access` value matching an entitlement
 *      in the local catalog flagged grants_admin = 1. Used by Path A
 *      (BYO entitlements via SAML attribute statements) — the user isn't
 *      provisioned via SCIM, so we can't look at their DB row, but the
 *      assertion itself tells us they hold the admin-granting entitlement.
 *
 *   3. SCIM grant-based — the user is provisioned in our DB and holds at
 *      least one entitlement flagged grants_admin = 1. Used by Path B
 *      (Governance with SCIM 2.0) — Okta IGA pushes the App Admin grant
 *      via SCIM PATCH and the user becomes admin without operator action.
 *
 * This module returns a verdict object so callers can render different UI
 * (e.g., the public dashboard shows an "Admin →" chip when the verdict is
 * positive; the admin gate redirects to the denied page otherwise).
 */

const { Users, Grants, Entitlements } = require('../db');

function bootstrapAllowlist() {
    return (process.env.ADMIN_EMAILS || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function adminGrantingValues() {
    return new Set(
        Entitlements.list()
            .filter(e => e.grants_admin === 1 || e.grants_admin === true)
            .map(e => e.value)
    );
}

function samlAttributeValues(req) {
    const attrs = (req.user && req.user.attributes) || {};
    const collect = key => Array.isArray(attrs[key])
        ? attrs[key]
        : (attrs[key] != null ? [attrs[key]] : []);
    return [...collect('role'), ...collect('access')].map(String);
}

function getAdminVerdict(req) {
    // 0. Breakglass session — local username + password (no SAML required).
    //    Bypasses all the SAML-based paths below; always-on safety net.
    if (req.session && req.session.breakglass && req.session.breakglass.username) {
        return { ok: true, via: 'breakglass', email: req.session.breakglass.username };
    }

    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return { ok: false, reason: 'unauthenticated' };
    }
    const email = String((req.user && (req.user.nameID || req.user.email)) || '').toLowerCase();

    // 1. Bootstrap allowlist
    if (bootstrapAllowlist().includes(email)) {
        return { ok: true, via: 'bootstrap', email };
    }

    // 2. SAML assertion-based
    const samlValues = samlAttributeValues(req);
    if (samlValues.length > 0) {
        const adminValues = adminGrantingValues();
        if (samlValues.some(v => adminValues.has(v))) {
            return { ok: true, via: 'saml-assertion', email };
        }
    }

    // 3. SCIM grant-based
    const dbUser = Users.findByUserName(email) || (email && Users.findByEmail(email));
    if (dbUser && Grants.hasAdminGrant(dbUser.id)) {
        return { ok: true, via: 'entitlement', email, dbUserId: dbUser.id };
    }

    return { ok: false, reason: 'not-admin', email };
}

module.exports = { getAdminVerdict, bootstrapAllowlist };
