/**
 * SCIM /Entitlements endpoint — exposes only the *access* category catalog
 * for Okta to discover. (Roles are at /Roles per Okta's guide.)
 *
 * Schema URN: urn:okta:scim:schemas:core:1.0:Entitlement
 *
 * The entitlement catalog is shared across both flows; the only per-flow
 * difference is the absolute URL emitted in meta.location.
 */

const express = require('express');
const { Entitlements } = require('../db');
const { scimError } = require('./auth');

const URN = 'urn:okta:scim:schemas:core:1.0:Entitlement';

function buildEntitlementsRouter(flowKey) {
    const router = express.Router();

    function toScim(e) {
        return {
            schemas:     [URN],
            id:          e.id,
            displayName: e.display_name,
            type:        'Entitlement',
            description: e.description || undefined,
            meta: {
                resourceType: 'Entitlement',
                location: `/${flowKey}/scim/v2/Entitlements/${encodeURIComponent(e.id)}`,
            },
        };
    }

    router.get('/', (req, res) => {
        let rows = Entitlements.list({ type: 'access' });

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

    return router;
}

module.exports = buildEntitlementsRouter;
