$(document).ready(function () {
    // ---------- header: who's logged in ----------
    $('#user_info').html(`
        <p><b>${user.firstName || ''} ${user.lastName || ''}</b><br/>${user.email || ''}</p>
    `);

    // ---------- normalize SAML attributes ----------
    // Okta sends multi-valued attrs as arrays, single values as strings.
    function asArray(v) {
        if (v == null) return [];
        return Array.isArray(v) ? v : [v];
    }
    const grantedRoles  = asArray(entitlements.role);
    const grantedAccess = asArray(entitlements.access);

    // ---------- catalog lookups (catalog injected by server from catalog.js) ----------
    const accessByValue = {};
    accessCatalog.forEach(a => { accessByValue[a.value] = a; });
    const roleByValue = {};
    roleCatalog.forEach(r => { roleByValue[r.value] = r; });

    // ---------- render: role badges per column ----------
    function roleBadgeFor(roleValue) {
        const meta = roleByValue[roleValue];
        const label = meta ? meta.displayName : roleValue;
        return $('<div>').addClass('role-value').text(label);
    }

    grantedRoles.forEach(role => {
        const lower = String(role).toLowerCase();
        if (lower.includes('devops') || lower.includes('operations')) {
            $('#devOpsContainer').append(roleBadgeFor(role));
        } else {
            $('#softwareDevContainer').append(roleBadgeFor(role));
        }
    });

    // ---------- render: access pills per column, driven by SAML, not hardcoded ----------
    function accessPillFor(accessValue) {
        const meta  = accessByValue[accessValue];
        const label = meta ? meta.displayName : accessValue; // unknown values still render
        return $('<span>').addClass('access-item').text(label);
    }

    const buckets = { softwareDev: [], devOps: [], unknown: [] };
    grantedAccess.forEach(value => {
        const meta = accessByValue[value];
        const col  = (meta && meta.column) || 'unknown';
        (buckets[col] || buckets.unknown).push(value);
    });

    function renderAccessGroup($container, values) {
        if (!values.length) {
            $container.append($('<div>').addClass('no-access-message').text('No access granted'));
            return;
        }
        const wrap = $('<div>').addClass('access-container');
        wrap.append($('<div>').addClass('access-title').text('Access Permissions:'));
        const list = $('<div>').addClass('access-list');
        values.forEach(v => list.append(accessPillFor(v)));
        wrap.append(list);
        $container.append(wrap);
    }

    renderAccessGroup($('#softwareDevContainer'), buckets.softwareDev.concat(buckets.unknown));
    renderAccessGroup($('#devOpsContainer'),      buckets.devOps);
});
