# VATSOM — Production Security & Infrastructure Setup Guide

This document details every manual infrastructure step, secret configuration, database migration, and administrator bootstrap procedure required to run the VATSOM ecommerce platform in local development and Cloudflare Workers production.

> **Security Policy**: Real API keys, database credentials, and cryptographic secrets must **never** be committed to Git, stored in `wrangler.toml`, or embedded in frontend HTML/JS bundles.

---

## 1. Prerequisites

- **Node.js**: v20+ LTS
- **Cloudflare Account**: Workers & Pages enabled (with optional Cloudflare Hyperdrive for regional connection pooling)
- **Neon PostgreSQL Account**: PostgreSQL 16+ serverless project (`ap-southeast-1` or nearest region)
- **Google Cloud Console Project**: OAuth 2.0 Web Client ID for Google Identity Services
- **Cloudflare Turnstile**: Managed challenge widget for bot/abuse protection

---

## 2. Step-by-Step External Service Provisioning

### 2.1 Neon PostgreSQL Database & Branch Isolation (Separate from Vaidya Botanicals)
1. Log into [Neon Console](https://console.neon.tech) and create a dedicated project named **`vatsom`** (PostgreSQL 16) — **never share a project, branch, or database with Vaidya Botanicals**.
2. Create three isolated branches inside the `vatsom` project:
   - **`dev` branch** (`vatsom_dev`): Local Wrangler development.
   - **`staging` branch** (`vatsom_staging`): Cloudflare staging deployment (`vatsom-ecommerce-worker-staging`).
   - **`production` branch** (`vatsom_prod`): Live commercial deployment (`vatsom-ecommerce-worker-prod`).
3. Create two separate database roles on each branch (provisioned by `DATABASE_MIGRATIONS/0003_bootstrap_admin.sql`):
   - **`vatsom_migrator`** (Direct Connection String `DIRECT_DATABASE_URL`): Owns schema objects and executes DDL migrations (`0001`, `0002`, `0003`). Never used by the Cloudflare Worker runtime.
   - **`vatsom_app_runtime`** (Pooled Connection String `DATABASE_URL` / Hyperdrive): Least-privilege runtime role with `NOSUPERUSER NOCREATEDB NOCREATEROLE` and table-scoped DML grants only (no `DROP`, `ALTER`, `TRUNCATE`, and no `DELETE`/`UPDATE` on append-only audit/financial ledgers `order_items`, `order_status_history`, `admin_audit_logs`, `marketing_consent`).
4. Ensure SSL enforcement is active (`?sslmode=require`).

### 2.2 Applying Database Migrations (`DATABASE_MIGRATIONS/`)
Run the versioned SQL migration files in strict numerical order against the target Neon branch using `psql` with `DIRECT_DATABASE_URL` (`vatsom_migrator`):

```powershell
# 1. Apply the core 16-table normalized ecommerce & security schema
psql "$env:DIRECT_DATABASE_URL" -f DATABASE_MIGRATIONS/0001_initial_schema.sql

# 2. Seed default site content and the 6 initial elixirs as UNPUBLISHED DRAFTS (is_active = FALSE, stock_quantity = 0)
psql "$env:DIRECT_DATABASE_URL" -f DATABASE_MIGRATIONS/0002_seed_initial_data.sql

# 3. Provision least-privilege roles (vatsom_migrator & vatsom_app_runtime)
psql "$env:DIRECT_DATABASE_URL" -f DATABASE_MIGRATIONS/0003_bootstrap_admin.sql
```

### 2.3 Cloudflare Hyperdrive (Separate per Environment)
Create dedicated Hyperdrive connection pools for **staging** and **production** using the `vatsom_app_runtime` role:
```powershell
# Staging Hyperdrive (connects to Neon `staging` branch as `vatsom_app_runtime`)
npx wrangler hyperdrive create vatsom-hyperdrive-staging --connection-string="postgresql://vatsom_app_runtime:PASSWORD@ep-staging-host.ap-south-1.aws.neon.tech/vatsom_staging?sslmode=require"

# Production Hyperdrive (connects to Neon `production` branch as `vatsom_app_runtime`)
npx wrangler hyperdrive create vatsom-hyperdrive-prod --connection-string="postgresql://vatsom_app_runtime:PASSWORD@ep-prod-host.ap-south-1.aws.neon.tech/vatsom_prod?sslmode=require"
```
Then uncomment `[[env.staging.hyperdrive]]` / `[[env.production.hyperdrive]]` in `wrangler.toml` and insert the respective Hyperdrive Config IDs.

### 2.4 Google Identity Services (OAuth 2.0 Client ID)
1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Configure the OAuth Consent Screen (**External**, App Name: `VATSOM Botanical Atelier`, Scopes: `openid`, `email`, `profile`).
3. Create an **OAuth 2.0 Client ID** of type **Web application**:
   - **Authorized JavaScript origins**:
     - `http://localhost:8787` (local Wrangler dev server)
     - `https://your-production-domain.com`
   - **Authorized redirect URIs**:
     - `http://localhost:8787`
     - `https://your-production-domain.com`
4. Copy the generated **Client ID** (`xxxx.apps.googleusercontent.com`) into `GOOGLE_CLIENT_ID`.

### 2.5 Cloudflare Turnstile Bot Protection
1. Open [Cloudflare Dashboard → Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) and click **Add Widget**.
2. Widget Mode: **Managed** (recommended).
3. Add hostnames: `localhost`, `127.0.0.1`, and your production domain.
4. Copy the **Site Key** (`TURNSTILE_SITE_KEY`, safe for public config) and **Secret Key** (`TURNSTILE_SECRET_KEY`, server-only secret).

---

## 3. Environment Variables & Secrets Configuration

### 3.1 Generating Cryptographic Secrets
Generate strong 256-bit (32-byte hex) secrets for `SESSION_SIGNING_SECRET` and `COURIER_WEBHOOK_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3.2 Local Development (`.dev.vars`)
Copy `.dev.vars.example` to `.dev.vars` (which is ignored by `.gitignore`) and populate your values:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Required variables in `.dev.vars`:
| Variable | Sensitivity | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | **Secret** | Neon PostgreSQL pooled connection URI (`?sslmode=require`) |
| `GOOGLE_CLIENT_ID` | Public / Config | Google OAuth 2.0 Web Client ID verified by `src/security/google-auth.ts` |
| `TURNSTILE_SITE_KEY` | Public / Config | Cloudflare Turnstile widget Site Key served via `/api/v1/public-config` |
| `TURNSTILE_SECRET_KEY` | **Secret** | Cloudflare Turnstile server-side Siteverify secret |
| `SESSION_SIGNING_SECRET` | **Secret** | 64-char hex secret used for HMAC-SHA256 unsubscribe tokens & session defence |
| `ADMIN_ALLOWLIST` | **Secret** | Comma-separated lowercase emails or `sub:` Google subject IDs permitted to access Admin routes |
| `COURIER_WEBHOOK_SECRET` | **Secret** | HMAC-SHA256 shared secret for authenticating `/api/v1/webhooks/shipment-tracking` |
| `EMAIL_PROVIDER_API_KEY` | **Secret** | API key for transactional email delivery (`resend` / `postmark`) |

### 3.3 Production Cloudflare Workers Secrets
Never place secrets in `wrangler.toml`. Upload each secret directly to Cloudflare's encrypted secret store:

```powershell
npx wrangler secret put DATABASE_URL
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put SESSION_SIGNING_SECRET
npx wrangler secret put ADMIN_ALLOWLIST
npx wrangler secret put COURIER_WEBHOOK_SECRET
npx wrangler secret put EMAIL_PROVIDER_API_KEY
```

---

## 4. Bootstrapping the First Administrator Account

VATSOM enforces **dual-layer administrative authorization**:
1. The user's verified Google email or Google `sub` ID must be listed in `ADMIN_ALLOWLIST` (or their database row must hold `role = 'ADMIN'` / `'SUPER_ADMIN'`).
2. Every `/api/v1/admin/*` request validates the `HttpOnly` session cookie, session expiry/revocation state, `X-CSRF-Token` header, `Origin` header, and server-side administrator status.

### Procedure:
1. Add your Google email address (e.g. `founder@vatsom.com`) to `ADMIN_ALLOWLIST`.
2. Sign in once via `admin-portal.html` using Google Sign-In. Because your verified email matches `ADMIN_ALLOWLIST`, the backend automatically provisions/elevates your `customers` record to `role = 'ADMIN'` and logs the `ADMIN_LOGIN` event in `admin_audit_logs`.
3. Alternatively, you can manually promote an existing account in SQL using `DATABASE_MIGRATIONS/0003_bootstrap_admin.sql`.

---

## 5. Migrating Legacy `localStorage` Data

If your browser contains legacy prototype data (`vatsom_products_v1`, `vatsom_orders_v1`, `vatsom_site_content_v1`):
1. Open `/admin-portal.html` and sign in as an Administrator.
2. Click the **"MIGRATE CACHE"** button in the top navigation bar.
3. The portal sends the legacy cache to `POST /api/v1/admin/migrate-legacy` with your CSRF token, sanitizing and importing custom products and site content into PostgreSQL and recording an `admin_audit_logs` entry.

---

## 6. Running, Testing, and Deploying

```powershell
# Run the automated security & regression test suite (31 tests)
npm.cmd test

# Sync static assets to ./public and run TypeScript typecheck
npm.cmd run build

# Start local Cloudflare Worker development server on http://localhost:8787
npm.cmd run dev

# Deploy manually to Cloudflare Workers (when ready for production)
npm.cmd run deploy
```

