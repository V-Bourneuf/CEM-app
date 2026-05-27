/**
 * SCIM bearer-token middleware + SCIM-spec error response helper.
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

function bearerAuth(req, res, next) {
    const expected = process.env.SCIM_TOKEN;
    if (!expected) return res.status(500).json(scimError(500, 'SCIM_TOKEN not configured on the server'));
    const auth = (req.get('authorization') || '').trim();

    // Accept "Bearer <token>" (RFC 6750) AND raw "<token>". Okta's catalog
    // (Header Auth) Governance with SCIM 2.0 template sends the token raw,
    // while custom AIW SCIM apps send it with the Bearer prefix.
    const presented = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '') : auth;

    if (presented !== expected) {
        return res.status(401).json(scimError(401, 'Invalid or missing bearer token'));
    }
    next();
}

function setScimContentType(req, res, next) {
    res.type('application/scim+json');
    next();
}

module.exports = { bearerAuth, setScimContentType, scimError };
