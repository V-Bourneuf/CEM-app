/**
 * SCIM /Groups stub.
 *
 * This app uses SCIM Roles + Entitlements (Okta CEM) for access control, not
 * Groups. But Okta's provisioning flows probe /Groups during sync — a 404
 * causes "AppInstance does not support importing user schema" and similar
 * confused errors. Returning an empty ListResponse keeps Okta happy without
 * pretending to support group push/pull.
 */

const express = require('express');
const { scimError } = require('./auth');

function buildGroupsRouter(/* flowKey */) {
    const router = express.Router();

    router.get('/', (req, res) => {
        res.json({
            schemas:      ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
            totalResults: 0,
            startIndex:   parseInt(req.query.startIndex, 10) || 1,
            itemsPerPage: 0,
            Resources:    [],
        });
    });

    router.get('/:id', (req, res) => {
        res.status(404).json(scimError(404, `Group '${req.params.id}' not found`));
    });

    router.post('/',     (req, res) => res.status(501).json(scimError(501, 'Group push not supported (this app uses SCIM Roles & Entitlements instead)')));
    router.put('/:id',   (req, res) => res.status(501).json(scimError(501, 'Group updates not supported')));
    router.patch('/:id', (req, res) => res.status(501).json(scimError(501, 'Group updates not supported')));
    router.delete('/:id',(req, res) => res.status(501).json(scimError(501, 'Group deletion not supported')));

    return router;
}

module.exports = buildGroupsRouter;
