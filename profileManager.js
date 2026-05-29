/**
 * Profile manager — load + save SAML profiles for each flow.
 *
 * The CEM App runs two parallel demos in one server:
 *   • profiles/byo/   → BYO entitlements (SAML attrs + optional SCIM provisioning)
 *   • profiles/scim/  → Governance with SCIM 2.0 (SAML SSO + SCIM provisioning)
 *
 * Each profile is a directory under ./profiles/<name>/ containing:
 *   config.json   { entryPoint, issuer, skipAttributes, scimToken, adminEmails }
 *   saml.pem      Okta signing certificate (PEM-encoded)
 *
 * Profiles can be created either:
 *   • from the command line: `node server.js --setup byo`   (interactive)
 *   • from the admin UI:     /admin/integrations             (web form)
 *
 * Whatever creates them, server.js loads them at startup and mounts the
 * matching flow. A missing profile is non-fatal — the server runs with
 * just the configured flows and shows a "not configured" placeholder for
 * the others.
 *
 * Public API:
 *   loadProfile(name)               -> profile | null    (null if dir missing)
 *   saveProfile(name, fields, cert) -> dir               (writes config.json + saml.pem)
 *   listProfiles()                  -> string[]          (names of complete profiles)
 *   setupProfileInteractive(name)   -> Promise<profile>  (CLI prompt flow)
 *
 * A "profile" object is { name, entryPoint, issuer, skipAttributes,
 *                         scimToken, adminEmails, cert }.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const PROFILES_DIR = path.join(__dirname, 'profiles');
const BREAKGLASS_PATH = path.join(PROFILES_DIR, 'breakglass.json');

const KNOWN_FLOWS = ['byo', 'scim'];

// ---------- disk I/O ----------

function ensureProfilesDir() {
    if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

function listProfiles() {
    ensureProfilesDir();
    return fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(name =>
            fs.existsSync(path.join(PROFILES_DIR, name, 'config.json')) &&
            fs.existsSync(path.join(PROFILES_DIR, name, 'saml.pem'))
        )
        .sort();
}

function loadProfile(name) {
    const dir = path.join(PROFILES_DIR, name);
    const configPath = path.join(dir, 'config.json');
    const certPath   = path.join(dir, 'saml.pem');
    if (!fs.existsSync(configPath) || !fs.existsSync(certPath)) return null;

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const cert   = fs.readFileSync(certPath, 'utf8');
    return { name, ...config, cert };
}

function saveProfile(name, { entryPoint, issuer, skipAttributes, scimToken, adminEmails, cert }) {
    const dir = path.join(PROFILES_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ entryPoint, issuer, skipAttributes, scimToken, adminEmails }, null, 2)
    );
    fs.writeFileSync(path.join(dir, 'saml.pem'), cert);
    return dir;
}

// ---------- interactive setup (CLI only — used by `node server.js --setup <name>`) ----------

function makePrompt() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return {
        ask(question, defaultValue = '') {
            const suffix = defaultValue ? ` [${defaultValue}]` : '';
            return new Promise(resolve =>
                rl.question(`${question}${suffix}: `, ans => resolve(ans.trim() || defaultValue))
            );
        },
        async askValidated(question, validate, defaultValue = '') {
            for (;;) {
                const ans = await this.ask(question, defaultValue);
                const err = validate(ans);
                if (!err) return ans;
                console.log(`  ✗ ${err}`);
            }
        },
        close() { rl.close(); }
    };
}

function expandHome(p) {
    if (!p) return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
}

const validators = {
    httpsUrl(v) {
        if (!v) return 'Required';
        if (!/^https:\/\/\S+$/.test(v)) return 'Must be an https:// URL';
        return null;
    },
    issuer(v) {
        if (!v) return 'Required';
        return null;
    },
    certPath(v) {
        const p = expandHome(v);
        if (!p) return 'Path is required';
        if (!fs.existsSync(p)) return `File not found: ${p}`;
        const content = fs.readFileSync(p, 'utf8');
        if (!content.includes('-----BEGIN CERTIFICATE-----')) {
            return 'Not a PEM cert. Convert DER → PEM with: openssl x509 -inform DER -in <file> -out saml.pem';
        }
        return null;
    },
};

async function setupProfileInteractive(name) {
    if (!KNOWN_FLOWS.includes(name)) {
        throw new Error(`Unknown profile name '${name}'. Use one of: ${KNOWN_FLOWS.join(', ')}`);
    }

    ensureProfilesDir();
    const prompt = makePrompt();

    try {
        console.log(`\n=== Configure the '${name}' SAML profile ===\n`);
        if (fs.existsSync(path.join(PROFILES_DIR, name))) {
            const ans = await prompt.ask(`Profile '${name}' already exists. Overwrite? (y/N)`, 'N');
            if (!/^y/i.test(ans)) {
                console.log('Cancelled.');
                return null;
            }
        }

        const flowDescription = name === 'byo'
            ? "BYO entitlements: SAML attribute statements + optional SCIM provisioning"
            : "Governance with SCIM 2.0: SAML SSO + SCIM provisioning";
        console.log(`Flow: ${flowDescription}\n`);

        const entryPoint     = await prompt.askValidated('Okta SSO URL (App Embed Link)', validators.httpsUrl);
        const issuer         = await prompt.askValidated('SP Issuer / Audience URI',
                                                          validators.issuer,
                                                          `http://localhost:1337/${name}`);
        const skipAttributes = await prompt.ask('Skip SAML attributes (comma-separated)',
                                                 'firstName,lastName,email');
        const certPath       = await prompt.askValidated('Path to signing certificate (.cert/.pem)', validators.certPath);

        // Both flows now have a SCIM endpoint at /<flow>/scim/v2; the token is required
        // for SCIM to authenticate Okta. BYO can omit it if you want SAML-only behavior.
        const scimPrompt = name === 'byo'
            ? 'SCIM bearer token (generate with `openssl rand -hex 32`, blank to skip provisioning)'
            : 'SCIM bearer token (generate with `openssl rand -hex 32`)';
        const scimToken = await prompt.ask(scimPrompt, '');

        const adminEmails = await prompt.ask(
            'Admin emails — bootstrap allowlist for /admin (comma-separated, blank for entitlement-only)',
            '');

        const cert = fs.readFileSync(expandHome(certPath), 'utf8');
        const dir  = saveProfile(name, { entryPoint, issuer, skipAttributes, scimToken, adminEmails, cert });
        console.log(`\n✓ Saved profile '${name}' to ${dir}\n`);
        return loadProfile(name);
    } finally {
        prompt.close();
    }
}

// ---------- breakglass admin (local username + password, bypasses SAML) ----------
//
// The breakglass account exists for emergency access when Okta is down or the
// SAML integration is broken. It's a single local user/password — never the
// preferred login path. Stored at profiles/breakglass.json (gitignored, mode 600).
// Password is scrypt-hashed with a per-account random salt; we never store plaintext.

function loadBreakglass() {
    if (!fs.existsSync(BREAKGLASS_PATH)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(BREAKGLASS_PATH, 'utf8'));
        if (!raw || typeof raw !== 'object') return null;
        if (!raw.username || !raw.salt || !raw.hash) return null;
        return raw;
    } catch {
        return null;
    }
}

function saveBreakglass({ username, salt, hash }) {
    ensureProfilesDir();
    fs.writeFileSync(
        BREAKGLASS_PATH,
        JSON.stringify({ username, salt, hash }, null, 2),
        { mode: 0o600 }
    );
    try { fs.chmodSync(BREAKGLASS_PATH, 0o600); } catch {}
    return BREAKGLASS_PATH;
}

function _scryptHash(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derived) => {
            if (err) reject(err);
            else resolve(derived.toString('hex'));
        });
    });
}

async function verifyBreakglassPassword(username, password) {
    const cfg = loadBreakglass();
    if (!cfg || !username || !password) return false;
    if (cfg.username.toLowerCase() !== String(username).toLowerCase()) return false;
    try {
        const expected = Buffer.from(cfg.hash, 'hex');
        const derived  = Buffer.from(await _scryptHash(password, cfg.salt), 'hex');
        return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    } catch {
        return false;
    }
}

async function setupBreakglassInteractive() {
    const prompt = makePrompt();
    try {
        console.log('\n=== Configure the breakglass admin account ===\n');
        console.log("This is a LOCAL username + password that bypasses SAML — used");
        console.log("when Okta is unreachable or the SAML integration is broken.\n");

        if (loadBreakglass()) {
            const ans = await prompt.ask('A breakglass account already exists. Overwrite? (y/N)', 'N');
            if (!/^y/i.test(ans)) {
                console.log('Cancelled.');
                return null;
            }
        }

        const username = await prompt.askValidated(
            'Username (often the operator\'s email)',
            v => v && v.length >= 3 ? null : 'At least 3 chars'
        );
        const password = await prompt.askValidated(
            'Password (min 12 chars)',
            v => v && v.length >= 12 ? null : 'At least 12 chars'
        );
        const confirm  = await prompt.ask('Confirm password');
        if (password !== confirm) {
            console.log("Passwords don't match. Cancelled.");
            return null;
        }

        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await _scryptHash(password, salt);
        const dst  = saveBreakglass({ username, salt, hash });
        console.log(`\n✓ Breakglass account saved for ${username}`);
        console.log(`  → ${dst}  (mode 600)\n`);
        return { username };
    } finally {
        prompt.close();
    }
}

module.exports = {
    KNOWN_FLOWS,
    loadProfile,
    saveProfile,
    listProfiles,
    setupProfileInteractive,
    loadBreakglass,
    saveBreakglass,
    verifyBreakglassPassword,
    setupBreakglassInteractive,
};
