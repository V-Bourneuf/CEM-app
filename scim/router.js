/**
 * SCIM 2.0 router factory — mounts service discovery, Users, Roles, Entitlements.
 * Each flow (byo, scim) calls this to mount its own SCIM endpoint at
 * /<flow>/scim/v2/*. Bearer auth uses each flow's own token.
 */

const express = require('express');
const { buildBearerAuth, setScimContentType, scimError } = require('./auth');
const buildUsersRouter        = require('./users');
const buildGroupsRouter       = require('./groups');
const buildRolesRouter        = require('./roles');
const buildEntitlementsRouter = require('./entitlements');
const buildSchemasRouter      = require('./schemas');

function buildScimRouter({ flowKey, getScimToken }) {
    if (!flowKey) throw new Error('buildScimRouter: flowKey is required');
    if (!getScimToken) throw new Error('buildScimRouter: getScimToken is required');

    const router = express.Router();

    router.use(express.json({
        limit: '1mb',
        type: ['application/scim+json', 'application/json'],
    }));

    router.use(setScimContentType);
    router.use(buildBearerAuth(getScimToken));

    router.use('/Users',        buildUsersRouter(flowKey));
    router.use('/Groups',       buildGroupsRouter(flowKey));
    router.use('/Roles',        buildRolesRouter(flowKey));
    router.use('/Entitlements', buildEntitlementsRouter(flowKey));
    router.use('/',             buildSchemasRouter(flowKey));

    router.all('*', (req, res) => {
        res.status(404).json(scimError(404, `${req.method} ${req.originalUrl} is not implemented`));
    });

    return router;
}

module.exports = buildScimRouter;
