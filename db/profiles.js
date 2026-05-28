/**
 * Entitlement profile catalog.
 *
 * Each profile represents a different business function. Admins enable a
 * profile to add its roles + access entitlements to the live catalog;
 * disabling a profile removes them (and cascades any user grants).
 *
 * The demo dataset uses a kitefoil designer/retailer scenario for
 * illustration — Retail, Engineering & Manufacturing, R&D / Design — plus
 * an Administration profile that grants in-app admin access and a
 * "Software & DevOps" profile for internal platform engineering. Replace
 * with whatever entitlements fit your own use case.
 *
 * Profile structure mirrors db/schema.sql columns one-to-one for entitlements:
 *   id            — slug, unique across the whole catalog
 *   type          — 'role' | 'access'
 *   display_name  — UI label
 *   value         — what flows over SAML/SCIM (snake_case for access, free for role)
 *   column_hint   — optional UI grouping
 *   description   — optional free-text
 *   grants_admin  — when true, granting this entitlement gives the user access
 *                   to the /admin UI (in addition to the bootstrap email allowlist).
 */

const PROFILES = {
    // ─────────────────────────────────────────────────────────────────────
    'administration': {
        id:          'administration',
        name:        'Administration',
        description: 'Grants the holder access to the CEM App admin UI — manage the entitlement catalog, ' +
                     'view provisioned users, and toggle profiles. Use this to delegate admin without ' +
                     'editing the bootstrap email allowlist.',
        entitlements: [
            { id: 'role-app-admin',   type: 'role',   display_name: 'App Admin',         value: 'App Admin',       grants_admin: true,
              description: 'Full administrative access to the CEM App.' },
            { id: 'manage-cem-app',   type: 'access', display_name: 'Manage CEM App',    value: 'manage_cem_app',  grants_admin: true, column_hint: 'admin',
              description: 'Permission to manage the CEM App admin UI.' },
        ],
    },

    // ─────────────────────────────────────────────────────────────────────
    'retail': {
        id:          'retail',
        name:        'Retail & E-commerce',
        description: 'Customer-facing roles: shop floor, online store, returns, after-sales support. ' +
                     'Use this profile for staff who interact with end customers.',
        entitlements: [
            // Roles
            { id: 'role-store-associate',     type: 'role', display_name: 'Store Associate',         value: 'Store Associate' },
            { id: 'role-ecommerce-manager',   type: 'role', display_name: 'E-commerce Manager',      value: 'E-commerce Manager' },
            { id: 'role-cs-rep',              type: 'role', display_name: 'Customer Service Rep',    value: 'Customer Service Rep' },
            { id: 'role-returns-specialist',  type: 'role', display_name: 'Returns Specialist',      value: 'Returns Specialist' },
            // Access
            { id: 'process-pos-sale',         type: 'access', display_name: 'Process POS sale',          value: 'process_pos_sale',         column_hint: 'storeFloor' },
            { id: 'apply-discount',           type: 'access', display_name: 'Apply discount',            value: 'apply_discount',           column_hint: 'storeFloor' },
            { id: 'issue-refund',             type: 'access', display_name: 'Issue refund',              value: 'issue_refund',             column_hint: 'aftermarket' },
            { id: 'handle-warranty-claim',    type: 'access', display_name: 'Handle warranty claim',     value: 'handle_warranty_claim',    column_hint: 'aftermarket' },
            { id: 'update-product-listings',  type: 'access', display_name: 'Update product listings',   value: 'update_product_listings',  column_hint: 'ecommerce' },
            { id: 'manage-promotions',        type: 'access', display_name: 'Manage promotions',         value: 'manage_promotions',        column_hint: 'ecommerce' },
            { id: 'view-sales-dashboard',     type: 'access', display_name: 'View sales dashboard',      value: 'view_sales_dashboard',     column_hint: 'ecommerce' },
            { id: 'access-customer-crm',      type: 'access', display_name: 'Access customer CRM',       value: 'access_customer_crm',      column_hint: 'aftermarket' },
        ],
    },

    // ─────────────────────────────────────────────────────────────────────
    'engineering': {
        id:          'engineering',
        name:        'Engineering & Manufacturing',
        description: 'Production workshop, QA, supply chain, assembly line. ' +
                     'For people who build the kitefoils.',
        entitlements: [
            // Roles
            { id: 'role-production-engineer', type: 'role', display_name: 'Production Engineer',     value: 'Production Engineer' },
            { id: 'role-qa-lead',             type: 'role', display_name: 'QA Lead',                 value: 'QA Lead' },
            { id: 'role-workshop-foreman',    type: 'role', display_name: 'Workshop Foreman',        value: 'Workshop Foreman' },
            { id: 'role-composite-specialist',type: 'role', display_name: 'Composite Specialist',    value: 'Composite Specialist' },
            // Access
            { id: 'approve-production-run',   type: 'access', display_name: 'Approve production run',    value: 'approve_production_run',   column_hint: 'production' },
            { id: 'log-qa-inspection',        type: 'access', display_name: 'Log QA inspection',         value: 'log_qa_inspection',        column_hint: 'production' },
            { id: 'sign-off-batch-release',   type: 'access', display_name: 'Sign off batch release',    value: 'sign_off_batch_release',   column_hint: 'production' },
            { id: 'halt-production-line',     type: 'access', display_name: 'Halt production line',      value: 'halt_production_line',     column_hint: 'production' },
            { id: 'access-workshop-floor',    type: 'access', display_name: 'Access workshop floor',     value: 'access_workshop_floor',    column_hint: 'shopfloor' },
            { id: 'manage-assembly-jigs',     type: 'access', display_name: 'Manage assembly jigs',      value: 'manage_assembly_jigs',     column_hint: 'shopfloor' },
            { id: 'order-raw-materials',      type: 'access', display_name: 'Order raw materials',       value: 'order_raw_materials',      column_hint: 'supplyChain' },
            { id: 'view-manufacturing-kpis',  type: 'access', display_name: 'View manufacturing KPIs',   value: 'view_manufacturing_kpis',  column_hint: 'production' },
        ],
    },

    // ─────────────────────────────────────────────────────────────────────
    'rnd': {
        id:          'rnd',
        name:        'R&D / Design',
        description: 'Naval architecture, hydrofoil design, materials research, prototyping & testing. ' +
                     'Includes test pilots — they ride the foils on the water.',
        entitlements: [
            // Roles
            { id: 'role-senior-designer',     type: 'role', display_name: 'Senior Hydrofoil Designer', value: 'Senior Hydrofoil Designer' },
            { id: 'role-naval-architect',     type: 'role', display_name: 'Naval Architect',           value: 'Naval Architect' },
            { id: 'role-test-pilot',          type: 'role', display_name: 'Test Pilot',                value: 'Test Pilot' },
            { id: 'role-materials-researcher',type: 'role', display_name: 'Materials Researcher',      value: 'Materials Researcher' },
            // Access
            { id: 'edit-cad-designs',         type: 'access', display_name: 'Edit CAD designs',          value: 'edit_cad_designs',         column_hint: 'design' },
            { id: 'request-prototype-build',  type: 'access', display_name: 'Request prototype build',   value: 'request_prototype_build',  column_hint: 'design' },
            { id: 'publish-design-spec',      type: 'access', display_name: 'Publish design spec',       value: 'publish_design_spec',      column_hint: 'design' },
            { id: 'sign-off-design-freeze',   type: 'access', display_name: 'Sign off design freeze',    value: 'sign_off_design_freeze',   column_hint: 'design' },
            { id: 'access-materials-lab',     type: 'access', display_name: 'Access materials lab',      value: 'access_materials_lab',     column_hint: 'lab' },
            { id: 'access-wind-tunnel',       type: 'access', display_name: 'Access wind tunnel',        value: 'access_wind_tunnel',       column_hint: 'lab' },
            { id: 'manage-test-sessions',     type: 'access', display_name: 'Manage on-water test sessions', value: 'manage_test_sessions', column_hint: 'fieldTest' },
            { id: 'view-competitor-intel',    type: 'access', display_name: 'View competitor intel',     value: 'view_competitor_intel',    column_hint: 'design' },
        ],
    },

    // ─────────────────────────────────────────────────────────────────────
    'software-devops': {
        id:          'software-devops',
        name:        'Software & DevOps',
        description: 'Internal platform engineering — the team that builds + operates ' +
                     'the company\'s internal systems (this CEM app, the e-commerce backend, etc.).',
        entitlements: [
            // Roles (legacy seed)
            { id: 'software-dev',         type: 'role', display_name: 'Software Dev',       value: 'Software Dev' },
            { id: 'devops-engineering',   type: 'role', display_name: 'DevOps Engineering', value: 'DevOps Engineering' },
            { id: 'payable',              type: 'role', display_name: 'Accounts Payable',   value: 'payable' },
            { id: 'purchase-role',        type: 'role', display_name: 'Purchasing',         value: 'purchase' },
            // Access — Software Dev
            { id: 'create-feature-branch',       type: 'access', display_name: 'Create feature branch',       value: 'create_feature_branch',        column_hint: 'softwareDev' },
            { id: 'view-build-status',           type: 'access', display_name: 'View build status',           value: 'view_build_status',            column_hint: 'softwareDev' },
            // Access — DevOps
            { id: 'deploy-code-to-prod',         type: 'access', display_name: 'Deploy code to prod',         value: 'deploy_code_to_prod',          column_hint: 'devOps' },
            { id: 'manage-prod-environment',     type: 'access', display_name: 'Manage prod environment',     value: 'manage_prod_environment',      column_hint: 'devOps' },
            { id: 'modify-deployment-pipelines', type: 'access', display_name: 'Modify deployment pipelines', value: 'modify_deployment_pipelines',  column_hint: 'devOps' },
            { id: 'restart-prod-services',       type: 'access', display_name: 'Restart prod services',       value: 'restart_prod_services',        column_hint: 'devOps' },
            // Access — Accounts Payable
            { id: 'credit',  type: 'access', display_name: 'Issue credit',     value: 'credit',  column_hint: 'finance' },
            { id: 'payment', type: 'access', display_name: 'Process payment',  value: 'payment', column_hint: 'finance' },
            // Access — Purchasing
            { id: 'cancel',          type: 'access', display_name: 'Cancel purchase order',  value: 'cancel',   column_hint: 'purchasing' },
            { id: 'purchase-access', type: 'access', display_name: 'Create purchase order',  value: 'purchase', column_hint: 'purchasing' },
            { id: 'return',          type: 'access', display_name: 'Return purchase',        value: 'return',   column_hint: 'purchasing' },
        ],
    },
};

module.exports = { PROFILES };
