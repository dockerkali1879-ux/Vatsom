-- ============================================================================
-- VATSOM — Production PostgreSQL Schema Migration
-- Migration: 0001_initial_schema.sql
-- Target: Neon PostgreSQL (PostgreSQL 15+)
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Track applied schema migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    checksum_sha256 TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Automatic updated_at timestamp trigger function
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 1. CUSTOMERS
-- ============================================================================
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_sub TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 160),
    email TEXT UNIQUE NOT NULL CHECK (email = lower(trim(email)) AND char_length(email) <= 254),
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    mobile_number TEXT CHECK (mobile_number IS NULL OR mobile_number ~ '^(\+91)?[6-9][0-9]{9}$'),
    role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
    account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_role_status ON customers(role, account_status);

DROP TRIGGER IF EXISTS set_customers_updated_at ON customers;
CREATE TRIGGER set_customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================================
-- 2. SESSIONS (Stores only SHA-256 hashes of session & CSRF tokens)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash CHAR(64) UNIQUE NOT NULL,
    csrf_token_hash CHAR(64) NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    session_scope TEXT NOT NULL DEFAULT 'customer' CHECK (session_scope IN ('customer', 'admin')),
    ip_hash CHAR(64),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    CONSTRAINT chk_session_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_sessions_customer_active
    ON sessions(customer_id, expires_at)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ============================================================================
-- 3. ADDRESSES (Indian PIN code & mobile validation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    recipient_name TEXT NOT NULL CHECK (char_length(trim(recipient_name)) BETWEEN 2 AND 120),
    phone_number TEXT NOT NULL CHECK (phone_number ~ '^(\+91)?[6-9][0-9]{9}$'),
    address_line1 TEXT NOT NULL CHECK (char_length(trim(address_line1)) BETWEEN 3 AND 250),
    address_line2 TEXT CHECK (address_line2 IS NULL OR char_length(address_line2) <= 250),
    landmark TEXT CHECK (landmark IS NULL OR char_length(landmark) <= 150),
    city TEXT NOT NULL CHECK (char_length(trim(city)) BETWEEN 2 AND 100),
    state TEXT NOT NULL CHECK (char_length(trim(state)) BETWEEN 2 AND 100),
    pin_code CHAR(6) NOT NULL CHECK (pin_code ~ '^[1-9][0-9]{5}$'),
    address_type TEXT NOT NULL DEFAULT 'home' CHECK (address_type IN ('home', 'atelier', 'office', 'other')),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_addresses_customer_id ON addresses(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_addresses_single_default_per_customer
    ON addresses(customer_id)
    WHERE is_default = TRUE;

DROP TRIGGER IF EXISTS set_addresses_updated_at ON addresses;
CREATE TRIGGER set_addresses_updated_at
    BEFORE UPDATE ON addresses
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================================
-- 4. PRODUCTS (All monetary values stored strictly in integer INR paise)
-- ============================================================================
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_numeric_id INTEGER UNIQUE,
    slug TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 140),
    sku TEXT UNIQUE NOT NULL CHECK (char_length(trim(sku)) BETWEEN 3 AND 64),
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 180),
    division TEXT NOT NULL CHECK (division IN ('TABLE', 'ATMOSPHERE')),
    category TEXT NOT NULL CHECK (char_length(trim(category)) BETWEEN 2 AND 120),
    description TEXT NOT NULL CHECK (char_length(trim(description)) BETWEEN 10 AND 1200),
    long_description TEXT CHECK (long_description IS NULL OR char_length(long_description) <= 4000),
    price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
    mrp_paise INTEGER NOT NULL CHECK (mrp_paise >= price_paise),
    volume_label TEXT NOT NULL CHECK (char_length(trim(volume_label)) BETWEEN 2 AND 40),
    volume_ml INTEGER CHECK (volume_ml IS NULL OR (volume_ml > 0 AND volume_ml <= 10000)),
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    track_inventory BOOLEAN NOT NULL DEFAULT TRUE,
    stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    max_order_quantity INTEGER NOT NULL DEFAULT 5 CHECK (max_order_quantity BETWEEN 1 AND 20),
    sort_priority INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_active_sort
    ON products(is_active, division, sort_priority ASC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_legacy_id ON products(legacy_numeric_id);

DROP TRIGGER IF EXISTS set_products_updated_at ON products;
CREATE TRIGGER set_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================================
-- 5. PRODUCT MEDIA (3-Plate Gallery: Plate 0, Plate 1, Plate 2)
-- Dedicated BYTEA column for small compressed WebP uploads; never inside JSON
-- ============================================================================
CREATE TABLE IF NOT EXISTS product_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    plate_index SMALLINT NOT NULL CHECK (plate_index IN (0, 1, 2)),
    media_url TEXT CHECK (media_url IS NULL OR char_length(media_url) <= 1024),
    alt_text TEXT NOT NULL DEFAULT '' CHECK (char_length(alt_text) <= 250),
    mime_type TEXT NOT NULL DEFAULT 'image/webp' CHECK (mime_type IN ('image/webp', 'image/png', 'image/jpeg')),
    width_px INTEGER CHECK (width_px IS NULL OR (width_px BETWEEN 1 AND 2048)),
    height_px INTEGER CHECK (height_px IS NULL OR (height_px BETWEEN 1 AND 2048)),
    file_size_bytes INTEGER CHECK (file_size_bytes IS NULL OR (file_size_bytes BETWEEN 1 AND 524288)),
    sha256_hex CHAR(64),
    webp_binary BYTEA CHECK (webp_binary IS NULL OR octet_length(webp_binary) <= 524288),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (product_id, plate_index)
);

