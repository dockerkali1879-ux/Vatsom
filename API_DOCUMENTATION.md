# VATSOM — Production REST API Documentation (`/api/v1`)

All backend API routes are versioned under `/api/v1` and served by the Cloudflare Worker entry point (`src/index.ts`).

---

## 1. Standard Response Envelopes & Security Headers

### 1.1 Success Envelope
```json
{
  "success": true,
  "data": { ... },
  "requestId": "a1b2c3d4e5f60123456789ab"
}
```

### 1.2 Error Envelope
Internal SQL errors, stack traces, and secret configurations are never exposed to clients.
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request payload",
    "details": {
      "issues": [
        { "path": "shippingAddress.pincode", "message": "PIN code must be a valid 6-digit Indian postal code." }
      ]
    }
  },
  "requestId": "a1b2c3d4e5f60123456789ab"
}
```

### 1.3 Authentication & CSRF Rules
- **Session Cookie**: `vatsom_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`). Only its SHA-256 hash is stored in the `sessions` table.
- **CSRF Cookie & Header**: State-changing authenticated endpoints (`POST`, `PUT`, `PATCH`, `DELETE`) require the `X-CSRF-Token` request header to match the session's `csrf_token` (also exposed in the readable `vatsom_csrf` cookie for same-origin JS) and validate the `Origin` header.

---

## 2. Public & Storefront Catalogue Endpoints

### `GET /api/v1/health`
Returns service readiness without leaking infrastructure details.

### `GET /api/v1/public-config`
Returns public-safe client configuration (`googleClientId`, `turnstileSiteKey`, `currency`, `paymentMethods: ["COD"]`).

### `GET /api/v1/products`
Lists active products from PostgreSQL ordered by `sort_priority`, including their 3 gallery plates (`images`) and integer paise pricing (`pricePaise`, `mrpPaise`, plus major unit `price` for UI rendering).
- **Query Parameters**:
  - `division` (optional): `TABLE` | `ATMOSPHERE`
  - `filterTag` (optional): `Edible` | `Aromatic`

### `GET /api/v1/products/:idOrSlug`
Retrieves a single active product by UUID, URL slug, or legacy numeric ID (`1`..`6`).

### `GET /api/v1/media/:mediaId`
Serves binary compressed WebP/PNG/JPEG product images stored in `product_media.binary_data` with immutable browser and edge caching:
- **Response Headers**:
  - `Content-Type: image/webp` (or `image/png`, `image/jpeg`)
  - `Cache-Control: public, max-age=31536000, immutable`
  - `ETag: "<sha256_checksum>"` (supports `If-None-Match` → `304 Not Modified`)

### `GET /api/v1/site-content`
Returns sanitized public storefront copy (`heroBanner`, `heroTitle`, `heroSubtitle`, `manifestoTitle`, `manifestoP1`, `manifestoP2`).

---

## 3. Authentication Endpoints

### `POST /api/v1/auth/google`
Verifies a Google Identity Services ID token (`credential`) on the server using Google's JWKS keys (`https://www.googleapis.com/oauth2/v3/certs`).
- **Validates**: Cryptographic signature, `iss` (`https://accounts.google.com` or `accounts.google.com`), `aud` (`env.GOOGLE_CLIENT_ID`), `exp`, `email_verified === true`, and single-use JWT `jti` replay protection in `consumed_security_tokens`.
- **Rate Limit**: 12 requests / 5 minutes per IP.
- **Request Body**:
```json
{
  "credential": "<Google_JWT_ID_Token>",
  "adminPortalLogin": false,
  "turnstileToken": "<optional_turnstile_token>"
}
```
- **Behaviour**:
  - Creates or updates the `customers` record mapped by `google_sub`.
  - **Privacy Default**: Never subscribes the customer to marketing emails automatically.
  - If `adminPortalLogin: true` and the user is not an allowlisted administrator, returns `403 FORBIDDEN`.
  - Issues `vatsom_session` (`HttpOnly`) and `vatsom_csrf` cookies.

### `GET /api/v1/auth/session`
Returns the currently authenticated customer/admin profile and `csrfToken` (or `authenticated: false`).

### `POST /api/v1/auth/logout`
Requires `X-CSRF-Token`. Marks the server-side session as `revoked_at = NOW()` in PostgreSQL and clears session cookies.

---

## 4. Authenticated Customer Profile & Address Endpoints

### `GET /api/v1/customer/profile`
Returns the authenticated customer's profile, saved addresses, and marketing preferences.

### `PATCH /api/v1/customer/profile`
Updates the authenticated customer's `name` and/or Indian `mobileNumber` (`^(\+91)?[6-9][0-9]{9}$`). Requires `X-CSRF-Token`.

### `GET /api/v1/customer/addresses`
Lists saved delivery addresses belonging to `session.customerId`.

### `POST /api/v1/customer/addresses`
Creates a saved address for `session.customerId`. Enforces a maximum of 10 addresses per customer.

### `PATCH /api/v1/customer/addresses/:addressId`
Updates a saved address. Enforces strict ownership (`WHERE id = $1 AND customer_id = $2`); returns `403 FORBIDDEN` if the address belongs to another customer (IDOR protection).

### `DELETE /api/v1/customer/addresses/:addressId`
Deletes a saved address owned by `session.customerId`. Enforces ownership and prevents IDOR.

---

## 5. Authoritative Cash on Delivery (COD) Order & Tracking Endpoints

