/**
 * CEM App entrypoint.
 *
 * One server, two parallel SAML demos:
 *   /byo/*    → BYO entitlements via SAML attribute statements (Path A)
 *   /scim/*   → Governance with SCIM 2.0 (Path B)
 *
 * Plus shared infrastructure mounted on top:
 *   /scim/v2/*   → SCIM 2.0 protocol endpoints (used by the SCIM flow's Okta app)
 *   /admin/*     → Admin UI (entitlement catalog + integration management)
 *   /            → Landing page that lets users pick which flow to demo
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
const { loadProfile, setupProfileInteractive, KNOWN_FLOWS } = require('./profileManager');

const PORT       = parseInt(process.env.PORT, 10) || 1337;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ---------- bootstrap the express app ----------

const app = express();

// Behind nginx/ALB on EC2, trust the X-Forwarded-* headers
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false,        // dashboards inline minor styles; tighten later if desired
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

    // Look up the user in our DB (provisioned via SCIM). If found and has grants,
    // those drive the dashboard. If not, fall back to whatever the SAML attributes carried.
    const dbUser = db.Users.findByUserName(userData.email) || db.Users.findByEmail(userData.email);
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

// ---------- factory: build a router for a single flow (byo or scim) ----------

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

// ---------- mount: SCIM 2.0 protocol + admin (must come before /scim flow router) ----------

app.use('/scim/v2', require('./scim/router'));
app.use('/admin',   require('./admin/router'));

// ---------- mount: flow routers ----------

const profiles = {};
for (const flowKey of KNOWN_FLOWS) {
    const profile = loadProfile(flowKey);
    if (profile) {
        profiles[flowKey] = profile;
        if (profile.scimToken) process.env.SCIM_TOKEN = profile.scimToken;
        // Both profiles can declare adminEmails; merge them into one allowlist.
        if (profile.adminEmails) {
            const merged = new Set((process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean));
            for (const e of profile.adminEmails.split(',').map(s => s.trim()).filter(Boolean)) merged.add(e);
            process.env.ADMIN_EMAILS = [...merged].join(',');
        }
        if (profile.skipAttributes) {
            // Both profiles can declare skip lists; union them.
            const merged = new Set((process.env.SKIP_ATTRIBUTES || '').split(',').map(s => s.trim()).filter(Boolean));
            for (const a of profile.skipAttributes.split(',').map(s => s.trim()).filter(Boolean)) merged.add(a);
            process.env.SKIP_ATTRIBUTES = [...merged].join(',');
        }
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
    req.logout(() => {
        req.session && req.session.destroy && req.session.destroy(() => res.redirect('/'));
        if (!req.session) res.redirect('/');
    });
});

// ---------- startup ----------

(async () => {
    const args = process.argv.slice(2);
    const setupIdx = args.indexOf('--setup');
    if (setupIdx >= 0) {
        const name = args[setupIdx + 1];
        if (!name) { console.error('Usage: node server.js --setup <byo|scim>'); process.exit(2); }
        await setupProfileInteractive(name);
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
        }
        console.log('');
        console.log(`SCIM endpoint:    ${PUBLIC_URL}/scim/v2  (used by the /scim flow's Okta app)`);
        const adminMode = process.env.ADMIN_EMAILS
            ? `Okta SAML allowlist — ${process.env.ADMIN_EMAILS}`
            : 'entitlement-based only (assign App Admin in Okta IGA → SCIM PATCH)';
        console.log(`Admin UI:         ${PUBLIC_URL}/admin   (auth: ${adminMode})`);
        console.log('');
    });
})().catch(err => {
    console.error('\nStartup failed:', err.message);
    process.exit(1);
});
