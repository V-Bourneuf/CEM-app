/**
 * SCIM /Users endpoints — full CRUD for Okta provisioning, scoped to one flow.
 *
 * Both the BYO and SCIM Okta apps push users via SCIM 2.0; each app gets its
 * own router (mounted at /byo/scim/v2/Users and /scim/scim/v2/Users) with
 * `flow` baked in. Every Users.* call is flow-scoped so users provisioned
 * by one Okta app never collide with users from the other.
 *
 * Per Okta's SCIM-with-Entitlements guide, the User resource exposes BOTH:
 *   - `entitlements` — array of granted access-type catalog items
 *   - `roles`        — array of granted role-type catalog items
 * …with the same {value, display, type} shape. PATCH ops can target either path.
 *
 * Internally we store both flavours in the same `user_entitlements` table; the
 * type metadata lives on the entitlement row.
 */

const express = require('express');
const { Users, Entitlements, Grants } = require('../db');
const { scimError } = require('./auth');

function buildUsersRouter(flowKey) {
    const router = express.Router();

    // ---------- helpers ----------

    function userToScim(u) {
        if (!u) return null;
        const grants = Grants.listForUser(u.id);
        const roles        = grants.filter(g => g.type === 'role')  .map(scimGrant);
        const entitlements = grants.filter(g => g.type === 'access').map(scimGrant);
        return {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            id:         u.id,
            externalId: u.external_id || undefined,
            userName:   u.user_name,
            name: {
                givenName:  u.given_name  || undefined,
                familyName: u.family_name || undefined,
            },
            emails:       u.email ? [{ value: u.email, primary: true, type: 'work' }] : [],
            active:       !!u.active,
            roles,
            entitlements,
            meta: {
                resourceType: 'User',
                created:      u.created_at,
                lastModified: u.updated_at,
                location:     `/${flowKey}/scim/v2/Users/${u.id}`,
            },
        };
    }

    function scimGrant(g) {
        return {
            value:   g.id,
            display: g.display_name,
            type:    g.type === 'role' ? 'Role' : 'Entitlement',
        };
    }

    function pickFromBody(body) {
        return {
            externalId: body.externalId,
            userName:   body.userName,
            email:      body.emails?.[0]?.value || null,
            givenName:  body.name?.givenName,
            familyName: body.name?.familyName,
            active:     body.active !== undefined ? !!body.active : true,
        };
    }

    // Resolve a list of {value, type} SCIM grant items to internal entitlement IDs.
    // `value` may be either the entitlement ID (preferred, what Okta sends) or the
    // raw `value` column for backwards compat with hand-built test payloads.
    function scimGrantsToIds(items) {
        if (!Array.isArray(items)) return [];
        const ids = [];
        for (const item of items) {
            if (!item) continue;
            const candidate = item.value;
            if (!candidate) continue;
            let row = Entitlements.findById(candidate);
            if (!row) {
                const t = (item.type || '').toLowerCase() === 'role' ? 'role' : ((item.type || '').toLowerCase() === 'entitlement' ? 'access' : null);
                row = Entitlements.findByValue(candidate, t || undefined);
            }
            if (row) ids.push(row.id);
        }
        return ids;
    }

    // Cross-flow guard: if a request resolves a user by id, we still must
    // confirm that user belongs to *this* flow. Otherwise app A could touch
    // app B's users by id-guessing.
    function findScopedById(id) {
        const u = Users.findById(id);
        if (!u || u.flow !== flowKey) return null;
        return u;
    }

    // ---------- GET (list & single) ----------

    router.get('/', (req, res) => {
        const startIndex = parseInt(req.query.startIndex, 10) || 1;
        const count      = Math.min(parseInt(req.query.count, 10) || 100, 200);
        const { total, rows } = Users.list({ filter: req.query.filter, startIndex, count, flow: flowKey });
        res.json({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
            totalResults: total,
            startIndex,
            itemsPerPage: rows.length,
            Resources: rows.map(userToScim),
        });
    });

    router.get('/:id', (req, res) => {
        const u = findScopedById(req.params.id);
        if (!u) return res.status(404).json(scimError(404, `User '${req.params.id}' not found`));
        res.json(userToScim(u));
    });

    // ---------- POST (create) ----------

    router.post('/', (req, res) => {
        const body = req.body;
        if (!body || !body.userName) {
            return res.status(400).json(scimError(400, 'userName is required', 'invalidValue'));
        }

        const existing = Users.findByUserName(body.userName, flowKey);
        if (existing) {
            return res.status(409).json(scimError(409, `User '${body.userName}' already exists`, 'uniqueness'));
        }

        const created = Users.create({ ...pickFromBody(body), flow: flowKey });

        const grantIds = [
            ...scimGrantsToIds(body.roles || []),
            ...scimGrantsToIds(body.entitlements || []),
        ];
        if (grantIds.length) Grants.setForUser(created.id, grantIds);

        res.status(201).json(userToScim(Users.findById(created.id)));
    });

    // ---------- PUT (full replace) ----------

    router.put('/:id', (req, res) => {
        const u = findScopedById(req.params.id);
        if (!u) return res.status(404).json(scimError(404, `User '${req.params.id}' not found`));

        const body = req.body;
        Users.update(u.id, pickFromBody(body));

        const grantIds = [
            ...scimGrantsToIds(body.roles || []),
            ...scimGrantsToIds(body.entitlements || []),
        ];
        Grants.setForUser(u.id, grantIds);

        res.json(userToScim(Users.findById(u.id)));
    });

    // ---------- PATCH (partial update — Okta's primary mechanism for entitlement assignment) ----------

    router.patch('/:id', (req, res) => {
        const u = findScopedById(req.params.id);
        if (!u) return res.status(404).json(scimError(404, `User '${req.params.id}' not found`));

        const ops = (req.body && req.body.Operations) || [];
        if (!Array.isArray(ops)) return res.status(400).json(scimError(400, 'Missing Operations array', 'invalidSyntax'));

        let userPatch = {};

        for (const op of ops) {
            const operation = (op.op || '').toLowerCase();
            const path      = op.path || '';

            const matchEnt = path === 'entitlements' || path.startsWith('entitlements');
            const matchRole = path === 'roles'        || path.startsWith('roles');
            if (matchEnt || matchRole) {
                const items = Array.isArray(op.value) ? op.value : (op.value ? [op.value] : []);
                const ids   = scimGrantsToIds(items);

                if (operation === 'add') {
                    ids.forEach(id => Grants.grant(u.id, id));
                } else if (operation === 'replace') {
                    if (matchRole && matchEnt) {
                        Grants.setForUser(u.id, ids);
                    } else if (matchRole) {
                        const existing = Grants.listForUser(u.id);
                        const keepEnt  = existing.filter(g => g.type === 'access').map(g => g.id);
                        Grants.setForUser(u.id, [...keepEnt, ...ids]);
                    } else {
                        const existing = Grants.listForUser(u.id);
                        const keepRoles = existing.filter(g => g.type === 'role').map(g => g.id);
                        Grants.setForUser(u.id, [...keepRoles, ...ids]);
                    }
                } else if (operation === 'remove') {
                    if (ids.length === 0 && (path.includes('value eq') || path.includes('id eq'))) {
                        const m = /(?:value|id)\s+eq\s+"([^"]+)"/i.exec(path);
                        if (m) {
                            const e = Entitlements.findById(m[1]) || Entitlements.findByValue(m[1]);
                            if (e) Grants.revoke(u.id, e.id);
                        }
                    } else if (ids.length === 0) {
                        const all = Grants.listForUser(u.id);
                        const targetType = matchRole ? 'role' : 'access';
                        all.filter(g => g.type === targetType).forEach(g => Grants.revoke(u.id, g.id));
                    } else {
                        ids.forEach(id => Grants.revoke(u.id, id));
                    }
                }
                continue;
            }

            // ----- simple top-level fields -----
            const value = op.value;
            if (path === 'active' || (operation === 'replace' && value && typeof value === 'object' && 'active' in value)) {
                userPatch.active = path === 'active' ? !!value : !!value.active;
            }
            if (path === 'userName')    userPatch.userName   = value;
            if (path === 'externalId')  userPatch.externalId = value;
            if (path === 'name.givenName')  userPatch.givenName  = value;
            if (path === 'name.familyName') userPatch.familyName = value;
            if (path.startsWith('emails')) userPatch.email = value;

            if (!path && operation === 'replace' && value && typeof value === 'object') {
                if (value.userName)            userPatch.userName   = value.userName;
                if (value.externalId)          userPatch.externalId = value.externalId;
                if (value.active !== undefined) userPatch.active     = !!value.active;
                if (value.name?.givenName)     userPatch.givenName  = value.name.givenName;
                if (value.name?.familyName)    userPatch.familyName = value.name.familyName;
                if (value.emails?.[0]?.value)  userPatch.email      = value.emails[0].value;
            }
        }

        if (Object.keys(userPatch).length) Users.update(u.id, userPatch);

        res.json(userToScim(Users.findById(u.id)));
    });

    // ---------- DELETE (deactivate) ----------

    router.delete('/:id', (req, res) => {
        const u = findScopedById(req.params.id);
        if (!u) return res.status(404).json(scimError(404, `User '${req.params.id}' not found`));
        Users.deactivate(u.id);
        res.status(204).end();
    });

    return router;
}

module.exports = buildUsersRouter;
