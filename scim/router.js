/**
 * SCIM 2.0 router — mounts service discovery, Users, Entitlements under /scim/v2.
 * Bearer auth required on all endpoints.
 */

const express = require('express');
const { bearerAuth, setScimContentType, scimError } = require('./auth');

const router = express.Router();

// Parse SCIM JSON: Okta uses application/scim+json AND application/json depending on op
router.use(express.json({
    limit: '1mb',
    type: ['application/scim+json', 'application/json'],
}));

router.use(setScimContentType);
router.use(bearerAuth);

router.use('/Users',        require('./users'));
router.use('/Groups',       require('./groups'));        // empty stub — Okta sync probes this
router.use('/Roles',        require('./roles'));
router.use('/Entitlements', require('./entitlements'));
router.use('/',             require('./schemas'));        // ServiceProviderConfig, ResourceTypes, Schemas

router.all('*', (req, res) => {
    res.status(404).json(scimError(404, `${req.method} ${req.originalUrl} is not implemented`));
});

module.exports = router;
