/**
 * SCIM /Entitlements endpoint — exposes only the *access* category catalog
 * for Okta to discover. (Roles are at /Roles per Okta's guide.)
 *
 * Schema URN: urn:okta:scim:schemas:core:1.0:Entitlement
 */

const express = require('express');
const { Entitlements } = require('../db');
const { scimError } = require('./auth');

const router = express.Router();
const URN = 'urn:okta:scim:schemas:core:1.0:Entitlement';

function toScim(e) {
    return {
        schemas:     [URN],
        id:          e.id,
        displayName: e.display_name,
        type:        'Entitlement',     // matches the ResourceType.name per Okta's guide
        description: e.description || undefined,
        meta: {
            resourceType: 'Entitlement',
            location: `/scim/v2/Entitlements/${encodeURIComponent(e.id)}`,
        },
    };
}

router.get('/', (req, res) => {
    let rows = Entitlements.list({ type: 'access' });

    // Optional `filter=displayName eq "..."` and similar
    const filter = req.query.filter;
    if (filter) {
        const m = /^(\w+)\s+eq\s+"([^"]+)"$/i.exec(filter);
        if (m) {
            const [, field, value] = m;
            if (field === 'displayName') rows = rows.filter(e => e.display_name === value);
            if (field === 'id')          rows = rows.filter(e => e.id === value);
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
    const e = Entitlements.findById(decodeURIComponent(req.params.id));
    if (!e || e.type !== 'access') {
        return res.status(404).json(scimError(404, `Entitlement '${req.params.id}' not found`));
    }
    res.json(toScim(e));
});

module.exports = router;
