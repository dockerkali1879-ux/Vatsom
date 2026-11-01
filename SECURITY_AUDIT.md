# VATSOM — Security & Architectural Audit Report

---

## 1. Phase 1 Technical Audit of Legacy Prototype

Before implementing the production backend, a comprehensive line-by-line audit was conducted across `vatsom_premium_oils.html`, `admin-portal.html`, and `paper_crumple_effect.js`.

### 1.1 Legacy `localStorage` Data Structures Inspected
| Key | Used By | Legacy Behaviour & Architectural Flaw |
| :--- | :--- | :--- |
| `vatsom_products_v1` | Storefront & Admin | Stored entire product array and raw Base64 data URLs inside browser `localStorage` (5 MB limit), invisible to any other device or visitor. |
| `vatsom_orders_v1` | Storefront & Admin | Generated fake order IDs (`VTS-` + `Math.random()`) in the client browser; never transmitted to a server. |
| `vatsom_site_content_v1` | Storefront & Admin | Editorial changes made in `admin-portal.html` only mutated the admin's local browser storage. |

### 1.2 Critical Security Vulnerabilities Identified in the Legacy Frontend
1. **Zero Administrative Authentication (`CRITICAL`)**: `admin-portal.html` had no authentication gate, session check, or server-side authorization. Anyone opening the URL had full access to view/modify local state.
2. **Client-Trusted Pricing & Order Totals (`CRITICAL`)**: `sealOrderParchment()` calculated order totals directly from client-side JavaScript arrays (`item.price * item.qty`) with zero server-side validation, allowing trivial price tampering (`₹0.00` orders).
3. **No Customer Identity or Tenant Isolation (`HIGH`)**: Orders had no authenticated customer identity, delivery address validation, or ownership checks (IDOR vulnerability if naively connected to a database).
4. **Stored DOM XSS in Catalogue & Content Rendering (`HIGH`)**: Product titles, descriptions, badges, and image URLs were interpolated directly into `.innerHTML` template literals without HTML entity encoding or URL scheme whitelisting (`javascript:` URI risk).
5. **Unvalidated File Uploads & Storage Exhaustion (`HIGH`)**: `handleImageFileUpload` used `FileReader.readAsDataURL` without checking binary magic bytes (permitting malicious `.svg` scripts) or compressing images.
6. **Zero Bot, Abuse, or Replay Protection (`HIGH`)**: Checkout had no Cloudflare Turnstile verification, no rate limiting, and no idempotency key protection against duplicate order floods.
7. **Floating-Point Currency Representation (`MEDIUM`)**: Prices were stored as JavaScript floats (`68.00`) rather than integer minor units (`paise`), risking IEEE-754 rounding discrepancies.

---

## 2. Production Security Architecture & Mitigations Implemented

### 2.1 Google Identity Services & Hardened Session Management
- **Server-Side JWT Verification (`src/security/google-auth.ts`)**: Verifies Google ID tokens against Google's official JWKS endpoint (`https://www.googleapis.com/oauth2/v3/certs`), enforcing `iss`, `aud` (`GOOGLE_CLIENT_ID`), `exp`, `email_verified === true`, and single-use `jti` token replay prevention (`consumed_security_tokens`).
- **Hashed Session Tokens (`src/security/session.ts`)**: 256-bit CSPRNG session tokens are issued via `HttpOnly; Secure; SameSite=Lax` cookies (`vatsom_session`). Only the **SHA-256 digest** (`token_hash`) is persisted in PostgreSQL (`sessions`), neutralizing database read leaks.
- **CSRF & Origin Defense**: Every state-changing authenticated route (`POST`, `PUT`, `PATCH`, `DELETE`) validates the `X-CSRF-Token` header against the session's `csrf_token` using constant-time comparison (`timingSafeEqualString`) and verifies the `Origin` header.

### 2.2 Strict Authorization & IDOR Prevention
- **Customer Isolation (`src/services/order-service.ts`, `src/services/customer-service.ts`)**: Every customer query and mutation scopes SQL `WHERE` clauses by `session.customerId`. Attempts by Customer B to view Customer A's order or mutate Customer A's address return `403 FORBIDDEN`.
- **Dual-Layer Admin Enforcement (`src/security/session.ts`)**: Every `/api/v1/admin/*` route verifies both database role (`ADMIN` / `SUPER_ADMIN`) and presence in the server-side `ADMIN_ALLOWLIST` secret. Clients cannot self-assign roles (`CustomerProfileUpdateSchema.strict()` rejects role fields).
- **Immutable Admin Audit Trail (`admin_audit_logs`)**: Every admin login, product create/update/delete, order status change, tracking update, and site content edit records actor ID, IP hash, before/after JSON snapshots, and request ID.