CREATE INDEX IF NOT EXISTS idx_product_media_product_plate ON product_media(product_id, plate_index);

DROP TRIGGER IF EXISTS set_product_media_updated_at ON product_media;
CREATE TRIGGER set_product_media_updated_at
    BEFORE UPDATE ON product_media
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================================
-- 6. ORDERS (COD Authoritative Transaction Ledger)
-- ============================================================================
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_order_ref TEXT UNIQUE NOT NULL CHECK (public_order_ref ~ '^VTS-[A-Z0-9-]{6,24}$'),
    tracking_token_hash CHAR(64) UNIQUE NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    address_snapshot JSONB NOT NULL,
    order_status TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION' CHECK (
        order_status IN (
            'PENDING_CONFIRMATION',
            'CONFIRMED',
            'PROCESSING',
            'PACKED',
            'DISPATCHED',
            'OUT_FOR_DELIVERY',
            'DELIVERED',
            'CANCELLED',
            'RETURN_TO_ORIGIN'
        )
    ),
    admin_status_label TEXT NOT NULL DEFAULT 'Pending Seal' CHECK (
        admin_status_label IN (
            'Pending Seal',
            'In Extraction',
            'Dispatched',
            'Delivered',
            'Cancelled'
        )
    ),
    payment_method TEXT NOT NULL DEFAULT 'COD' CHECK (payment_method = 'COD'),
    cod_remittance_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
        cod_remittance_status IN ('PENDING', 'COLLECTED_BY_COURIER', 'REMITTED_TO_VATSOM', 'VOIDED')
    ),
    cod_remitted_at TIMESTAMPTZ,
    cod_remittance_reference TEXT,
    subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
    tax_paise INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
    delivery_charge_paise INTEGER NOT NULL DEFAULT 0 CHECK (delivery_charge_paise >= 0),
    discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
    final_amount_paise INTEGER NOT NULL CHECK (
        final_amount_paise >= 0
        AND final_amount_paise = subtotal_paise + tax_paise + delivery_charge_paise - discount_paise
    ),
    cod_amount_due_paise INTEGER NOT NULL CHECK (cod_amount_due_paise >= 0),
    stock_restored BOOLEAN NOT NULL DEFAULT FALSE,
    customer_notes TEXT CHECK (customer_notes IS NULL OR char_length(customer_notes) <= 500),
    cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) <= 500),
    cancelled_by TEXT,
    cancelled_at TIMESTAMPTZ,
    fulfilled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(order_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_admin_label_created ON orders(admin_status_label, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_public_ref ON orders(public_order_ref);

DROP TRIGGER IF EXISTS set_orders_updated_at ON orders;
CREATE TRIGGER set_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================================
-- 7. ORDER ITEMS (Immutable historical product & price snapshot)
-- ============================================================================
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name_snapshot TEXT NOT NULL,
    sku_snapshot TEXT NOT NULL,
    volume_snapshot TEXT NOT NULL,
    division_snapshot TEXT NOT NULL CHECK (division_snapshot IN ('TABLE', 'ATMOSPHERE')),
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
    unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
    line_total_paise INTEGER NOT NULL CHECK (line_total_paise = unit_price_paise * quantity),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);

-- ============================================================================
-- 8. ORDER STATUS HISTORY
-- ============================================================================
CREATE TABLE IF NOT EXISTS order_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    previous_status TEXT,
    new_status TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system', 'courier_webhook')),
    actor_id TEXT,
    notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id, created_at ASC);