### `POST /api/v1/orders`
Places an authoritative **Cash on Delivery (COD)** order.
- **Authentication**: Required (`vatsom_session` + `X-CSRF-Token`).
- **Bot Protection**: Requires a valid, unconsumed Cloudflare Turnstile token (`turnstileToken`).
- **Rate Limit**: 6 requests / 10 minutes per IP & customer.
- **Idempotency**: Requires `idempotencyKey` (8–128 chars). Duplicate submissions return the original order (`200 OK`) without double-charging or double-decrementing stock.
- **Price & Stock Integrity**:
  - Client-supplied `price`, `total`, or `discount` fields are **ignored**.
  - Runs inside a `READ COMMITTED` PostgreSQL transaction acquiring `SELECT ... FOR UPDATE` row locks on `products` in deterministic UUID order.
  - Verifies `is_active = TRUE`, `1 <= quantity <= max_order_quantity`, and `stock_quantity >= quantity`.
  - Decrements `stock_quantity` atomically and snapshots `unit_price_paise` into `order_items`.
- **Request Body**:
```json
{
  "items": [
    { "productId": 1, "quantity": 2 }
  ],
  "shippingAddress": {
    "recipientName": "Aarav Sharma",
    "phoneNumber": "9876543210",
    "addressLine1": "42 Lodhi Estate",
    "addressLine2": "Near India International Centre",
    "city": "New Delhi",
    "state": "Delhi",
    "pincode": "110003",
    "saveToProfile": true
  },
  "customerNotes": "Please call at gate",
  "idempotencyKey": "vts-idem-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "turnstileToken": "<turnstile_token>",
  "marketingOptIn": {
    "optIn": false,
    "table": false,
    "atmosphere": false,
    "newCollections": false
  }
}
```

### `GET /api/v1/orders`
Lists all orders belonging exclusively to the authenticated customer (`WHERE customer_id = $1`), including immutable line items and shipment tracking details.

### `GET /api/v1/orders/:orderNumber`
Returns full details, status timeline (`order_status_history`), and courier tracking (`shipment_tracking`) for a single order owned by the authenticated customer. Attempts to view another customer's order return `403 FORBIDDEN`.

---

## 6. Customer Retention & Marketing Consent Endpoints

### `POST /api/v1/marketing/subscribe`
Records explicit opt-in consent (`explicitConsent: true`) for selected VATSOM segments (`table`, `atmosphere`, `newCollections`, `productUpdates`, `promotionalCampaigns`). Protected by Cloudflare Turnstile and rate limiting.

### `POST /api/v1/marketing/unsubscribe` / `GET /api/v1/marketing/unsubscribe?email=...&token=...`
Verifies the HMAC-SHA256 unsubscribe token (or authenticated session) and immediately revokes marketing consent (`consent_status = 'UNSUBSCRIBED'`, setting all segment flags to `false`).

### `PUT /api/v1/customer/preferences`
Allows an authenticated customer to toggle their granular email preference segments.

---

## 7. Administrative Endpoints (`/api/v1/admin/*`)

All `/api/v1/admin/*` endpoints require:
1. Authenticated session (`vatsom_session`).
2. `X-CSRF-Token` header + valid `Origin` header on state-changing requests.
3. Server-side verification that the user is an `ADMIN` / `SUPER_ADMIN` and permitted by `ADMIN_ALLOWLIST`.
4. Every administrative mutation writes an immutable record to `admin_audit_logs`.

| Method & Path | Description |
| :--- | :--- |
| `GET /api/v1/admin/overview` | Returns KPI metrics (total orders, pending orders, active products, revenue in paise, and recent audit logs). |
| `GET /api/v1/admin/products` | Lists all products (including inactive products and stock counts). |
| `POST /api/v1/admin/products` | Creates a new product folio, validates & stores up to 3 gallery plates, and logs `PRODUCT_CREATE`. |
| `PUT / PATCH /api/v1/admin/products/:id` | Updates a product folio, replaces gallery plates if provided, and logs `PRODUCT_UPDATE`. |
| `DELETE /api/v1/admin/products/:id` | Deletes a product (or archives if referenced by historical orders) and logs `PRODUCT_DELETE`. |
| `POST /api/v1/admin/media` | Validates binary image magic bytes (WebP, PNG, JPEG; rejects SVG/HTML/scripts), stores in `product_media`, and returns `/api/v1/media/:id`. |
| `GET /api/v1/admin/orders` | Lists all customer orders with optional `status` and `search` filters. |
| `PATCH /api/v1/admin/orders/:orderNumber` | Updates order status and/or COD remittance status. Restores product inventory automatically if transitioning to `Cancelled` / `Return to Origin`. Logs `ORDER_STATUS_UPDATE`. |
| `PUT /api/v1/admin/orders/:orderNumber/tracking` | Assigns or updates courier code, courier name, AWB number, tracking URL, and shipment state. Logs `ORDER_TRACKING_UPDATE`. |
| `PUT /api/v1/admin/site-content` | Sanitizes and updates storefront copy (`heroBanner`, `heroTitle`, `heroSubtitle`, `manifestoTitle`, `manifestoP1`, `manifestoP2`) and logs `SITE_CONTENT_UPDATE`. |
| `GET /api/v1/admin/audit-logs` | Returns recent administrative audit trail entries. |
| `POST /api/v1/admin/migrate-legacy` | Sanitizes and imports legacy `localStorage` products and site content into PostgreSQL. |

---

## 8. Courier Tracking Webhook Endpoint

### `POST /api/v1/webhooks/shipment-tracking`
- **Authentication**: Verifies HMAC-SHA256 signature in `X-Vatsom-Signature` computed over `${timestamp}.${rawBody}` using `COURIER_WEBHOOK_SECRET`, with a 5-minute timestamp window and single-use replay guard (`consumed_security_tokens`).
- **Behaviour**: Updates `shipment_tracking`, synchronizes `orders.order_status` (e.g., `DELIVERED`), appends to `order_status_history`, and enqueues customer dispatch notifications.

