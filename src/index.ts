import { generateSecureToken, sha256Hex } from './crypto';
import { resolveDatabaseClient } from './db/client';
import { NotFoundError, ValidationError } from './errors';
import { buildSecurityHeaders, jsonError, jsonSuccess } from './response';
import { verifyGoogleIdToken } from './security/google-auth';
import { enforceRateLimits } from './security/rate-limit';
import {
  clearSessionCookies,
  issueSession,
  requireAuthenticatedAdmin,
  requireAuthenticatedCustomer,
  resolveRequestSession,
  resolveVerifiedCsrfCookie,
  verifyCloudflareAccessJwt
} from './security/session';
import { verifyTurnstileToken } from './security/turnstile';
import {
  getSiteContent,
  listAdminAuditLogs,
  migrateLegacyLocalStorageData,
  updateSiteContent
} from './services/admin-service';
import {
  createCustomerAddress,
  deleteCustomerAddress,
  listCustomerAddresses,
  updateCustomerAddress,
  updateCustomerProfile,
  upsertCustomerFromGoogle
} from './services/customer-service';
import {
  createCodOrder,
  getCustomerOrderById,
  getOrderByTrackingReference,
  handleCourierWebhook,
  listAdminOrders,
  listCustomerOrders,
  updateAdminOrderStatus,
  updateAdminOrderTracking
} from './services/order-service';
import {
  createAdminProduct,
  deleteOrArchiveAdminProduct,
  getProductMediaBinary,
  getPublicProductBySlugOrId,
  listAdminProducts,
  listPublicProducts,
  updateAdminProduct
} from './services/product-service';
import {
  getCustomerMarketingPreferences,
  getNotificationOutboxMonitoring,
  processNotificationOutboxBatch,
  purgeExpiredSecurityAndSessionRecords,
  subscribeMarketing,
  unsubscribeMarketing,
  updateCustomerMarketingPreferences
} from './services/retention-service';
import { Division, Env, RequestContext } from './types';
import {
  AddressCreateSchema,
  AddressUpdateSchema,
  AdminOrderUpdateSchema,
  AdminProductInputSchema,
  AdminProductUpdateSchema,
  AdminSiteContentSchema,
  AdminTrackingUpdateSchema,
  CodCheckoutRequestSchema,
  CustomerProfileUpdateSchema,
  GoogleAuthRequestSchema,
  LocalStorageMigrationSchema,
  MarketingPreferencesUpdateSchema,
  MarketingSubscribeSchema,
  MarketingUnsubscribeSchema,
  parseAndValidateJson
} from './validation/schemas';

