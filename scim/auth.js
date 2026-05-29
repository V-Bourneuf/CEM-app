/**
 * SCIM bearer-token middleware factory + SCIM-spec error helper.
 *
 * Each flow (byo, scim) mounts its own SCIM router with its own bearer token
 * — buildBearerAuth(getExpectedToken) closes over the per-flow token so each
 * Okta app authenticates against the right secret.
 */

function scimError(status, detail, scimType) {
    const body = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: String(status),
        detail,
    };
    if (scimType) body.scimType = scimType;
    return body;
}

// `getExpectedToken` may be a string or a () => string thunk. Using a thunk
// means callers can keep the token live across in-memory profile reloads
// without rebuilding the router.
function buildBearerAuth(getExpectedToken) {
    return function bearerAuth(req, res, next) {
        const expected = typeof getExpectedToken === 'function' ? getExpectedToken() : getExpectedToken;
        if (!expected) {
            return res.status(500).json(scimError(500, 'SCIM token not configured for this flow'));
        }
        const auth = (req.get('authorization') || '').trim();

        // Accept "Bearer <token>" (RFC 6750) AND raw "<token>". Okta's catalog
        // (Header Auth) Governance with SCIM 2.0 template sends the token raw,
        // while custom AIW SCIM apps send it with the Bearer prefix.
        const presented = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '') : auth;

        if (presented !== expected) {
            return res.status(401).json(scimError(401, 'Invalid or missing bearer token'));
        }
        next();
    };
}

function setScimContentType(req, res, next) {
    res.type('application/scim+json');
    next();
}

module.exports = { buildBearerAuth, setScimContentType, scimError };