### 2.3 Authoritative Cash on Delivery (COD) Order Engine & Concurrency Safety
- **Server-Authoritative Integer Paise Pricing**: All monetary columns (`price_paise`, `mrp_paise`, `unit_price_paise`, `subtotal_paise`, `total_paise`, `cod_collectible_amount_paise`) are stored and calculated strictly as integer INR paise (`1 INR = 100 paise`). Client-supplied prices/totals are ignored.
- **Pessimistic Row-Level Locking (`FOR UPDATE`)**: Checkout runs inside a PostgreSQL transaction (`db.withTransaction`), sorting product UUIDs deterministically to prevent deadlocks and locking inventory rows with `SELECT ... FOR UPDATE`.
- **Atomic Stock Reservation & Restoration**: Stock is checked and decremented atomically inside the checkout transaction. When an order transitions to `CANCELLED` or `RETURN_TO_ORIGIN`, reserved inventory is atomically restored (`inventory_restored = TRUE`) exactly once.
- **Idempotency Guarantee**: `idempotency_records` prevents duplicate order creation on network retries or double-clicks.

### 2.4 Bot Protection, Rate Limiting & Binary Image Validation
- **Cloudflare Turnstile (`src/security/turnstile.ts`)**: Verified server-side via Cloudflare Siteverify API (`https://challenges.cloudflare.com/turnstile/v0/siteverify`) with SHA-256 single-use token replay protection.
- **Persistent Multi-Dimensional Rate Limiting (`src/security/rate-limit.ts`)**: Enforces sliding-window counters across IP hash and account ID for `/auth/google`, `/orders`, `/marketing/subscribe`, and `/admin/*`, returning `429 Too Many Requests` with `Retry-After`.
- **Binary Magic-Byte Image Verification (`src/validation/schemas.ts`)**: Inspects raw binary headers for WebP (`RIFF....WEBP`), PNG (`89 50 4E 47`), and JPEG (`FF D8 FF`), explicitly scanning for and rejecting `<svg`, `<script`, and executable payloads. Serves images from `/api/v1/media/:mediaId` with `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`.

---

## 3. Automated Security & Regression Test Verification

All 31 automated tests in `tests/backend-security-and-ecommerce.test.ts` and `tests/frontend-regression.test.ts` pass (`npm.cmd test`), and `npm.cmd audit` reports **0 dependency vulnerabilities**:

| Test Category | Verified Scenarios | Result |
| :--- | :--- | :--- |
| **1. Authentication Security** | Valid Google login, invalid signature (`401`), expired token (`401`), wrong audience (`401`), unverified email (`401`), replayed token (`401`), session revocation on logout, non-admin blocked from Admin Portal (`403`), no forced marketing opt-in | **8 / 8 Passed** |
| **2. Authorization & IDOR** | Customer B blocked from Customer A's order (`403`), Customer B blocked from modifying/deleting Customer A's address (`403`), privilege escalation blocked (`400`/`403`) | **3 / 3 Passed** |
| **3. COD Order & Concurrency** | Client price tampering ignored, invalid/excess quantities rejected, idempotency key deduplication, `Promise.all` concurrent checkout oversell prevention, cancellation stock restoration & historical price snapshot preservation | **5 / 5 Passed** |
| **4. Abuse, Turnstile & Rate Limits** | Missing/invalid/expired/replayed Turnstile tokens rejected (`403`), HTTP `429` with `Retry-After` on rate-limit breach, HTTP `413` on oversized payload | **3 / 3 Passed** |
| **5. Database Integrity & Rollback** | All 16 normalized tables & constraints verified, full transaction rollback on mid-checkout failure, sanitized error responses (`ECONNREFUSED` never leaked) | **2 / 2 Passed** |
| **6. Admin Security & Webhooks** | Admin CRUD with `X-CSRF-Token`, SVG upload blocked (`400`), XSS stripped from site content, `admin_audit_logs` recorded, HMAC-SHA256 courier webhook verification & replay protection | **2 / 2 Passed** |
| **7. Frontend Preservation** | Obsidian/parchment palette, Cinzel/Playfair/Jakarta typography, Origami V emblem, Three.js `<PaperCrumple />`, Lenis scroll, 3D paper tilt, 3-plate gallery modal, COD checkout modal, `./public` asset isolation | **8 / 8 Passed** |

---

## 4. Residual Risks & Operational Recommendations

1. **Cash on Delivery (COD) Return-to-Origin (RTO) Fraud**: Because COD orders do not collect upfront payment, high-value orders may still face fake-address or refusal-at-doorstep risk despite Turnstile, Google Auth, Indian PIN/phone validation, and per-account rate limits. **Recommendation**: For first-time patrons ordering above ₹5,000, keep initial status in `PENDING_CONFIRMATION` and perform a quick automated WhatsApp/IVR or concierge phone confirmation before moving to `CONFIRMED` / `DISPATCHED`.
2. **Database Binary Media Growth (`BYTEA`)**: Storing compressed WebP images in `product_media.binary_data` (capped at 450 KB/image, compressed client-side to ~40–100 KB WebP, and cached for 1 year at the Cloudflare edge via `Cache-Control: immutable`) is ideal for a curated catalogue of 6–100 luxury skus without requiring external object storage. If the catalogue scales beyond several thousand multi-megabyte assets, consider migrating media blobs to dedicated object storage behind the existing `/api/v1/media/:id` route.
3. **Notification Outbox Worker Scheduling**: Transactional emails are recorded atomically in `notification_outbox` and dispatched via the configured provider (`RESEND` or `POSTMARK`). Configure a Cloudflare Cron Trigger (`[triggers] crons = ["*/5 * * * *"]`) if you wish to automatically retry `RETRY_SCHEDULED` outbox rows when an external email provider experiences transient downtime.