function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]!;
    const v = pathParts[i]!;
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(v);
    } else if (p !== v) {
      return null;
    }
  }
  return params;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const requestId = generateSecureToken(12);
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();
    const method = request.method.toUpperCase();
    const requestOrigin = request.headers.get('origin');

    // Permanent 301 redirect from www.vatsom.in -> https://vatsom.in
    if (hostname === 'www.vatsom.in') {
      const secHeaders = buildSecurityHeaders(env, requestOrigin);
      return new Response(null, {
        status: 301,
        headers: {
          ...secHeaders,
          Location: `https://vatsom.in${url.pathname}${url.search}`,
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // Handle CORS Preflight for configured allowed origins (APP_ORIGIN, ADMIN_ORIGIN, API_ORIGIN)
    if (method === 'OPTIONS') {
      const secHeaders = buildSecurityHeaders(env, requestOrigin);
      return new Response(null, {
        status: 204,
        headers: {
          ...secHeaders,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, X-CSRF-Token, Idempotency-Key, X-Vatsom-Portal'
        }
      });
    }

    const isDedicatedApiHost = hostname === 'api.vatsom.in' || hostname === 'api-staging.vatsom.in';
    const isDedicatedAdminHost =
      hostname === 'admin.vatsom.in' || hostname === 'admin-staging.vatsom.in';
    const isStorefrontCustomDomain =
      hostname === 'vatsom.in' || hostname === 'staging.vatsom.in';

    try {
      // Enforce Cloudflare Access JWT verification at the perimeter for all requests to admin.vatsom.in
      if (isDedicatedAdminHost) {
        await verifyCloudflareAccessJwt(env, request);
      }

      // Block public access to admin portal HTML & admin API routes on the customer storefront domain (vatsom.in)
      if (
        isStorefrontCustomDomain &&
        (url.pathname.startsWith('/admin-portal') ||
          url.pathname === '/api/v1/admin' ||
          url.pathname.startsWith('/api/v1/admin/'))
      ) {
        return jsonError(new NotFoundError('Route not found.'), env, requestId, requestOrigin);
      }

      // Non-API routes -> serve static assets via Cloudflare Workers Assets binding (with hostname isolation)
      if (!url.pathname.startsWith('/api/')) {
        // Dedicated API hostname (api.vatsom.in) never serves HTML/JS static assets
        if (isDedicatedApiHost) {
          return jsonError(
            new NotFoundError('API origin only serves /api/v1/* endpoints.'),
            env,
            requestId,
            requestOrigin
          );
        }

        if (env.ASSETS) {
          let assetRequest = request;
          if (isDedicatedAdminHost) {
            if (url.pathname === '/vatsom_premium_oils.html') {
              return jsonError(new NotFoundError('Route not found.'), env, requestId, requestOrigin);
            }
            if (url.pathname === '/' || url.pathname === '/index.html') {
              const adminAssetUrl = new URL(request.url);
              adminAssetUrl.pathname = '/admin-portal.html';
              assetRequest = new Request(adminAssetUrl.toString(), request);
            }
          }

          const assetRes = await env.ASSETS.fetch(assetRequest);
          const headers = new Headers(assetRes.headers);
          const secHeaders = buildSecurityHeaders(env, requestOrigin);
          for (const [k, v] of Object.entries(secHeaders)) {
            if (!headers.has(k)) headers.set(k, v);
          }
          return new Response(assetRes.body, {
            status: assetRes.status,
            headers
          });
        }
        return jsonError(new NotFoundError('Route not found.'), env, requestId, requestOrigin);
      }

      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      // ======================================================================
      // PUBLIC CONFIG & HEALTH (Available before DB connection resolution)
      // ======================================================================
      if (method === 'GET' && pathname === '/api/v1/health') {
        return jsonSuccess(
          {
            status: 'ok',
            service: 'vatsom-ecommerce-worker',
            environment: env.ENVIRONMENT || 'development',
            version: env.API_VERSION || 'v1',
            databaseConfigured: Boolean(env.HYPERDRIVE?.connectionString || env.DATABASE_URL)
          },
          env,
          { requestOrigin }
        );
      }

      if (method === 'GET' && pathname === '/api/v1/public-config') {
        return jsonSuccess(
          {
            googleClientId: env.GOOGLE_CLIENT_ID || '',
            turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
            privacyPolicyVersion: env.PRIVACY_POLICY_VERSION || '2026.11',
            environment: env.ENVIRONMENT || 'development'
          },
          env,
          {
            cacheControl: 'public, max-age=300',
            requestOrigin
          }
        );
      }

      const db = resolveDatabaseClient(env);
      const rawIp =
        request.headers.get('cf-connecting-ip') ||
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        '127.0.0.1';
      const ipHash = await sha256Hex(`ip:${rawIp}`);
      const userAgent = request.headers.get('user-agent') || 'unknown';

      const { user, session } = await resolveRequestSession(db, request);
      const reqCtx: RequestContext = {
        request,
        env,
        url,
        ipHash,
        userAgent,
        requestId,
        user,
        session
      };

      // ======================================================================
      // PUBLIC CATALOGUE & MEDIA ENDPOINTS
      // ======================================================================
      if (method === 'GET' && pathname === '/api/v1/products') {
        const divisionParam = url.searchParams.get('division')?.toUpperCase();
        const division: Division | undefined =
          divisionParam === 'TABLE' || divisionParam === 'ATMOSPHERE'
            ? divisionParam
            : undefined;
        const page = Number(url.searchParams.get('page') || 1);
        const limit = Number(url.searchParams.get('limit') || 24);

        const result = await listPublicProducts(db, { division, page, limit });
        return jsonSuccess(result.items, env, {
          meta: { total: result.total, page: result.page, limit: result.limit },
          cacheControl: 'public, max-age=60, stale-while-revalidate=120',
          requestOrigin
        });
      }

      const productSlugMatch = matchRoute('/api/v1/products/:slug', pathname);
      if (method === 'GET' && productSlugMatch) {
        const product = await getPublicProductBySlugOrId(db, productSlugMatch.slug!);
        return jsonSuccess(product, env, {
          cacheControl: 'public, max-age=60, stale-while-revalidate=120',
          requestOrigin
        });
      }

      const mediaMatch = matchRoute('/api/v1/media/:id', pathname);
      if (method === 'GET' && mediaMatch) {
        const media = await getProductMediaBinary(db, mediaMatch.id!);
        const etag = `"${media.sha256Hex}"`;
        if (request.headers.get('if-none-match') === etag) {
          return new Response(null, {
            status: 304,
            headers: {
              ETag: etag,
              'Cache-Control': 'public, max-age=31536000, immutable'
            }
          });
        }
        return new Response(media.bytes, {
          status: 200,
          headers: {
            'Content-Type': media.mimeType,
            'Content-Length': String(media.bytes.byteLength),
            'Cache-Control': 'public, max-age=31536000, immutable',
            ETag: etag,
            'X-Content-Type-Options': 'nosniff'
          }
        });
      }

      if (method === 'GET' && pathname === '/api/v1/site-content') {
        const content = await getSiteContent(db);
        return jsonSuccess(content, env, {
          cacheControl: 'public, max-age=60, stale-while-revalidate=120',
          requestOrigin
        });
      }

      // ======================================================================
      // AUTHENTICATION ENDPOINTS
      // ======================================================================
      if (method === 'POST' && pathname === '/api/v1/auth/google') {
        await enforceRateLimits(db, [
          { scope: 'auth_google_ip', identifier: ipHash, maxRequests: 12, windowSeconds: 60 }
        ]);

        const body = await parseAndValidateJson(request, GoogleAuthRequestSchema, 16384);

        if (body.adminPortalLogin) {
          await verifyCloudflareAccessJwt(env, request);
        }

        if (body.turnstileToken) {
          await verifyTurnstileToken(db, env, body.turnstileToken, { remoteIp: rawIp });
        }

        const googleIdentity = await verifyGoogleIdToken(db, env, body.credential, body.nonce);
        const emailHash = await sha256Hex(`email:${googleIdentity.email}`);
        await enforceRateLimits(db, [
          { scope: 'auth_google_email', identifier: emailHash, maxRequests: 8, windowSeconds: 60 }
        ]);

        const { user: customerUser, isNewCustomer } = await upsertCustomerFromGoogle(
          db,
          env,
          googleIdentity
        );

        const requestedScope = body.adminPortalLogin ? 'admin' : 'customer';
        const sessionBundle = await issueSession(
          db,
          env,
          customerUser,
          requestedScope,
          ipHash,
          userAgent,
          hostname
        );

        if (ctx) {
          ctx.waitUntil(processNotificationOutboxBatch(db, env, 5));
        } else {
          await processNotificationOutboxBatch(db, env, 5);
        }

        const response = jsonSuccess(
          {
            user: customerUser,
            sessionScope: sessionBundle.sessionScope,
            csrfToken: sessionBundle.rawCsrfToken,
            expiresAt: sessionBundle.expiresAt.toISOString(),
            isNewCustomer
          },
          env,
          { status: 200, requestOrigin }
        );

        const headers = new Headers(response.headers);
        for (const cookie of sessionBundle.setCookieHeaders) {
          headers.append('Set-Cookie', cookie);
        }
        return new Response(response.body, { status: response.status, headers });
      }

      if (method === 'POST' && pathname === '/api/v1/auth/logout') {
        if (reqCtx.session) {
          await db.query(
            `UPDATE sessions SET revoked_at = NOW(), revocation_reason = 'user_logout' WHERE id = $1`,
            [reqCtx.session.id]
          );
        }
        const clearCookies = clearSessionCookies(env, hostname);
        const response = jsonSuccess({ loggedOut: true }, env, { requestOrigin });
        const headers = new Headers(response.headers);
        for (const c of clearCookies) {
          headers.append('Set-Cookie', c);
        }
        return new Response(response.body, { status: 200, headers });
      }

      if (method === 'GET' && pathname === '/api/v1/auth/me') {
        if (!reqCtx.user || !reqCtx.session) {
          return jsonSuccess(
            { authenticated: false, user: null },
            env,
            { requestOrigin }
          );
        }
        const csrfToken = await resolveVerifiedCsrfCookie(request, reqCtx.session);
        return jsonSuccess(
          {
            authenticated: true,
            user: reqCtx.user,
            sessionScope: reqCtx.session.sessionScope,
            ...(csrfToken ? { csrfToken } : {}),
            expiresAt: reqCtx.session.expiresAt.toISOString()
          },
          env,
          { requestOrigin }
        );
      }

      // ======================================================================
      // CUSTOMER PROFILE, ADDRESSES & ORDER HISTORY
      // ======================================================================
      if (pathname === '/api/v1/customer/profile') {
        if (method === 'GET') {
          const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: false });
          return jsonSuccess(customer, env, { requestOrigin });
        }
        if (method === 'PATCH') {
          const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: true });
          const body = await parseAndValidateJson(request, CustomerProfileUpdateSchema);
          const updated = await updateCustomerProfile(db, customer, body);
          return jsonSuccess(updated, env, { requestOrigin });
        }
      }

      if (pathname === '/api/v1/customer/addresses') {
        if (method === 'GET') {
          const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: false });
          const addresses = await listCustomerAddresses(db, customer.id);
          return jsonSuccess(addresses, env, { requestOrigin });
        }
        if (method === 'POST') {
          const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: true });
          await enforceRateLimits(db, [
            { scope: 'address_mutation', identifier: customer.id, maxRequests: 15, windowSeconds: 60 }
          ]);
          const body = await parseAndValidateJson(request, AddressCreateSchema);
          const created = await createCustomerAddress(db, customer.id, body);
          return jsonSuccess(created, env, { status: 201, requestOrigin });
        }
      }

      const addressIdMatch = matchRoute('/api/v1/customer/addresses/:id', pathname);
      if (addressIdMatch) {
        const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: true });
        if (method === 'PATCH') {
          const body = await parseAndValidateJson(request, AddressUpdateSchema);
          const updated = await updateCustomerAddress(db, customer.id, addressIdMatch.id!, body);
          return jsonSuccess(updated, env, { requestOrigin });
        }
        if (method === 'DELETE') {
          await deleteCustomerAddress(db, customer.id, addressIdMatch.id!);
          return jsonSuccess({ deleted: true, id: addressIdMatch.id! }, env, { requestOrigin });
        }
      }

      if (method === 'GET' && pathname === '/api/v1/customer/orders') {
        const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: false });
        const page = Number(url.searchParams.get('page') || 1);
        const limit = Number(url.searchParams.get('limit') || 20);
        const result = await listCustomerOrders(db, customer.id, { page, limit });
        return jsonSuccess(result.items, env, {
          meta: { total: result.total, page: result.page, limit: result.limit },
          requestOrigin
        });
      }

      const customerOrderIdMatch = matchRoute('/api/v1/customer/orders/:id', pathname);
      if (method === 'GET' && customerOrderIdMatch) {
        const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: false });
        const order = await getCustomerOrderById(db, customer.id, customerOrderIdMatch.id!);
        return jsonSuccess(order, env, { requestOrigin });
      }

      // ======================================================================
      // COD CHECKOUT & ORDER TRACKING
      // ======================================================================
      if (method === 'POST' && pathname === '/api/v1/orders') {
        const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: true });
        const body = await parseAndValidateJson(request, CodCheckoutRequestSchema, 65536);

        const phoneRaw = body.deliveryAddress?.phoneNumber || customer.mobileNumber || '';
        const phoneHash = phoneRaw ? await sha256Hex(`phone:${phoneRaw}`) : '';

        await enforceRateLimits(db, [
          { scope: 'checkout_ip', identifier: ipHash, maxRequests: 10, windowSeconds: 60 },
          { scope: 'checkout_customer', identifier: customer.id, maxRequests: 6, windowSeconds: 60 },
          ...(phoneHash
            ? [{ scope: 'checkout_phone', identifier: phoneHash, maxRequests: 5, windowSeconds: 300 }]
            : [])
        ]);

        await verifyTurnstileToken(db, env, body.turnstileToken, {
          expectedAction: 'checkout',
          remoteIp: rawIp
        });

        const result = await createCodOrder(db, env, customer, body, ipHash);

        if (ctx) {
          ctx.waitUntil(processNotificationOutboxBatch(db, env, 5));
        } else {
          await processNotificationOutboxBatch(db, env, 5);
        }

        return jsonSuccess(result.order, env, {
          status: result.idempotentReplay ? 200 : 201,
          meta: { idempotentReplay: result.idempotentReplay },
          requestOrigin
        });
      }

      const orderTrackingMatch = matchRoute('/api/v1/orders/:trackingReference', pathname);
      if (method === 'GET' && orderTrackingMatch) {
        await enforceRateLimits(db, [
          { scope: 'order_tracking_lookup', identifier: ipHash, maxRequests: 20, windowSeconds: 60 }
        ]);
        const trackingToken = url.searchParams.get('token');
        const order = await getOrderByTrackingReference(
          db,
          orderTrackingMatch.trackingReference!,
          reqCtx.user,
          trackingToken
        );
        return jsonSuccess(order, env, { requestOrigin });
      }

      // Courier Webhook Endpoint
      if (method === 'POST' && pathname === '/api/v1/webhooks/courier') {
        const rawBody = await request.text();
        const sig = request.headers.get('x-courier-signature');
        const ts = request.headers.get('x-courier-timestamp');
        const result = await handleCourierWebhook(db, env, rawBody, sig, ts);
        return jsonSuccess(result, env, { requestOrigin });
      }

      // ======================================================================
      // MARKETING & CUSTOMER RETENTION ENDPOINTS
      // ======================================================================
      if (method === 'POST' && pathname === '/api/v1/marketing/subscribe') {
        const body = await parseAndValidateJson(request, MarketingSubscribeSchema, 16384);
        const emailHash = await sha256Hex(`email:${body.email}`);

        await enforceRateLimits(db, [
          { scope: 'marketing_sub_ip', identifier: ipHash, maxRequests: 8, windowSeconds: 60 },
          { scope: 'marketing_sub_email', identifier: emailHash, maxRequests: 4, windowSeconds: 300 }
        ]);

        await verifyTurnstileToken(db, env, body.turnstileToken, { remoteIp: rawIp });

        const result = await subscribeMarketing(db, env, {
          customerId: reqCtx.user?.id ?? null,
          email: body.email,
          segments: body.segments,
          ipHash
        });
        return jsonSuccess(result, env, { status: 201, requestOrigin });
      }

      if (method === 'POST' && pathname === '/api/v1/marketing/unsubscribe') {
        await enforceRateLimits(db, [
          { scope: 'marketing_unsub_ip', identifier: ipHash, maxRequests: 15, windowSeconds: 60 }
        ]);
        const body = await parseAndValidateJson(request, MarketingUnsubscribeSchema, 16384);
        const result = await unsubscribeMarketing(db, env, {
          email: body.email,
          token: body.token,
          reason: body.reason,
          ipHash
        });
        return jsonSuccess(result, env, { requestOrigin });
      }

      if (pathname === '/api/v1/marketing/preferences' || pathname === '/api/v1/customer/preferences') {
        if (method === 'GET') {
          const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: false });
          const prefs = await getCustomerMarketingPreferences(db, customer.id, customer.email);
          return jsonSuccess(prefs, env, { requestOrigin });
        }
        if (method === 'PATCH' || method === 'PUT') {
          const customer = await requireAuthenticatedCustomer(reqCtx, { requireCsrf: true });
          const body = await parseAndValidateJson(request, MarketingPreferencesUpdateSchema, 16384);
          const updated = await updateCustomerMarketingPreferences(
            db,
            env,
            customer.id,
            customer.email,
            body,
            ipHash
          );
          return jsonSuccess(updated, env, { requestOrigin });
        }
      }

      // ======================================================================
      // ADMINISTRATIVE API ENDPOINTS (Strict Admin Role + Allowlist + CSRF)
      // ======================================================================
      if (pathname === '/api/v1/admin' || pathname.startsWith('/api/v1/admin/')) {
        const isReadOnly = method === 'GET' || method === 'HEAD';
        const admin = await requireAuthenticatedAdmin(reqCtx, { requireCsrf: !isReadOnly });

        if (!isReadOnly) {
          await enforceRateLimits(db, [
            { scope: 'admin_mutation', identifier: admin.id, maxRequests: 40, windowSeconds: 60 }
          ]);
        }

        if (method === 'GET' && pathname === '/api/v1/admin/overview') {
          const [ordersRes, productsList, outboxSummary] = await Promise.all([
            listAdminOrders(db, { page: 1, limit: 100 }),
            listAdminProducts(db),
            getNotificationOutboxMonitoring(db, 20)
          ]);
          const activeOrders = ordersRes.items.filter((o) => o.status !== 'Cancelled');
          const pendingOrdersCount = ordersRes.items.filter((o) => o.status === 'Pending Seal').length;
          const totalRevenuePaise = activeOrders.reduce((sum, o) => sum + Number(o.finalAmountPaise || 0), 0);

          return jsonSuccess(
            {
              totalOrders: ordersRes.total,
              pendingOrders: pendingOrdersCount,
              totalProducts: productsList.length,
              totalRevenuePaise,
              totalRevenue: Number((totalRevenuePaise / 100).toFixed(2)),
              outboxCounts: outboxSummary.counts
            },
            env,
            { requestOrigin }
          );
        }

        if (method === 'GET' && pathname === '/api/v1/admin/orders') {
          const status = url.searchParams.get('status') || 'all';
          const search = url.searchParams.get('search') || '';
          const page = Number(url.searchParams.get('page') || 1);
          const limit = Number(url.searchParams.get('limit') || 50);

          const result = await listAdminOrders(db, { status, search, page, limit });
          return jsonSuccess(result.items, env, {
            meta: { total: result.total, page: result.page, limit: result.limit },
            requestOrigin
          });
        }

        const adminOrderTrackingMatch = matchRoute('/api/v1/admin/orders/:id/tracking', pathname);
        if ((method === 'PATCH' || method === 'PUT') && adminOrderTrackingMatch) {
          const body = await parseAndValidateJson(request, AdminTrackingUpdateSchema);
          const updated = await updateAdminOrderTracking(
            db,
            admin,
            adminOrderTrackingMatch.id!,
            body,
            ipHash,
            userAgent
          );
          if (ctx) {
            ctx.waitUntil(processNotificationOutboxBatch(db, env, 5));
          } else {
            await processNotificationOutboxBatch(db, env, 5);
          }
          return jsonSuccess(updated, env, { requestOrigin });
        }

        const adminOrderIdMatch = matchRoute('/api/v1/admin/orders/:id', pathname);
        if (adminOrderIdMatch) {
          if (method === 'PATCH' || method === 'PUT') {
            const body = await parseAndValidateJson(request, AdminOrderUpdateSchema);
            const updated = await updateAdminOrderStatus(
              db,
              admin,
              adminOrderIdMatch.id!,
              body,
              ipHash,
              userAgent
            );
            if (ctx) {
              ctx.waitUntil(processNotificationOutboxBatch(db, env, 5));
            } else {
              await processNotificationOutboxBatch(db, env, 5);
            }
            return jsonSuccess(updated, env, { requestOrigin });
          }

          if (method === 'DELETE') {
            // Striking an order from the ledger cancels it, restores stock, and records an audit trail
            const cancelled = await updateAdminOrderStatus(
              db,
              admin,
              adminOrderIdMatch.id!,
              {
                orderStatus: 'CANCELLED',
                status: 'Cancelled',
                notes: 'Order struck from Admin Ledger'
              },
              ipHash,
              userAgent
            );
            return jsonSuccess(cancelled, env, { requestOrigin });
          }
        }

        if (pathname === '/api/v1/admin/products') {
          if (method === 'GET') {
            const items = await listAdminProducts(db);
            return jsonSuccess(items, env, { requestOrigin });
          }
          if (method === 'POST') {
            // Allow up to 2.2 MB JSON payload for 3 compressed WebP plates
            const body = await parseAndValidateJson(request, AdminProductInputSchema, 2300000);
            const created = await createAdminProduct(db, admin, body, ipHash, userAgent);
            return jsonSuccess(created, env, { status: 201, requestOrigin });
          }
        }

        const adminProductIdMatch = matchRoute('/api/v1/admin/products/:id', pathname);
        if (adminProductIdMatch) {
          if (method === 'PATCH' || method === 'PUT') {
            const body = await parseAndValidateJson(request, AdminProductUpdateSchema, 2300000);
            const updated = await updateAdminProduct(
              db,
              admin,
              adminProductIdMatch.id!,
              body,
              ipHash,
              userAgent
            );
            return jsonSuccess(updated, env, { requestOrigin });
          }
          if (method === 'DELETE') {
            const result = await deleteOrArchiveAdminProduct(
              db,
              admin,
              adminProductIdMatch.id!,
              ipHash,
              userAgent
            );
            return jsonSuccess(result, env, { requestOrigin });
          }
        }

        if ((method === 'PATCH' || method === 'PUT') && pathname === '/api/v1/admin/site-content') {
          const body = await parseAndValidateJson(request, AdminSiteContentSchema, 65536);
          const updated = await updateSiteContent(db, admin, body, ipHash, userAgent);
          return jsonSuccess(updated, env, { requestOrigin });
        }

        if (method === 'GET' && pathname === '/api/v1/admin/audit-logs') {
          const logs = await listAdminAuditLogs(db, 50);
          return jsonSuccess(logs, env, { requestOrigin });
        }

        if (
          method === 'POST' &&
          (pathname === '/api/v1/admin/migrate-localstorage' ||
            pathname === '/api/v1/admin/migrate-legacy')
        ) {
          const body = await parseAndValidateJson(request, LocalStorageMigrationSchema, 2500000);
          const report = await migrateLegacyLocalStorageData(db, admin, body, ipHash, userAgent);
          return jsonSuccess(report, env, { requestOrigin });
        }

        if (method === 'GET' && pathname === '/api/v1/admin/notifications/outbox') {
          const limit = Number(url.searchParams.get('limit') || 50);
          const report = await getNotificationOutboxMonitoring(db, limit);
          return jsonSuccess(report, env, { requestOrigin });
        }

        if (method === 'POST' && pathname === '/api/v1/admin/notifications/dispatch') {
          let recoverExhausted = url.searchParams.get('recoverExhausted') === 'true';
          try {
            const rawBody = await request.text();
            if (rawBody) {
              const parsed = JSON.parse(rawBody) as { recoverExhausted?: boolean };
              if (typeof parsed.recoverExhausted === 'boolean') {
                recoverExhausted = parsed.recoverExhausted;
              }
            }
          } catch {
            // Optional JSON body
          }
          const batchResult = await processNotificationOutboxBatch(db, env, 25, {
            recoverExhausted
          });
          return jsonSuccess(batchResult, env, { requestOrigin });
        }
      }

      throw new ValidationError(`Unsupported API endpoint: ${method} ${pathname}`);
    } catch (err) {
      return jsonError(err, env, requestId, requestOrigin);
    }
  },

  /**
   * Cloudflare Workers Cron Trigger Handler (`[triggers] crons = ["*\/5 * * * *"]`)
   * Reliably dispatches pending and retryable notifications from `notification_outbox`.
   */
  async scheduled(_controller: unknown, env: Env, ctx?: ExecutionContext): Promise<void> {
    const db = resolveDatabaseClient(env);
    const task = Promise.all([
      processNotificationOutboxBatch(db, env, 25),
      purgeExpiredSecurityAndSessionRecords(db)
    ]).catch((err) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'SCHEDULED_OUTBOX_DISPATCH_ERROR',
          error: err instanceof Error ? err.message : 'Unknown error'
        })
      );
    });
    if (ctx) {
      ctx.waitUntil(task);
    } else {
      await task;
    }
  }
};

