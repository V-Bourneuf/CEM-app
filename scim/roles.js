/**
 * SCIM /Roles endpoint — exposes only the *role* category catalog for Okta
 * to discover. Schema URN: urn:okta:scim:schemas:core:1.0:Role
 *
 * Per Okta's "SCIM with Entitlements" guide, Roles are a separate ResourceType
 * from Entitlements with their own endpoint.
 */

const express = require('express');
const { Entitlements } = require('../db');
const { scimError } = require('./auth');

const router = express.Router();
const URN = 'urn:okta:scim:schemas:core:1.0:Role';

function toScim(r) {
    return {
        schemas:     [URN],
        id:          r.id,
        displayName: r.display_name,
        type:        'Role',
        description: r.description || undefined,
        meta: {
            resourceType: 'Role',
            location: `/scim/v2/Roles/${encodeURIComponent(r.id)}`,
        },
    };
}

router.get('/', (req, res) => {
    let rows = Entitlements.list({ type: 'role' });

    const filter = req.query.filter;
    if (filter) {
        const m = /^(\w+)\s+eq\s+"([^"]+)"$/i.exec(filter);
        if (m) {
            const [, field, value] = m;
            if (field === 'displayName') rows = rows.filter(r => r.display_name === value);
            if (field === 'id')          rows = rows.filter(r => r.id === value);
        }
    }

    const startIndex = parseInt(req.query.startIndex, 10) || 1;
    const count      = Math.min(parseInt(req.query.count, 10) || rows.length, 200);
    const sliced     = rows.slice(startIndex - 1, startIndex - 1 + count);

    res.json({
        schemas:      ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: rows.length,
        startIndex,
        itemsPerPage: sliced.length,
        Resources:    sliced.map(toScim),
    });
});

router.get('/:id', (req, res) => {
    const r = Entitlements.findById(decodeURIComponent(req.params.id));
    if (!r || r.type !== 'role') {
        return res.status(404).json(scimError(404, `Role '${req.params.id}' not found`));
    }
    res.json(toScim(r));
});

module.exports = router;