-- ============================================================================
-- 9. SHIPMENT TRACKING
-- ============================================================================
CREATE TABLE IF NOT EXISTS shipment_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    courier_code TEXT NOT NULL CHECK (char_length(trim(courier_code)) BETWEEN 2 AND 50),
    courier_name TEXT NOT NULL CHECK (char_length(trim(courier_name)) BETWEEN 2 AND 100),
    awb_number TEXT NOT NULL CHECK (char_length(trim(awb_number)) BETWEEN 3 AND 80),
    tracking_url TEXT CHECK (tracking_url IS NULL OR tracking_url ~ '^https?://'),
    current_shipment_state TEXT NOT NULL DEFAULT 'MANIFESTED',
    estimated_delivery_at TIMESTAMPTZ,
    last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipment_tracking_awb ON shipment_tracking(awb_number);

DROP TRIGGER IF EXISTS set_shipment_tracking_updated_at ON shipment_tracking;
CREATE TRIGGER set_shipment_tracking_updated_at
    BEFORE UPDATE ON shipment_tracking
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================================
-- 10. SITE CONTENT (Editable Storefront Hero & Manifesto Inscriptions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS site_content (
    key TEXT PRIMARY KEY CHECK (key = 'primary'),
    hero_banner TEXT NOT NULL CHECK (char_length(trim(hero_banner)) BETWEEN 2 AND 200),
    hero_title_html TEXT NOT NULL CHECK (char_length(trim(hero_title_html)) BETWEEN 2 AND 400),
    hero_subtitle TEXT NOT NULL CHECK (char_length(trim(hero_subtitle)) BETWEEN 5 AND 800),
    manifesto_title TEXT NOT NULL CHECK (char_length(trim(manifesto_title)) BETWEEN 2 AND 250),
    manifesto_p1 TEXT NOT NULL CHECK (char_length(trim(manifesto_p1)) BETWEEN 5 AND 1500),
    manifesto_p2 TEXT NOT NULL CHECK (char_length(trim(manifesto_p2)) BETWEEN 5 AND 1500),
    promotional_banner JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by UUID REFERENCES customers(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 11. MARKETING CONSENT AUDIT LOG (Explicit Opt-In & Withdrawal Ledger)
-- ============================================================================
CREATE TABLE IF NOT EXISTS marketing_consent (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    email TEXT NOT NULL CHECK (email = lower(trim(email))),
    consent_category TEXT NOT NULL CHECK (
        consent_category IN (
            'TABLE',
            'ATMOSPHERE',
            'NEW_COLLECTIONS',
            'PRODUCT_UPDATES',
            'PROMOTIONAL_CAMPAIGNS'
        )
    ),
    consent_state TEXT NOT NULL CHECK (consent_state IN ('OPTED_IN', 'OPTED_OUT')),
    policy_version TEXT NOT NULL,
    consent_source TEXT NOT NULL,
    ip_hash CHAR(64),
    consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    withdrawn_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_marketing_consent_email ON marketing_consent(email, consented_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_consent_customer ON marketing_consent(customer_id);

-- ============================================================================
-- 12. EMAIL PREFERENCES & SUPPRESSION LIST
-- ============================================================================
CREATE TABLE IF NOT EXISTS email_preferences (
    email TEXT PRIMARY KEY CHECK (email = lower(trim(email))),
    customer_id UUID UNIQUE REFERENCES customers(id) ON DELETE SET NULL,
    sub_table BOOLEAN NOT NULL DEFAULT FALSE,
    sub_atmosphere BOOLEAN NOT NULL DEFAULT FALSE,
    sub_new_collections BOOLEAN NOT NULL DEFAULT FALSE,
    sub_product_updates BOOLEAN NOT NULL DEFAULT FALSE,
    sub_promotional_campaigns BOOLEAN NOT NULL DEFAULT FALSE,
    is_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
    suppression_reason TEXT,
    unsubscribe_token_hash CHAR(64) UNIQUE NOT NULL,
    policy_version TEXT NOT NULL DEFAULT '2026.11',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_preferences_segments
    ON email_preferences(sub_table, sub_atmosphere)
    WHERE is_suppressed = FALSE;

DROP TRIGGER IF EXISTS set_email_preferences_updated_at ON email_preferences;
CREATE TRIGGER set_email_preferences_updated_at
    BEFORE UPDATE ON email_preferences
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================================
-- 13. ADMINISTRATIVE AUDIT LOGS
-- ============================================================================
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    admin_email TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_state JSONB,
    after_state JSONB,
    ip_hash CHAR(64),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin ON admin_audit_logs(admin_customer_id, created_at DESC);

-- ============================================================================
-- 14. IDEMPOTENCY RECORDS (Prevents Duplicate Checkout & Replayed Mutations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS idempotency_records (
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
    request_hash CHAR(64) NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    locked_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_records(expires_at);

-- ============================================================================
-- 15. NOTIFICATION OUTBOX (Durable Transactional & Promotional Email Queue)
-- ============================================================================
CREATE TABLE IF NOT EXISTS notification_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel TEXT NOT NULL DEFAULT 'EMAIL' CHECK (channel IN ('EMAIL')),
    message_category TEXT NOT NULL CHECK (message_category IN ('TRANSACTIONAL', 'PROMOTIONAL')),
    template_name TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    dedupe_key TEXT UNIQUE NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SUPPRESSED', 'PROVIDER_NOT_CONFIGURED')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    provider_message_id TEXT,
    delivery_events JSONB NOT NULL DEFAULT '[]'::jsonb,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
    ON notification_outbox(status, next_attempt_at ASC)
    WHERE status IN ('PENDING', 'FAILED', 'PROVIDER_NOT_CONFIGURED', 'PROCESSING');

DROP TRIGGER IF EXISTS set_notification_outbox_updated_at ON notification_outbox;
CREATE TRIGGER set_notification_outbox_updated_at
    BEFORE UPDATE ON notification_outbox
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================================
-- 16. APPLICATION-LEVEL RATE LIMIT COUNTERS & TURNSTILE REPLAY GUARD
-- ============================================================================
CREATE TABLE IF NOT EXISTS rate_limit_counters (
    bucket_key TEXT PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_expires ON rate_limit_counters(expires_at);

CREATE TABLE IF NOT EXISTS consumed_security_tokens (
    token_hash CHAR(64) PRIMARY KEY,
    token_type TEXT NOT NULL CHECK (token_type IN ('TURNSTILE', 'GOOGLE_ID_TOKEN', 'COURIER_WEBHOOK')),
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumed_tokens_expires ON consumed_security_tokens(expires_at);

INSERT INTO schema_migrations (version, description)
VALUES ('0001_initial_schema', 'Initial normalized VATSOM ecommerce & security schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;

