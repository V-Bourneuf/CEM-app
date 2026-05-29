/**
 * SCIM service-discovery endpoints: ServiceProviderConfig, ResourceTypes, Schemas.
 *
 * Aligned with Okta's "SCIM with Entitlements" guide:
 *   https://developer.okta.com/docs/guides/scim-with-entitlements
 *
 * Roles and Entitlements are exposed as SEPARATE ResourceTypes with their
 * own endpoints (`/Roles`, `/Entitlements`) and Okta-defined schema URNs.
 *
 * /Schemas advertises the full attribute definitions for User, Role, and
 * Entitlement. Okta needs these populated to enable entitlement imports —
 * an empty list yields "AppInstance does not support importing user schema".
 *
 * The discovery payloads are nearly identical across flows; the only
 * difference is the meta.location URL prefix.
 */

const express = require('express');

const URN = {
    User:        'urn:ietf:params:scim:schemas:core:2.0:User',
    Role:        'urn:okta:scim:schemas:core:1.0:Role',
    Entitlement: 'urn:okta:scim:schemas:core:1.0:Entitlement',
    ListResp:    'urn:ietf:params:scim:api:messages:2.0:ListResponse',
};

const STR = (name, opts = {}) => ({
    name,
    type:        'string',
    multiValued: false,
    description: opts.description || '',
    required:    opts.required    || false,
    caseExact:   opts.caseExact   || false,
    mutability:  opts.mutability  || 'readWrite',
    returned:    opts.returned    || 'default',
    uniqueness:  opts.uniqueness  || 'none',
    ...(opts.canonicalValues ? { canonicalValues: opts.canonicalValues } : {}),
});

const BOOL = (name, opts = {}) => ({
    name,
    type:        'boolean',
    multiValued: false,
    description: opts.description || '',
    required:    opts.required    || false,
    mutability:  opts.mutability  || 'readWrite',
    returned:    opts.returned    || 'default',
});

const COMPLEX = (name, subAttributes, opts = {}) => ({
    name,
    type:        'complex',
    multiValued: opts.multiValued || false,
    description: opts.description || '',
    required:    opts.required    || false,
    mutability:  opts.mutability  || 'readWrite',
    returned:    opts.returned    || 'default',
    subAttributes,
});

