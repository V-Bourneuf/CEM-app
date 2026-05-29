/**
 * Admin authorization decision — pure function over the SAML session.
 *
 * Four ways to be admin (any one suffices):
 *
 *   0. Breakglass — local username + password (bypasses SAML entirely).
 *   1. Bootstrap allowlist — email matches a value in the ADMIN_EMAILS env
 *      var (or the active SAML profiles' adminEmails fields, unioned at
 *      startup). Doesn't require a DB record. For first/initial admin and
 *      emergency access.
 *   2. SAML assertion-based — the SAML attributes the IdP sent on this
 *      session contain a `role` or `access` value matching an entitlement
 *      in the local catalog flagged grants_admin = 1. The BYO flow uses
 *      this when a user is signed in but hasn't been SCIM-provisioned yet.
 *   3. SCIM grant-based — the user is provisioned in the DB (in the same
 *      flow they signed in through) and holds at least one entitlement
 *      flagged grants_admin = 1. Used by both flows when SCIM provisioning
 *      is active.
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

    // 3. SCIM grant-based — scope the lookup to the flow this session
    //    authenticated through. A user provisioned by the BYO Okta app cannot
    //    elevate via the SCIM Okta app's entitlement catalog (or vice versa).
    const flow = req.session && req.session.authFlow;
    if (flow && email) {
        const dbUser = Users.findByUserName(email, flow) || Users.findByEmail(email, flow);
        if (dbUser && Grants.hasAdminGrant(dbUser.id)) {
            return { ok: true, via: 'entitlement', email, dbUserId: dbUser.id, flow };
        }
    }

    return { ok: false, reason: 'not-admin', email };
}

module.exports = { getAdminVerdict, bootstrapAllowlist };
