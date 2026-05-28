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

const app = express();

// Behind nginx/ALB on EC2, trust the X-Forwarded-* headers
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false,        // dashboard inlines scripts; tighten later if desired
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

// SCIM 2.0 endpoints (Users + Entitlements + service discovery) for Okta provisioning
app.use('/scim/v2', require('./scim/router'));

// Admin UI (entitlement CRUD, user list) — gated by basic auth via env vars
app.use('/admin',   require('./admin/router'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public/views'));
app.use(express.static('public'));

passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((u, done) => done(null, u));

// ---------- public routes ----------

app.get('/', (req, res) => {
    res.render('login', { host: req.headers.host || 'localhost' });
});

app.get('/auth/saml', passport.authenticate('saml', { failureRedirect: '/' }));

// Admin entry point: same SAML flow, but the callback redirects to /admin/dashboard
// after a successful sign-in (instead of rendering the public dashboard).
app.get('/auth/saml/admin', (req, res, next) => {
    req.session.postLoginRedirect = '/admin/dashboard';
    passport.authenticate('saml', { failureRedirect: '/' })(req, res, next);
});

app.post('/login/callback',
    passport.authenticate('saml', { failureRedirect: '/' }),
    (req, res) => {
        // Persist a debug log of every callback (helpful for tenant configuration debugging).
        try {
            const debugLines = [`\n========== ${new Date().toISOString()} ==========`];
            if (req.body && req.body.SAMLResponse) {
                debugLines.push('--- Decoded SAML Assertion (raw XML) ---');
                debugLines.push(Buffer.from(req.body.SAMLResponse, 'base64').toString());
            }
            debugLines.push('\n--- req.user ---');
            debugLines.push(JSON.stringify(req.user, null, 2));
            fs.appendFileSync(path.join(__dirname, 'saml-debug.log'), debugLines.join('\n') + '\n');
        } catch (e) {
            console.error('saml-debug.log write failed:', e.message);
        }

        if (!req.user) return res.redirect('/auth/saml');

        const userData = {
            email:     req.user.nameID,
            firstName: req.user.firstName,
            lastName:  req.user.lastName,
        };

        // Look up the user in our DB (provisioned via SCIM). If found and has grants,
        // those drive the dashboard. If not, fall back to whatever the SAML attributes carried.
        const dbUser = db.Users.findByUserName(userData.email) || db.Users.findByEmail(userData.email);
        let entitlements = { role: [], access: [] };

        if (dbUser) {
            const grants = db.Grants.listForUser(dbUser.id);
            grants.forEach(g => {
                entitlements[g.type] = entitlements[g.type] || [];
                entitlements[g.type].push(g.value);
            });
        } else if (req.user.attributes) {
            const skip = (process.env.SKIP_ATTRIBUTES || '').split(',').map(s => s.trim()).filter(Boolean);
            Object.entries(req.user.attributes).forEach(([key, value]) => {
                if (skip.includes(key) || value === undefined) return;
                entitlements[key] = Array.isArray(value) ? value.flat() : [value];
            });
        }

        // Catalogs for the dashboard's display-name lookups + column routing
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

        // Cleaned, render-safe view of the SAML profile for the dashboard
        const samlAssertion = {
            nameID:       req.user.nameID,
            nameIDFormat: req.user.nameIDFormat,
            issuer:       req.user.issuer,
            sessionIndex: req.user.sessionIndex,
            attributes:   req.user.attributes || {},
        };

        // Compute admin status: bootstrap allowlist OR has an admin-granting entitlement
        // (mirrors admin/router.js's isAdminRequest)
        const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const emailLower  = (userData.email || '').toLowerCase();
        const isBootstrapAdmin    = adminEmails.includes(emailLower);
        const isEntitlementAdmin  = !!dbUser && db.Grants.hasAdminGrant(dbUser.id);
        const isAdmin             = isBootstrapAdmin || isEntitlementAdmin;

        // If the user came in via the admin entry point, redirect to /admin/dashboard
        // (only allow same-origin paths starting with "/" to avoid open-redirect abuse).
        const target = req.session && req.session.postLoginRedirect;
        if (target && typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')) {
            delete req.session.postLoginRedirect;
            return res.redirect(target);
        }

        res.render('dashboard', {
            user: userData,
            entitlements,
            accessCatalog,
            roleCatalog,
            samlAssertion,
            provisionedFromDb: !!dbUser,
            isAdmin,
        });
    }
);

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// ---------- startup ----------

const { selectOrCreateProfile, loadProfile } = require('./profileManager');

(async () => {
    const args = process.argv.slice(2);
    const profileFlagIdx = args.indexOf('--profile');
    const forcePrompt    = args.includes('--prompt');
    const legacyCertPath = path.join(__dirname, 'saml.pem');

    let profile;
    if (profileFlagIdx >= 0 && args[profileFlagIdx + 1]) {
        profile = loadProfile(args[profileFlagIdx + 1]);
    } else if (!forcePrompt && process.env.OKTA_ENTRYPOINT && fs.existsSync(legacyCertPath)) {
        profile = {
            name: '.env (legacy)',
            entryPoint:     process.env.OKTA_ENTRYPOINT,
            issuer:         process.env.OKTA_ISSUER,
            skipAttributes: process.env.SKIP_ATTRIBUTES || '',
            scimToken:      process.env.SCIM_TOKEN || '',
            adminUser:      process.env.ADMIN_USER || '',
            adminPass:      process.env.ADMIN_PASS || '',
            cert:           fs.readFileSync(legacyCertPath, 'utf8'),
        };
    } else {
        profile = await selectOrCreateProfile();
    }

    process.env.SKIP_ATTRIBUTES = profile.skipAttributes || '';
    if (profile.scimToken)  process.env.SCIM_TOKEN  = profile.scimToken;
    if (profile.adminUser)  process.env.ADMIN_USER  = profile.adminUser;
    if (profile.adminPass)  process.env.ADMIN_PASS  = profile.adminPass;
    if (profile.adminEmails) process.env.ADMIN_EMAILS = profile.adminEmails;

    const port      = parseInt(process.env.PORT, 10) || 1337;
    const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;

    passport.use(new SamlStrategy({
        entryPoint:  profile.entryPoint,
        issuer:      profile.issuer,
        callbackUrl: `${publicUrl}/login/callback`,
        cert:        profile.cert,
    }, (samlProfile, done) => done(null, samlProfile)));

    app.listen(port, () => {
        console.log(`\nLoaded profile:  ${profile.name}`);
        console.log(`Issuer:          ${profile.issuer}`);
        console.log(`Public URL:      ${publicUrl}`);
        console.log(`SCIM endpoint:   ${publicUrl}/scim/v2`);
        const adminMode = process.env.ADMIN_EMAILS ? `Okta SAML — ${process.env.ADMIN_EMAILS}`
                         : process.env.ADMIN_USER ? 'HTTP basic auth'
                         : 'DISABLED (no auth configured)';
        console.log(`Admin UI:        ${publicUrl}/admin   (auth: ${adminMode})`);
        console.log(`Listening on port ${port}\n`);
    });
})().catch(err => {
    console.error('\nStartup failed:', err.message);
    process.exit(1);
});