function buildSchemasRouter(flowKey) {
    const router = express.Router();

    const USER_SCHEMA = {
        id:          URN.User,
        name:        'User',
        description: 'User Account',
        attributes: [
            STR('userName', { required: true, uniqueness: 'server', description: 'Unique identifier for the User, typically used to authenticate.' }),
            COMPLEX('name', [
                STR('formatted',  { description: 'The full name, formatted for display.' }),
                STR('givenName',  { description: 'The given name of the User.' }),
                STR('familyName', { description: 'The family name of the User.' }),
            ], { description: "The components of the user's real name." }),
            COMPLEX('emails', [
                STR('value',   { description: 'Email address.' }),
                STR('display', { description: 'A human-readable name.' }),
                STR('type',    { canonicalValues: ['work', 'home', 'other'], description: "Label indicating the attribute's function." }),
                BOOL('primary',{ description: 'Whether this is the preferred email.' }),
            ], { multiValued: true, description: 'Email addresses for the user.' }),
            BOOL('active',     { description: "Boolean value indicating the User's administrative status." }),
            STR('externalId',  { description: 'An identifier for the resource as defined by the provisioning client.' }),
            COMPLEX('roles', [
                STR('value',   { required: true, description: 'The id of the role catalog item.' }),
                STR('display', { description: 'A human-readable name for the role.' }),
                STR('type',    { description: "Label indicating the attribute's function (e.g. 'Role')." }),
                BOOL('primary',{ description: 'Whether this is the preferred role.' }),
            ], { multiValued: true, description: 'A list of roles granted to the User.' }),
            COMPLEX('entitlements', [
                STR('value',   { required: true, description: 'The id of the entitlement catalog item.' }),
                STR('display', { description: 'A human-readable name for the entitlement.' }),
                STR('type',    { description: "Label indicating the attribute's function (e.g. 'Entitlement')." }),
                BOOL('primary',{ description: 'Whether this is the preferred entitlement.' }),
            ], { multiValued: true, description: 'A list of entitlements granted to the User.' }),
        ],
        meta: { resourceType: 'Schema', location: `/${flowKey}/scim/v2/Schemas/${URN.User}` },
    };

    const ROLE_SCHEMA = {
        id:          URN.Role,
        name:        'Role',
        description: 'Okta CEM Role catalog item',
        attributes: [
            STR('id',          { required: true, mutability: 'readOnly', returned: 'always', uniqueness: 'server', description: 'Unique role identifier.' }),
            STR('displayName', { required: true, returned: 'always', description: 'Human-readable role name.' }),
            STR('type',        { description: "Label indicating the attribute's function (always 'Role')." }),
            STR('description', { description: 'Free-text description of the role.' }),
        ],
        meta: { resourceType: 'Schema', location: `/${flowKey}/scim/v2/Schemas/${URN.Role}` },
    };

    const ENTITLEMENT_SCHEMA = {
        id:          URN.Entitlement,
        name:        'Entitlement',
        description: 'Okta CEM Entitlement (access permission) catalog item',
        attributes: [
            STR('id',          { required: true, mutability: 'readOnly', returned: 'always', uniqueness: 'server', description: 'Unique entitlement identifier.' }),
            STR('displayName', { required: true, returned: 'always', description: 'Human-readable entitlement name.' }),
            STR('type',        { description: "Label indicating the attribute's function (always 'Entitlement')." }),
            STR('description', { description: 'Free-text description of the entitlement.' }),
        ],
        meta: { resourceType: 'Schema', location: `/${flowKey}/scim/v2/Schemas/${URN.Entitlement}` },
    };

    const ALL_SCHEMAS = [USER_SCHEMA, ROLE_SCHEMA, ENTITLEMENT_SCHEMA];

    function listResponse(resources) {
        return {
            schemas:      [URN.ListResp],
            totalResults: resources.length,
            startIndex:   1,
            itemsPerPage: resources.length,
            Resources:    resources,
        };
    }

    router.get('/ServiceProviderConfig', (req, res) => {
        res.json({
            schemas:         ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
            documentationUri: 'https://github.com/V-Bourneuf/CEM-app',
            patch:           { supported: true },
            bulk:            { supported: false, maxOperations: 0, maxPayloadSize: 0 },
            filter:          { supported: true,  maxResults: 200 },
            changePassword:  { supported: false },
            sort:            { supported: false },
            etag:            { supported: false },
            authenticationSchemes: [{
                type: 'oauthbearertoken',
                name: 'OAuth Bearer Token',
                description: 'Static bearer token (per-flow scimToken)',
                primary: true,
            }],
        });
    });

    router.get('/ResourceTypes', (req, res) => {
        res.json(listResponse([
            {
                schemas:           ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
                id:                'User',
                name:              'User',
                endpoint:          '/Users',
                description:       'CEM App user account, provisioned by Okta',
                schema:            URN.User,
                schemaExtensions:  [],
            },
            {
                schemas:           ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
                id:                'Role',
                name:              'Role',
                endpoint:          '/Roles',
                description:       'CEM App business roles',
                schema:            URN.Role,
            },
            {
                schemas:           ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
                id:                'Entitlement',
                name:              'Entitlement',
                endpoint:          '/Entitlements',
                description:       'CEM App access permissions',
                schema:            URN.Entitlement,
            },
        ]));
    });

    router.get('/ResourceTypes/:id', (req, res) => {
        const map = {
            User:        { id: 'User',        endpoint: '/Users',        schema: URN.User,        description: 'CEM App user account' },
            Role:        { id: 'Role',        endpoint: '/Roles',        schema: URN.Role,        description: 'CEM App business role' },
            Entitlement: { id: 'Entitlement', endpoint: '/Entitlements', schema: URN.Entitlement, description: 'CEM App access permission' },
        };
        const rt = map[req.params.id];
        if (!rt) {
            return res.status(404).json({
                schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
                status:  '404',
                detail:  `ResourceType '${req.params.id}' not found`,
            });
        }
        res.json({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], name: rt.id, ...rt });
    });

    router.get('/Schemas', (req, res) => {
        res.json(listResponse(ALL_SCHEMAS));
    });

    router.get('/Schemas/:id', (req, res) => {
        const id = decodeURIComponent(req.params.id);
        const schema = ALL_SCHEMAS.find(s => s.id === id);
        if (!schema) {
            return res.status(404).json({
                schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
                status:  '404',
                detail:  `Schema '${id}' not found`,
            });
        }
        res.json(schema);
    });

    return router;
}

module.exports = buildSchemasRouter;
module.exports.URN = URN;
