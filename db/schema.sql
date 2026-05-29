-- CEM App persistent store: catalog of entitlements + provisioned users + grants.
-- Driven by SCIM provisioning from Okta and admin UI edits.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entitlements (
    id            TEXT PRIMARY KEY,           -- external SCIM id (slug, e.g. "deploy-code-to-prod")
    type          TEXT NOT NULL CHECK (type IN ('role', 'access')),
    display_name  TEXT NOT NULL,
    value         TEXT NOT NULL,               -- the value carried in SAML/SCIM assignments
    column_hint   TEXT,                        -- optional UI grouping ('softwareDev', 'devOps')
    description   TEXT,
    profile       TEXT,                        -- which profile this belongs to (retail, engineering, rnd, software-devops, administration)
    grants_admin  INTEGER NOT NULL DEFAULT 0,  -- 1 = granting this entitlement gives user access to /admin
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    UNIQUE (type, value)                        -- 'purchase' can exist as both role and access
);

CREATE INDEX IF NOT EXISTS idx_entitlements_type  ON entitlements(type);
CREATE INDEX IF NOT EXISTS idx_entitlements_value ON entitlements(value);

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,           -- internal id (uuid)
    external_id   TEXT,                        -- Okta-supplied externalId (optional)
    user_name     TEXT NOT NULL,               -- SCIM userName (typically email)
    email         TEXT,
    given_name    TEXT,
    family_name   TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    flow          TEXT NOT NULL,               -- which Okta app provisioned this user ('byo' or 'scim')
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    UNIQUE (flow, user_name)                   -- userName is unique within a flow, not globally
);

-- idx_users_flow_username is created by db/index.js runMigrations() so it works
-- both for fresh DBs (table created from this schema) and legacy DBs (where the
-- flow column is added by migration before the index can reference it).
CREATE INDEX IF NOT EXISTS idx_users_email         ON users(email);

CREATE TABLE IF NOT EXISTS user_entitlements (
    user_id        TEXT NOT NULL,
    entitlement_id TEXT NOT NULL,
    granted_at     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, entitlement_id),
    FOREIGN KEY (user_id)        REFERENCES users(id)        ON DELETE CASCADE,
    FOREIGN KEY (entitlement_id) REFERENCES entitlements(id) ON DELETE CASCADE
);
