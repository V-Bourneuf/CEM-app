/**
 * SQLite connection + queries for the CEM App.
 * Uses better-sqlite3 (synchronous; ideal for single-process server with low write rate).
 *
 * On first start, runs the schema and seeds the entitlements table from the
 * legacy in-memory catalog. Idempotent — running it again is a no-op.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { PROFILES } = require('./profiles');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'cemapp.db');

let db;

function open(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
    if (db) return db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schemaSQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    db.exec(schemaSQL);
    runMigrations();
    seedIfEmpty();
    return db;
}

// Idempotent runtime migrations. SQLite's ALTER TABLE doesn't support
// IF NOT EXISTS for ADD COLUMN, so we inspect the schema first.
function runMigrations() {
    const cols = db.prepare("PRAGMA table_info(entitlements)").all().map(c => c.name);

    // 2026-05-27: add `profile` column to entitlements + backfill from PROFILES catalog
    if (!cols.includes('profile')) {
        db.exec("ALTER TABLE entitlements ADD COLUMN profile TEXT");
        const update = db.prepare("UPDATE entitlements SET profile = ? WHERE id = ?");
        const tx = db.transaction(() => {
            for (const profile of Object.values(PROFILES)) {
                for (const e of profile.entitlements) {
                    update.run(profile.id, e.id);
                }
            }
        });
        tx();
    }

    // 2026-05-27 (later): add `grants_admin` column. Backfill from PROFILES so
    // anything in the catalog that the template marks as admin-granting gets the flag.
    const colsAfterProfile = db.prepare("PRAGMA table_info(entitlements)").all().map(c => c.name);
    if (!colsAfterProfile.includes('grants_admin')) {
        db.exec("ALTER TABLE entitlements ADD COLUMN grants_admin INTEGER NOT NULL DEFAULT 0");
        const update = db.prepare("UPDATE entitlements SET grants_admin = 1 WHERE id = ?");
        const tx = db.transaction(() => {
            for (const profile of Object.values(PROFILES)) {
                for (const e of profile.entitlements) {
                    if (e.grants_admin) update.run(e.id);
                }
            }
        });
        tx();
    }

    // 2026-05-29: add `flow` column to users + drop the global UNIQUE(user_name)
    // in favor of UNIQUE(flow, user_name). SQLite can't drop a column-level UNIQUE
    // in place — recreate the table. Existing rows are backfilled as flow='scim'
    // (the only flow that previously supported provisioning).
    const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    if (!userCols.includes('flow')) {
        const tx = db.transaction(() => {
            db.exec(`
                CREATE TABLE users_new (
                    id            TEXT PRIMARY KEY,
                    external_id   TEXT,
                    user_name     TEXT NOT NULL,
                    email         TEXT,
                    given_name    TEXT,
                    family_name   TEXT,
                    active        INTEGER NOT NULL DEFAULT 1,
                    flow          TEXT NOT NULL,
                    created_at    TEXT DEFAULT (datetime('now')),
                    updated_at    TEXT DEFAULT (datetime('now')),
                    UNIQUE (flow, user_name)
                );
                INSERT INTO users_new (id, external_id, user_name, email, given_name, family_name, active, flow, created_at, updated_at)
                    SELECT id, external_id, user_name, email, given_name, family_name, active, 'scim', created_at, updated_at FROM users;
                DROP TABLE users;
                ALTER TABLE users_new RENAME TO users;
                CREATE INDEX IF NOT EXISTS idx_users_flow_username ON users(flow, user_name);
                CREATE INDEX IF NOT EXISTS idx_users_email         ON users(email);
            `);
        });
        // FK ON DELETE CASCADE on user_entitlements points at users.id; ids are preserved
        // so the swap is FK-safe — but SQLite still complains during the rename if foreign_keys
        // is on. Toggle it off for this migration only.
        db.pragma('foreign_keys = OFF');
        try { tx(); } finally { db.pragma('foreign_keys = ON'); }
    }

    // Always-idempotent — safe whether the migration block above ran or the
    // table was created fresh from schema.sql.
    db.exec("CREATE INDEX IF NOT EXISTS idx_users_flow_username ON users(flow, user_name)");
}

function close() {
    if (db) { db.close(); db = null; }
}

// ---------- seeding ----------

// On a fresh DB, seed only the "software-devops" profile so the dashboard
// has something to show. Other profiles are opt-in via the admin UI.
function seedIfEmpty() {
    const count = db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n;
    if (count > 0) return;
    enableProfile('software-devops');
}

// ---------- profile management (defined here so seedIfEmpty can use it) ----------

function enableProfile(profileId) {
    const profile = PROFILES[profileId];
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    const insert = db.prepare(`
        INSERT OR IGNORE INTO entitlements (id, type, display_name, value, column_hint, description, profile, grants_admin)
        VALUES (@id, @type, @display_name, @value, @column_hint, @description, @profile, @grants_admin)
    `);
    const tx = db.transaction(() => {
        for (const e of profile.entitlements) {
            insert.run({
                id:           e.id,
                type:         e.type,
                display_name: e.display_name,
                value:        e.value,
                column_hint:  e.column_hint || null,
                description:  e.description || null,
                profile:      profile.id,
                grants_admin: e.grants_admin ? 1 : 0,
            });
        }
    });
    tx();
    return countForProfile(profileId);
}

function disableProfile(profileId) {
    if (!PROFILES[profileId]) throw new Error(`Unknown profile: ${profileId}`);
    return db.prepare('DELETE FROM entitlements WHERE profile = ?').run(profileId).changes;
}

function countForProfile(profileId) {
    return db.prepare('SELECT COUNT(*) AS n FROM entitlements WHERE profile = ?').get(profileId).n;
}

// ---------- entitlement queries ----------

const Entitlements = {
    list({ type } = {}) {
        return type
            ? db.prepare('SELECT * FROM entitlements WHERE type = ? ORDER BY display_name').all(type)
            : db.prepare('SELECT * FROM entitlements ORDER BY type, display_name').all();
    },
    findById(id) {
        return db.prepare('SELECT * FROM entitlements WHERE id = ?').get(id);
    },
    findByValue(value, type) {
        return type
            ? db.prepare('SELECT * FROM entitlements WHERE value = ? AND type = ?').get(value, type)
            : db.prepare('SELECT * FROM entitlements WHERE value = ?').get(value);
    },
    create({ id, type, displayName, value, columnHint, description, profile, grantsAdmin }) {
        if (!id) id = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        db.prepare(`
            INSERT INTO entitlements (id, type, display_name, value, column_hint, description, profile, grants_admin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, type, displayName, value, columnHint || null, description || null, profile || null, grantsAdmin ? 1 : 0);
        return this.findById(id);
    },
    update(id, { displayName, value, columnHint, description, type, profile, grantsAdmin }) {
        db.prepare(`
            UPDATE entitlements
               SET display_name  = COALESCE(?, display_name),
                   value         = COALESCE(?, value),
                   column_hint   = COALESCE(?, column_hint),
                   description   = COALESCE(?, description),
                   type          = COALESCE(?, type),
                   profile       = COALESCE(?, profile),
                   grants_admin  = COALESCE(?, grants_admin),
                   updated_at    = datetime('now')
             WHERE id = ?
        `).run(
            displayName ?? null,
            value ?? null,
            columnHint ?? null,
            description ?? null,
            type ?? null,
            profile ?? null,
            grantsAdmin === undefined ? null : (grantsAdmin ? 1 : 0),
            id
        );
        return this.findById(id);
    },
    // Distinct column_hint values currently in the catalog — used for the
    // edit form's autocomplete datalist.
    distinctColumnHints() {
        return db.prepare("SELECT DISTINCT column_hint AS h FROM entitlements WHERE column_hint IS NOT NULL AND column_hint != '' ORDER BY column_hint").all().map(r => r.h);
    },
    delete(id) {
        return db.prepare('DELETE FROM entitlements WHERE id = ?').run(id).changes > 0;
    },
};

// ---------- user queries ----------

function newId() { return crypto.randomUUID(); }

// Every lookup that originates from a per-flow context (a SCIM request, a
// dashboard render, an admin verdict for an authenticated session) MUST pass
// `flow` so users from one Okta app can't accidentally answer a request scoped
// to the other. Admin-only views (e.g. /admin/users) call listAll() to see
// everyone across both flows.
const Users = {
    list({ filter, startIndex = 1, count = 100, flow } = {}) {
        // Minimal SCIM filter: `userName eq "x"` and `active eq true`
        const where = ['1=1'];
        const params = [];
        if (flow) { where.push('flow = ?'); params.push(flow); }
        if (filter) {
            const eqMatch = /^(\w+)\s+eq\s+"?([^"]+)"?$/i.exec(filter);
            if (eqMatch) {
                const [, field, value] = eqMatch;
                if (['userName', 'user_name'].includes(field)) { where.push('user_name = ?');   params.push(value); }
                else if (field === 'email')                    { where.push('email = ?');       params.push(value); }
                else if (field === 'externalId')               { where.push('external_id = ?'); params.push(value); }
                else if (field === 'active')                   { where.push('active = ?');      params.push(value === 'true' ? 1 : 0); }
            }
        }
        const whereSql = where.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${whereSql}`).get(...params).n;
        const rows  = db.prepare(`SELECT * FROM users WHERE ${whereSql} ORDER BY user_name LIMIT ? OFFSET ?`)
                        .all(...params, count, startIndex - 1);
        return { total, rows };
    },
    findById(id)                        { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); },
    findByUserName(userName, flow)      {
        if (!flow) throw new Error('Users.findByUserName requires a flow');
        return db.prepare('SELECT * FROM users WHERE user_name = ? AND flow = ?').get(userName, flow);
    },
    findByEmail(email, flow)            {
        if (!flow) throw new Error('Users.findByEmail requires a flow');
        return db.prepare('SELECT * FROM users WHERE email = ? AND flow = ?').get(email, flow);
    },
    create({ externalId, userName, email, givenName, familyName, active = true, flow }) {
        if (!flow) throw new Error('Users.create requires a flow');
        const id = newId();
        db.prepare(`
            INSERT INTO users (id, external_id, user_name, email, given_name, family_name, active, flow)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, externalId || null, userName, email || null, givenName || null, familyName || null, active ? 1 : 0, flow);
        return this.findById(id);
    },
    update(id, patch) {
        const existing = this.findById(id);
        if (!existing) return null;
        const merged = {
            external_id: patch.externalId  ?? existing.external_id,
            user_name:   patch.userName    ?? existing.user_name,
            email:       patch.email       ?? existing.email,
            given_name:  patch.givenName   ?? existing.given_name,
            family_name: patch.familyName  ?? existing.family_name,
            active:      patch.active === undefined ? existing.active : (patch.active ? 1 : 0),
        };
        db.prepare(`
            UPDATE users SET external_id=?, user_name=?, email=?, given_name=?, family_name=?, active=?, updated_at=datetime('now')
             WHERE id=?
        `).run(merged.external_id, merged.user_name, merged.email, merged.given_name, merged.family_name, merged.active, id);
        return this.findById(id);
    },
    deactivate(id) {
        db.prepare(`UPDATE users SET active=0, updated_at=datetime('now') WHERE id=?`).run(id);
        return this.findById(id);
    },
    delete(id) {
        return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
    },
    listAll() { return db.prepare('SELECT * FROM users ORDER BY flow, user_name').all(); },
};

// ---------- grant queries ----------

const Grants = {
    listForUser(userId) {
        return db.prepare(`
            SELECT e.* FROM entitlements e
              JOIN user_entitlements ue ON ue.entitlement_id = e.id
             WHERE ue.user_id = ?
             ORDER BY e.type, e.display_name
        `).all(userId);
    },
    // True when this user holds at least one entitlement flagged grants_admin = 1
    hasAdminGrant(userId) {
        const row = db.prepare(`
            SELECT 1 AS yes FROM user_entitlements ue
              JOIN entitlements e ON e.id = ue.entitlement_id
             WHERE ue.user_id = ? AND e.grants_admin = 1
             LIMIT 1
        `).get(userId);
        return !!row;
    },
    grant(userId, entitlementId) {
        db.prepare(`
            INSERT OR IGNORE INTO user_entitlements (user_id, entitlement_id)
            VALUES (?, ?)
        `).run(userId, entitlementId);
    },
    revoke(userId, entitlementId) {
        db.prepare(`DELETE FROM user_entitlements WHERE user_id=? AND entitlement_id=?`).run(userId, entitlementId);
    },
    revokeAll(userId) {
        db.prepare(`DELETE FROM user_entitlements WHERE user_id=?`).run(userId);
    },
    setForUser(userId, entitlementIds) {
        const tx = db.transaction(() => {
            this.revokeAll(userId);
            const insert = db.prepare(`INSERT INTO user_entitlements (user_id, entitlement_id) VALUES (?, ?)`);
            entitlementIds.forEach(eid => insert.run(userId, eid));
        });
        tx();
    },
};

// ---------- profile API (façade over the helpers above) ----------

const Profiles = {
    list() {
        // Return each defined profile with its activation state + counts + live entitlements.
        return Object.values(PROFILES).map(p => {
            const liveEntitlements = db.prepare(
                'SELECT * FROM entitlements WHERE profile = ? ORDER BY type, display_name'
            ).all(p.id);
            const liveByType = liveEntitlements.reduce((acc, e) => {
                acc[e.type] = (acc[e.type] || 0) + 1;
                return acc;
            }, {});
            return {
                id:                  p.id,
                name:                p.name,
                description:         p.description,
                active:              liveEntitlements.length > 0,
                roleCount:           liveByType.role   || 0,
                accessCount:         liveByType.access || 0,
                expectedRoleCount:   p.entitlements.filter(e => e.type === 'role').length,
                expectedAccessCount: p.entitlements.filter(e => e.type === 'access').length,
                templateEntitlements: p.entitlements,    // static (from profiles.js) — preview when inactive
                liveEntitlements,                        // actual rows in DB — manageable when active
            };
        });
    },
    findById(id)        { return PROFILES[id] || null; },
    enable(profileId)   { return enableProfile(profileId); },
    disable(profileId)  { return disableProfile(profileId); },
};

module.exports = { open, close, Entitlements, Users, Grants, Profiles };
