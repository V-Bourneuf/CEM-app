/**
 * CEM App entrypoint.
 *
 * One server, two parallel SAML flows — each backed by its own Okta app
 * with its own SAML SSO and its own SCIM provisioning endpoint:
 *
 *   /byo/*               → BYO entitlements flow (SAML attrs for grants + optional SCIM provisioning)
 *   /byo/scim/v2/*       → SCIM 2.0 endpoint for the BYO Okta app
 *   /scim/*              → Governance with SCIM 2.0 flow (SAML SSO + SCIM provisioning)
 *   /scim/scim/v2/*      → SCIM 2.0 endpoint for the SCIM Okta app
 *
 * Plus shared infrastructure:
 *   /admin/*             → Admin UI (entitlement catalog + integration management)
 *   /                    → Landing page (flow picker + admin sign-in CTA)
 *
 * Each flow has an isolated user namespace — users provisioned by the BYO
 * Okta app live separately from users provisioned by the SCIM Okta app.
 */

const express = require('express');
const passport = require('passport');
const SamlStrategy = require('passport-saml').Strategy;
const fs = require('fs');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');

require('dotenv').config();

const db = require('./db');
db.open();

const { getAdminVerdict } = require('./admin/auth');
const buildScimRouter = require('./scim/router');
const {
    loadProfile, setupProfileInteractive,
    setupBreakglassInteractive, loadBreakglass,
    KNOWN_FLOWS,
} = require('./profileManager');

const PORT       = parseInt(process.env.PORT, 10) || 1337;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ---------- bootstrap the express app ----------

const app = express();

// Behind nginx/ALB on EC2, trust the X-Forwarded-* headers
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));

