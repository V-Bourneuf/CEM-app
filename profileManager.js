/**
 * Interactive profile manager for the CEM App SAML configuration.
 *
 * Profiles are stored under ./profiles/<name>/ as:
 *   config.json   { entryPoint, issuer, skipAttributes, scimToken }
 *   saml.pem      (Okta signing certificate, PEM-encoded)
 *
 * Public API:
 *   selectOrCreateProfile()   -> Promise<profile>   interactive top-level flow
 *   loadProfile(name)         -> profile            non-interactive load by name
 *   listProfiles()            -> string[]           names of saved profiles
 *
 * A "profile" object is { name, entryPoint, issuer, skipAttributes, scimToken, cert }.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const PROFILES_DIR = path.join(__dirname, 'profiles');

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
    if (!fs.existsSync(configPath)) throw new Error(`Profile '${name}' is missing config.json`);
    if (!fs.existsSync(certPath))   throw new Error(`Profile '${name}' is missing saml.pem`);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const cert   = fs.readFileSync(certPath, 'utf8');
    return { name, ...config, cert };
}

function saveProfile(name, { entryPoint, issuer, skipAttributes, scimToken, adminUser, adminPass, adminEmails, cert }) {
    const dir = path.join(PROFILES_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ entryPoint, issuer, skipAttributes, scimToken, adminUser, adminPass, adminEmails }, null, 2)
    );
    fs.writeFileSync(path.join(dir, 'saml.pem'), cert);
    return dir;
}

// ---------- prompt helpers ----------

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

// ---------- field validators ----------

const validators = {
    name(v) {
        if (!v) return 'Profile name is required';
        if (!/^[A-Za-z0-9_-]+$/.test(v)) return 'Use letters, digits, dashes, underscores only';
        return null;
    },
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

// ---------- interactive create flow ----------

async function createProfile(prompt) {
    console.log('\n=== Create a new profile ===\n');

    const name = await prompt.askValidated('Profile name', validators.name);

    if (fs.existsSync(path.join(PROFILES_DIR, name))) {
        const ans = await prompt.ask(`Profile '${name}' already exists. Overwrite? (y/N)`, 'N');
        if (!/^y/i.test(ans)) {
            console.log('Cancelled.');
            return null;
        }
    }

    const entryPoint     = await prompt.askValidated('Okta Entry Point (App Embed Link)', validators.httpsUrl);
    const issuer         = await prompt.askValidated('SP Issuer / Audience URI', validators.issuer, 'http://localhost:1337/cemapp');
    const skipAttributes = await prompt.ask('Skip SAML attributes (comma-separated)', 'firstName,lastName,email');
    const certPath       = await prompt.askValidated('Path to signing certificate (.cert/.pem)', validators.certPath);
    const scimToken      = await prompt.ask('SCIM bearer token (optional, blank to skip)', '');
    const adminEmails    = await prompt.ask('Admin emails — Okta SAML allowlist for /admin (comma-separated, blank for HTTP basic auth)', '');
    let adminUser = '', adminPass = '';
    if (!adminEmails) {
        adminUser = await prompt.ask('Admin UI username (HTTP basic auth, blank to disable /admin)', '');
        adminPass = adminUser ? await prompt.ask('Admin UI password', '') : '';
    }

    const cert = fs.readFileSync(expandHome(certPath), 'utf8');
    const dir  = saveProfile(name, { entryPoint, issuer, skipAttributes, scimToken, adminUser, adminPass, adminEmails, cert });
    console.log(`\n✓ Saved profile '${name}' to ${dir}\n`);
    return name;
}

// ---------- top-level: pick existing or create new ----------

async function selectOrCreateProfile() {
    ensureProfilesDir();
    const profiles = listProfiles();
    const prompt = makePrompt();

    try {
        let selected;

        if (profiles.length === 0) {
            console.log('\nNo SAML profiles found in ./profiles/. Let\'s set one up.');
            selected = await createProfile(prompt);
            if (!selected) {
                console.log('Aborting startup.');
                process.exit(0);
            }
        } else {
            console.log('\nSAML profiles available:');
            profiles.forEach((p, i) => console.log(`  ${i + 1}) ${p}`));
            const newIdx = profiles.length + 1;
            console.log(`  ${newIdx}) [+] Create new profile`);

            const choice = await prompt.askValidated(
                `Select profile [1-${newIdx}]`,
                v => {
                    const n = parseInt(v, 10);
                    if (isNaN(n) || n < 1 || n > newIdx) return `Enter a number between 1 and ${newIdx}`;
                    return null;
                },
                '1'
            );
            const n = parseInt(choice, 10);
            if (n === newIdx) {
                selected = await createProfile(prompt);
                if (!selected) process.exit(0);
            } else {
                selected = profiles[n - 1];
            }
        }

        return loadProfile(selected);
    } finally {
        prompt.close();
    }
}

module.exports = { selectOrCreateProfile, loadProfile, listProfiles };
