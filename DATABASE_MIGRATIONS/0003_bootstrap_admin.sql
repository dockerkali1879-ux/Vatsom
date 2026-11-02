-- ============================================================================
-- VATSOM — Database Role Separation & Safe Administrator Bootstrap
-- Migration: 0003_bootstrap_admin.sql
--
-- PART 1: LEAST-PRIVILEGE DATABASE ROLES (`vatsom_migrator` vs `vatsom_app_runtime`)
--   - `vatsom_migrator`: Used ONLY for executing schema migrations via direct
--     connection (`DIRECT_DATABASE_URL`). Owns schema objects and DDL.
--   - `vatsom_app_runtime`: Used by the Cloudflare Worker / Hyperdrive at
--     runtime (`DATABASE_URL`). Possesses NO DDL (`CREATE`, `DROP`, `ALTER`,
--     `TRUNCATE`) privileges and NO `DELETE` / `UPDATE` privileges on
--     immutable financial or audit ledgers (`order_items`, `order_status_history`,
--     `admin_audit_logs`, `marketing_consent`), nor `DELETE` on `orders` or `customers`.
--
-- PART 2: SAFE ADMINISTRATOR BOOTSTRAP PROCEDURE (Manual Execution Only)
-- ============================================================================

BEGIN;

-- 1. Create dedicated Migration & Runtime roles if they do not already exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vatsom_migrator') THEN
        CREATE ROLE vatsom_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vatsom_app_runtime') THEN
        CREATE ROLE vatsom_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
    END IF;
END
$$;

-- 2. Revoke default PUBLIC schema creation privileges and grant schema usage
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vatsom_app_runtime;
GRANT USAGE ON SCHEMA public TO vatsom_migrator, vatsom_app_runtime;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO vatsom_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO vatsom_migrator;

-- 3. Grant strictly scoped table-by-table DML privileges to `vatsom_app_runtime`
-- Read-only migration version inspection:
GRANT SELECT ON TABLE schema_migrations TO vatsom_app_runtime;

-- Append-only immutable audit & financial history ledgers (SELECT, INSERT only — NO UPDATE, NO DELETE):
GRANT SELECT, INSERT ON TABLE
    order_items,
    order_status_history,
    admin_audit_logs,
    marketing_consent
TO vatsom_app_runtime;

-- Protected operational tables (SELECT, INSERT, UPDATE only — NO DELETE):
GRANT SELECT, INSERT, UPDATE ON TABLE
    customers,
    orders,
    shipment_tracking,
    site_content,
    email_preferences,
    notification_outbox
TO vatsom_app_runtime;

-- Ephemeral / CRUD tables requiring row deletion (sessions, addresses, unused draft products, media, rate-limits):
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    sessions,
    addresses,
    products,
    product_media,
    idempotency_records,
    rate_limit_counters
TO vatsom_app_runtime;

GRANT SELECT, INSERT, DELETE ON TABLE
    consumed_security_tokens
TO vatsom_app_runtime;

INSERT INTO schema_migrations (version, description)
VALUES ('0003_bootstrap_admin', 'Configure least-privilege vatsom_migrator and vatsom_app_runtime roles and admin bootstrap procedure')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- MANUAL ADMINISTRATOR BOOTSTRAP PROCEDURE (Run in Neon SQL Editor after first Google login)
-- ============================================================================
-- SECURITY NOTICE:
-- There is intentionally NO public HTTP endpoint capable of promoting a user
-- to administrator. To establish the first administrator:
--   1. Add the administrator's verified Google email to `ADMIN_ALLOWLIST`
--      via `npx wrangler secret put ADMIN_ALLOWLIST --env staging` (or `--env production`).
--   2. Have the administrator sign in once via Google on the storefront or
--      admin portal so their verified `google_sub` record exists in `customers`.
--   3. Verify the account and run the audited promotion block below (replacing
--      `admin@vatsom.in` with your verified Google email):
--
-- BEGIN;
-- WITH promoted AS (
--     UPDATE customers
--     SET role = 'admin', updated_at = NOW()
--     WHERE email = lower('admin@vatsom.in')
--       AND email_verified = TRUE
--       AND account_status = 'active'
--     RETURNING id, email, google_sub
-- )
-- INSERT INTO admin_audit_logs (
--     admin_customer_id, admin_email, action, target_type, target_id,
--     before_state, after_state, ip_hash, user_agent
-- )
-- SELECT
--     id, email, 'BOOTSTRAP_ADMIN_PROMOTION', 'customer', id::text,
--     '{"role":"customer"}'::jsonb,
--     jsonb_build_object('role', 'admin', 'google_sub', google_sub),
--     repeat('0', 64),
--     'neon-sql-bootstrap'
-- FROM promoted;
-- COMMIT;