app.use(bodyParser.urlencoded({ extended: false }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'cemapp-dev-only-change-me',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production', sameSite: 'lax' },
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((u, done) => done(null, u));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public/views'));
app.use(express.static('public'));

// ---------- helper: build the dashboard locals from the SAML session ----------

function buildDashboardLocals(req, flowKey) {
    const userData = {
        email:     req.user.nameID,
        firstName: req.user.firstName,
        lastName:  req.user.lastName,
    };

    // Look up the user in our DB scoped to this flow's namespace. If found
    // and has grants, those drive the dashboard. Otherwise, fall back to
    // whatever the SAML attributes carried (BYO flow's pure-SAML path).
    const dbUser = db.Users.findByUserName(userData.email, flowKey)
                || (userData.email && db.Users.findByEmail(userData.email, flowKey));
    const entitlements = { role: [], access: [] };

    if (dbUser) {
        for (const g of db.Grants.listForUser(dbUser.id)) {
            entitlements[g.type] = entitlements[g.type] || [];
            entitlements[g.type].push(g.value);
        }
    } else if (req.user.attributes) {
        const skip = (process.env.SKIP_ATTRIBUTES || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const [key, value] of Object.entries(req.user.attributes)) {
            if (skip.includes(key) || value === undefined) continue;
            entitlements[key] = Array.isArray(value) ? value.flat() : [value];
        }
    }

    const accessCatalog = db.Entitlements.list({ type: 'access' }).map(e => ({
        externalId:  e.id,
        displayName: e.display_name,
        value:       e.value,
        column:      e.column_hint,
    }));
    const roleCatalog = db.Entitlements.list({ type: 'role' }).map(e => ({
        externalId:  e.id,
        displayName: e.display_name,
        value:       e.value,
    }));

    const samlAssertion = {
        nameID:       req.user.nameID,
        nameIDFormat: req.user.nameIDFormat,
        issuer:       req.user.issuer,
        sessionIndex: req.user.sessionIndex,
        attributes:   req.user.attributes || {},
    };

    return {
        flowKey,
        theme:             flowKey,
        user:              userData,
        entitlements,
        accessCatalog,
        roleCatalog,
        samlAssertion,
        provisionedFromDb: !!dbUser,
        isAdmin:           getAdminVerdict(req).ok,
        host:              req.headers.host || 'localhost',
    };
}

function appendSamlDebugLog(req) {
    try {
        const lines = [`\n========== ${new Date().toISOString()} ==========`];
        if (req.body && req.body.SAMLResponse) {
            lines.push('--- Decoded SAML Assertion (raw XML) ---');
            lines.push(Buffer.from(req.body.SAMLResponse, 'base64').toString());
        }
        lines.push('\n--- req.user ---');
        lines.push(JSON.stringify(req.user, null, 2));
        fs.appendFileSync(path.join(__dirname, 'saml-debug.log'), lines.join('\n') + '\n');
    } catch (e) {
        console.error('saml-debug.log write failed:', e.message);
    }
}

// ---------- factory: build a SAML router for one flow ----------

function buildFlowRouter(flowKey, profile) {
    const router = express.Router();
    const strategyName = `saml-${flowKey}`;

    passport.use(strategyName, new SamlStrategy({
        entryPoint:  profile.entryPoint,
        issuer:      profile.issuer,
        callbackUrl: `${PUBLIC_URL}/${flowKey}/login/callback`,
        cert:        profile.cert,
    }, (samlProfile, done) => done(null, samlProfile)));

    router.get('/', (req, res) => {
        if (req.isAuthenticated() && req.session.authFlow === flowKey) {
            return res.redirect(`/${flowKey}/dashboard`);
        }
        res.render('login', {
            theme:    flowKey,
            flowKey,
            host:     req.headers.host || 'localhost',
        });
    });

    router.get('/auth/saml', passport.authenticate(strategyName, { failureRedirect: `/${flowKey}` }));

    router.post('/login/callback',
        passport.authenticate(strategyName, { failureRedirect: `/${flowKey}` }),
        (req, res) => {
            appendSamlDebugLog(req);
            if (!req.user) return res.redirect(`/${flowKey}/auth/saml`);
            req.session.authFlow = flowKey;
            res.redirect(`/${flowKey}/dashboard`);
        }
    );

    router.get('/dashboard', (req, res) => {
        if (!req.isAuthenticated() || req.session.authFlow !== flowKey) {
            return res.redirect(`/${flowKey}`);
        }
        res.render('dashboard', buildDashboardLocals(req, flowKey));
    });

    return router;
}

function buildPlaceholderFlowRouter(flowKey) {
    const router = express.Router();
    router.use((req, res) => {
        res.status(503).render('placeholder', {
            theme:   flowKey,
            flowKey,
            host:    req.headers.host || 'localhost',
        });
    });
    return router;
}

// ---------- mount: shared admin (must come before any /<flow> routes) ----------

app.use('/admin', require('./admin/router'));

// ---------- mount: per-flow SCIM + SAML routers ----------

const profiles = {};
for (const flowKey of KNOWN_FLOWS) {
    const profile = loadProfile(flowKey);
    if (profile) {
        profiles[flowKey] = profile;
        // Both profiles can declare adminEmails; merge them into one allowlist.
        if (profile.adminEmails) {
            const merged = new Set((process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean));
            for (const e of profile.adminEmails.split(',').map(s => s.trim()).filter(Boolean)) merged.add(e);
            process.env.ADMIN_EMAILS = [...merged].join(',');
        }
        if (profile.skipAttributes) {
            const merged = new Set((process.env.SKIP_ATTRIBUTES || '').split(',').map(s => s.trim()).filter(Boolean));
            for (const a of profile.skipAttributes.split(',').map(s => s.trim()).filter(Boolean)) merged.add(a);
            process.env.SKIP_ATTRIBUTES = [...merged].join(',');
        }

        // SCIM endpoint must be mounted BEFORE the flow router so /<flow>/scim/v2/*
        // beats the flow router's catch-all routes.
        const flowKeyClosure = flowKey;
        app.use(`/${flowKey}/scim/v2`, buildScimRouter({
            flowKey,
            // Re-read on every request so admin profile edits + restart aren't required for
            // token rotation. (Restart is still required to swap the SAML strategy.)
            getScimToken: () => {
                const p = loadProfile(flowKeyClosure);
                return p ? (p.scimToken || '') : '';
            },
        }));

        app.use(`/${flowKey}`, buildFlowRouter(flowKey, profile));
    } else {
        app.use(`/${flowKey}`, buildPlaceholderFlowRouter(flowKey));
    }
}

// ---------- landing + global routes ----------

app.get('/', (req, res) => {
    res.render('landing', {
        host:     req.headers.host || 'localhost',
        flows:    KNOWN_FLOWS.map(k => ({ key: k, configured: !!profiles[k] })),
    });
});

app.get('/logout', (req, res) => {
    if (req.session) delete req.session.breakglass;
    req.logout(() => {
        if (req.session && req.session.destroy) {
            return req.session.destroy(() => res.redirect('/'));
        }
        res.redirect('/');
    });
});

// ---------- startup ----------

(async () => {
    const args = process.argv.slice(2);
    const setupIdx = args.indexOf('--setup');
    if (setupIdx >= 0) {
        const name = args[setupIdx + 1];
        if (!name) { console.error('Usage: node server.js --setup <byo|scim|breakglass>'); process.exit(2); }
        if (name === 'breakglass') {
            await setupBreakglassInteractive();
        } else {
            await setupProfileInteractive(name);
        }
        process.exit(0);
    }

    app.listen(PORT, () => {
        const status = (k) => profiles[k] ? '✓ configured' : '✗ NOT configured (run: node server.js --setup ' + k + ')';
        console.log('');
        console.log(`CEM App listening on ${PUBLIC_URL}`);
        console.log('');
        console.log('Flows:');
        for (const k of KNOWN_FLOWS) {
            console.log(`  /${k.padEnd(5)} → ${status(k)}`);
            if (profiles[k]) {
                const tokenStatus = profiles[k].scimToken ? '✓ token set' : '✗ no token (provisioning disabled)';
                console.log(`           SCIM endpoint: ${PUBLIC_URL}/${k}/scim/v2  (${tokenStatus})`);
            }
        }
        console.log('');
        const adminMode = process.env.ADMIN_EMAILS
            ? `Okta SAML allowlist — ${process.env.ADMIN_EMAILS}`
            : 'entitlement-based only (assign App Admin in Okta IGA → SCIM PATCH)';
        const breakglass = loadBreakglass();
        console.log(`Admin UI:  ${PUBLIC_URL}/admin   (auth: ${adminMode})`);
        console.log(`             + breakglass: ${breakglass ? '✓ ' + breakglass.username : '✗ NOT configured (run: node server.js --setup breakglass)'}`);
        console.log('');
    });
})().catch(err => {
    console.error('\nStartup failed:', err.message);
    process.exit(1);
});
