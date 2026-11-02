import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../src/crypto';
import { setTestDatabaseOverride } from '../src/db/client';
import { AuthenticationError } from '../src/errors';
import worker from '../src/index';
import { setTestGoogleTokenVerifier } from '../src/security/google-auth';
import { setTestCfAccessVerifier } from '../src/security/session';
import { setTestTurnstileFetcher } from '../src/security/turnstile';
import { Env } from '../src/types';
import { TransactionalTestDatabase } from './helpers/test-db';

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  API_VERSION: 'v1',
  APP_ORIGIN: 'https://vatsom.com',
  PRIVACY_POLICY_VERSION: '2026.11',
  COD_MAX_ORDER_PAISE: '5000000',
  COD_FREE_DELIVERY_THRESHOLD_PAISE: '1500000',
  COD_STANDARD_DELIVERY_PAISE: '15000',
  SESSION_TTL_SECONDS: '604800',
  ADMIN_SESSION_TTL_SECONDS: '28800',
  GOOGLE_CLIENT_ID: 'vatsom-google-client-id.apps.googleusercontent.com',
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: 'secret-turnstile-key-vatsom',
  SESSION_SIGNING_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ADMIN_ALLOWLIST: 'admin@vatsom.com',
  EMAIL_PROVIDER: 'none',
  EMAIL_PROVIDER_API_KEY: '',
  EMAIL_FROM_ADDRESS: 'atelier@vatsom.com',
  COURIER_WEBHOOK_SECRET: 'courier-hmac-secret-2026'
};

function extractCookies(res: Response): { cookieHeader: string; csrfToken: string } {
  const headersWithSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies = headersWithSetCookie.getSetCookie
    ? headersWithSetCookie.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  const pairs: string[] = [];
  let csrfToken = '';
  for (const c of rawCookies) {
    const firstPart = c.split(';')[0]?.trim();
    if (firstPart) {
      pairs.push(firstPart);
      if (firstPart.startsWith('vatsom_csrf=')) {
        csrfToken = decodeURIComponent(firstPart.slice('vatsom_csrf='.length));
      }
    }
  }
  return { cookieHeader: pairs.join('; '), csrfToken };
}

describe('VATSOM Production Backend — Security, Auth, COD Orders & Database Integrity', () => {
  let testDb: TransactionalTestDatabase;

  beforeEach(() => {
    testDb = new TransactionalTestDatabase();
    setTestDatabaseOverride(testDb);

    // Default Google token verifier mock
    setTestGoogleTokenVerifier(async (idToken, expectedClientId) => {
      if (idToken.startsWith('invalid-sig')) {
        throw new AuthenticationError('Invalid Google ID token signature or claims.');
      }
      if (idToken.startsWith('expired-token')) {
        throw new AuthenticationError('Google ID token has expired.');
      }
      if (idToken.startsWith('wrong-aud')) {
        if (expectedClientId === TEST_ENV.GOOGLE_CLIENT_ID) {
          throw new AuthenticationError('Google ID token audience does not match VATSOM client ID.');
        }
      }
      if (idToken.startsWith('unverified-email')) {
        return {
          sub: 'google-sub-unverified',
          email: 'unverified@example.com',
          emailVerified: false,
          name: 'Unverified User',
          exp: Math.floor(Date.now() / 1000) + 3600
        };
      }
      if (idToken.startsWith('valid-admin-token')) {
        return {
          sub: 'google-sub-admin-1',
          email: 'admin@vatsom.com',
          emailVerified: true,
          name: 'Master Chancellor',
          exp: Math.floor(Date.now() / 1000) + 3600
        };
      }
      if (idToken.startsWith('valid-customer-b')) {
        return {
          sub: 'google-sub-customer-b',
          email: 'patron.b@example.com',
          emailVerified: true,
          name: 'Patron B',
          exp: Math.floor(Date.now() / 1000) + 3600
        };
      }
      return {
        sub: 'google-sub-customer-a',
        email: 'patron.a@example.com',
        emailVerified: true,
        name: 'Lady Eleanor Vance',
        exp: Math.floor(Date.now() / 1000) + 3600
      };
    });

    // Default Turnstile verifier mock
    setTestTurnstileFetcher(async (_secret, token) => {
      if (token.startsWith('invalid-ts')) {
        return { success: false, 'error-codes': ['invalid-input-response'] };
      }
      if (token.startsWith('expired-ts')) {
        return { success: false, 'error-codes': ['timeout-or-duplicate'] };
      }
      return {
        success: true,
        hostname: 'vatsom.com',
        action: 'checkout'
      };
    });
  });

  async function loginCustomer(tokenPrefix = 'valid-customer-a', adminPortalLogin = false) {
    const req = new Request('https://vatsom.com/api/v1/auth/google', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://vatsom.com'
      },
      body: JSON.stringify({
        credential: `${tokenPrefix}-${crypto.randomUUID()}`,
        adminPortalLogin
      })
    });
    const res = await worker.fetch(req, TEST_ENV);
    const body = (await res.json()) as {
      success: boolean;
      data?: { csrfToken: string; user: { id: string; email: string; role: string } };
      error?: { code: string; message: string };
    };
    const cookies = extractCookies(res);
    return { res, body, ...cookies };
  }

  // ==========================================================================
  // 1. AUTHENTICATION TESTS
  // ==========================================================================
  describe('1. Authentication Security', () => {
    it('authenticates a valid Google ID token, creates a customer account, sets HttpOnly/Secure cookies, and does NOT auto-subscribe marketing', async () => {
      const { res, body, cookieHeader, csrfToken } = await loginCustomer('valid-customer-a');
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data?.user.email).toBe('patron.a@example.com');
      expect(body.data?.user.role).toBe('customer');
      expect(cookieHeader).toContain('vatsom_session=');
      expect(csrfToken.length).toBeGreaterThanOrEqual(32);

      // Verify marketing preferences default to FALSE on Google Sign-In
      const prefRow = testDb.emailPreferences.get('patron.a@example.com');
      expect(prefRow).toBeDefined();
      expect(prefRow?.sub_table).toBe(false);
      expect(prefRow?.sub_atmosphere).toBe(false);

      // Verify Welcome email was queued in outbox with PROVIDER_NOT_CONFIGURED status
      expect(testDb.notificationOutbox.size).toBe(1);
    });

    it('rejects invalid Google ID token signatures with 401', async () => {
      const { res, body } = await loginCustomer('invalid-sig-token');
      expect(res.status).toBe(401);
      expect(body.success).toBe(false);
    });

    it('rejects expired Google ID tokens with 401', async () => {
      const { res, body } = await loginCustomer('expired-token-123');
      expect(res.status).toBe(401);
      expect(body.error?.message).toContain('expired');
    });

    it('rejects Google ID tokens with wrong audience with 401', async () => {
      const { res, body } = await loginCustomer('wrong-aud-token');
      expect(res.status).toBe(401);
      expect(body.error?.message).toContain('audience');
    });

    it('rejects unverified Google email accounts with 401', async () => {
      const { res, body } = await loginCustomer('unverified-email-token');
      expect(res.status).toBe(401);
      expect(body.error?.message).toContain('not verified');
    });

    it('rejects replayed Google ID tokens with 401', async () => {
      const fixedToken = 'valid-customer-a-fixed-replay-test-token-0001';
      const req1 = new Request('https://vatsom.com/api/v1/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: fixedToken })
      });
      const res1 = await worker.fetch(req1, TEST_ENV);
      expect(res1.status).toBe(200);

      const req2 = new Request('https://vatsom.com/api/v1/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: fixedToken })
      });
      const res2 = await worker.fetch(req2, TEST_ENV);
      expect(res2.status).toBe(401);
    });

    it('invalidates a revoked session upon logout', async () => {
      const { cookieHeader } = await loginCustomer('valid-customer-a');

      const logoutReq = new Request('https://vatsom.com/api/v1/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookieHeader }
      });
      const logoutRes = await worker.fetch(logoutReq, TEST_ENV);
      expect(logoutRes.status).toBe(200);

      // Subsequent request with the old session cookie must be unauthenticated
      const profileReq = new Request('https://vatsom.com/api/v1/customer/profile', {
        method: 'GET',
        headers: { Cookie: cookieHeader }
      });
      const profileRes = await worker.fetch(profileReq, TEST_ENV);
      expect(profileRes.status).toBe(401);
    });

    it('blocks an ordinary customer from logging into the Admin Portal with 403', async () => {
      const { res, body } = await loginCustomer('valid-customer-a', true);
      expect(res.status).toBe(403);
      expect(body.error?.code).toBe('FORBIDDEN');
    });
  });

  // ==========================================================================
  // 2. AUTHORIZATION & IDOR PROTECTION TESTS
  // ==========================================================================
  describe('2. Authorization & IDOR Prevention', () => {
    it('prevents Customer B from accessing Customer A order details (IDOR blocked with 403)', async () => {
      const custA = await loginCustomer('valid-customer-a');
      const custB = await loginCustomer('valid-customer-b');

      // Customer A places an order
      const orderReq = new Request('https://vatsom.com/api/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: custA.cookieHeader,
          'X-CSRF-Token': custA.csrfToken,
          Origin: 'https://vatsom.com'
        },
        body: JSON.stringify({
          items: [{ legacyId: 1, quantity: 1 }],
          deliveryAddress: {
            recipientName: 'Lady Eleanor Vance',
            phoneNumber: '9876543210',
            addressLine1: '14 Chancery Lane',
            city: 'New Delhi',
            state: 'Delhi',
            pinCode: '110001'
          },
          idempotencyKey: 'idem-cust-a-order-1',
          turnstileToken: `valid-ts-${crypto.randomUUID()}`
        })
      });
      const orderRes = await worker.fetch(orderReq, TEST_ENV);
      expect(orderRes.status).toBe(201);
      const orderJson = (await orderRes.json()) as { data: { id: string; orderId: string } };

      // Customer B attempts to view Customer A's order by ID
      const idorReq = new Request(
        `https://vatsom.com/api/v1/customer/orders/${orderJson.data.id}`,
        {
          method: 'GET',
          headers: { Cookie: custB.cookieHeader }
        }
      );
      const idorRes = await worker.fetch(idorReq, TEST_ENV);
      expect(idorRes.status).toBe(403);

      // Customer B also attempts to view Customer A's order via public reference without token
      const refReq = new Request(
        `https://vatsom.com/api/v1/orders/${orderJson.data.orderId}`,
        {
          method: 'GET',
          headers: { Cookie: custB.cookieHeader }
        }
      );
      const refRes = await worker.fetch(refReq, TEST_ENV);
      expect(refRes.status).toBe(403);
    });

    it('prevents Customer B from modifying or deleting Customer A saved address (IDOR blocked)', async () => {
      const custA = await loginCustomer('valid-customer-a');
      const custB = await loginCustomer('valid-customer-b');

      const createAddrReq = new Request('https://vatsom.com/api/v1/customer/addresses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: custA.cookieHeader,
          'X-CSRF-Token': custA.csrfToken,
          Origin: 'https://vatsom.com'
        },
        body: JSON.stringify({
          recipientName: 'Lady Eleanor Vance',
          phoneNumber: '9876543210',
          addressLine1: '72 Lodhi Estate',
          city: 'New Delhi',
          state: 'Delhi',
          pinCode: '110003'
        })
      });
      const createRes = await worker.fetch(createAddrReq, TEST_ENV);
      expect(createRes.status).toBe(201);
      const addrJson = (await createRes.json()) as { data: { id: string } };

      // Customer B tries to PATCH Customer A's address
      const patchReq = new Request(
        `https://vatsom.com/api/v1/customer/addresses/${addrJson.data.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: custB.cookieHeader,
            'X-CSRF-Token': custB.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({ city: 'Mumbai' })
        }
      );
      const patchRes = await worker.fetch(patchReq, TEST_ENV);
      expect(patchRes.status).toBe(404);
    });

    it('blocks customers and unauthenticated users from administrative product CRUD and role escalation', async () => {
      const custA = await loginCustomer('valid-customer-a');

      // 1. Unauthenticated Admin API access -> 401
      const unauthAdmin = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/orders', { method: 'GET' }),
        TEST_ENV
      );
      expect(unauthAdmin.status).toBe(401);

      // 2. Customer attempting Admin product creation -> 403
      const custProductCreate = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/products', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: custA.cookieHeader,
            'X-CSRF-Token': custA.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            name: 'Unauthorized Oil',
            category: 'Edible',
            description: 'Attempted customer creation',
            pricePaise: 100,
            volume: '100ml',
            notes: 'Forbidden'
          })
        }),
        TEST_ENV
      );
      expect(custProductCreate.status).toBe(403);

      // 3. Customer attempting mass-assignment role escalation on profile PATCH -> 400
      const escalationReq = await worker.fetch(
        new Request('https://vatsom.com/api/v1/customer/profile', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: custA.cookieHeader,
            'X-CSRF-Token': custA.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({ name: 'Escalator', role: 'admin' })
        }),
        TEST_ENV
      );
      expect(escalationReq.status).toBe(400);
    });
  });

  // ==========================================================================
  // 3. COD ORDERS, PRICE TAMPERING, IDEMPOTENCY & CONCURRENCY TESTS
  // ==========================================================================
  describe('3. Authoritative COD Order Processing & Concurrency', () => {
    it('ignores client-supplied manipulated prices and totals, calculating strictly from database paise', async () => {
      const cust = await loginCustomer('valid-customer-a');

      // Product 1 (Cold-Pressed Black Seed Oil) is 6800 paise ($68.00) in the database.
      // Attacker supplies price: 0.01 and total: 0.01 in the request payload.
      const req = new Request('https://vatsom.com/api/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cust.cookieHeader,
          'X-CSRF-Token': cust.csrfToken,
          Origin: 'https://vatsom.com'
        },
        body: JSON.stringify({
          items: [{ legacyId: 1, quantity: 2, clientIgnoredPrice: 1 }],
          deliveryAddress: {
            recipientName: 'Lady Eleanor Vance',
            phoneNumber: '9876543210',
            addressLine1: '14 Chancery Lane',
            city: 'New Delhi',
            state: 'Delhi',
            pinCode: '110001'
          },
          idempotencyKey: 'idem-price-tamper-test',
          turnstileToken: `valid-ts-${crypto.randomUUID()}`
        })
      });

      const res = await worker.fetch(req, TEST_ENV);
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        data: { subtotalPaise: number; finalAmountPaise: number; total: number };
      };
      // 2 * 6800 paise = 13600 paise ($136.00)
      expect(json.data.subtotalPaise).toBe(13600);
      expect(json.data.finalAmountPaise).toBe(13600);
      expect(json.data.total).toBe(136);
    });

    it('rejects invalid quantities (0, negative, or > max_order_quantity) and out-of-stock products', async () => {
      const cust = await loginCustomer('valid-customer-a');

      // Quantity 0 -> 400 Validation Error
      const zeroQtyRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 1, quantity: 0 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: 'idem-zero-qty',
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );
      expect(zeroQtyRes.status).toBe(400);

      // Set Product 2 stock to 0 and try to order -> 409 OUT_OF_STOCK
      const prod2 = testDb.products.get('22222222-2222-4222-8222-222222222222')!;
      prod2.stock_quantity = 0;

      const oosRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 2, quantity: 1 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: 'idem-oos-test',
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );
      expect(oosRes.status).toBe(409);
      const oosBody = (await oosRes.json()) as { error: { code: string } };
      expect(oosBody.error.code).toBe('OUT_OF_STOCK');
    });

    it('prevents duplicate order creation when the same idempotencyKey is submitted twice', async () => {
      const cust = await loginCustomer('valid-customer-a');
      const sharedIdemKey = 'idem-double-click-protection-001';

      const makeOrderReq = () =>
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 1, quantity: 2 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: sharedIdemKey,
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        });

      const res1 = await worker.fetch(makeOrderReq(), TEST_ENV);
      expect(res1.status).toBe(201);
      const json1 = (await res1.json()) as { data: { orderId: string } };

      const res2 = await worker.fetch(makeOrderReq(), TEST_ENV);
      expect(res2.status).toBe(200);
      const json2 = (await res2.json()) as {
        data: { orderId: string };
        meta: { idempotentReplay: boolean };
      };

      expect(json2.meta.idempotentReplay).toBe(true);
      expect(json2.data.orderId).toBe(json1.data.orderId);
      // Only 1 order created in DB and stock only reduced once (from 10 to 8)
      expect(testDb.orders.size).toBe(1);
      expect(testDb.products.get('11111111-1111-4111-8111-111111111111')?.stock_quantity).toBe(8);
    });

    it('prevents stock overselling under concurrent checkout requests against limited inventory', async () => {
      const custA = await loginCustomer('valid-customer-a');
      const custB = await loginCustomer('valid-customer-b');

      // Product 2 has stock_quantity = 5. Both Customer A and Customer B concurrently request 4 units.
      const orderReqA = worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: custA.cookieHeader,
            'X-CSRF-Token': custA.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 2, quantity: 4 }],
            deliveryAddress: {
              recipientName: 'Customer A',
              phoneNumber: '9876543210',
              addressLine1: '10 Park Street',
              city: 'Kolkata',
              state: 'West Bengal',
              pinCode: '700016'
            },
            idempotencyKey: 'idem-concurrent-a',
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );

      const orderReqB = worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: custB.cookieHeader,
            'X-CSRF-Token': custB.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 2, quantity: 4 }],
            deliveryAddress: {
              recipientName: 'Customer B',
              phoneNumber: '9123456789',
              addressLine1: '22 MG Road',
              city: 'Bengaluru',
              state: 'Karnataka',
              pinCode: '560001'
            },
            idempotencyKey: 'idem-concurrent-b',
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );

      const [resA, resB] = await Promise.all([orderReqA, orderReqB]);
      const statuses = [resA.status, resB.status].sort();
      // Exactly one succeeds (201) and one fails with 409 Conflict (OUT_OF_STOCK)
      expect(statuses).toEqual([201, 409]);
      // Remaining stock is 5 - 4 = 1 (never negative!)
      expect(testDb.products.get('22222222-2222-4222-8222-222222222222')?.stock_quantity).toBe(1);
    });

    it('restores reserved inventory when an order is cancelled and retains historical price snapshot when product price changes', async () => {
      const cust = await loginCustomer('valid-customer-a');
      const admin = await loginCustomer('valid-admin-token', true);

      // Place order for 3 units of Product 1 (stock 10 -> 7, price 6800 paise)
      const orderRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 1, quantity: 3 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: 'idem-cancel-restore-test',
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );
      expect(orderRes.status).toBe(201);
      const orderData = (await orderRes.json()) as { data: { orderId: string } };
      expect(testDb.products.get('11111111-1111-4111-8111-111111111111')?.stock_quantity).toBe(7);

      // Admin updates Product 1 price from 6800 to 9900 paise
      const prodUpdateRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/products/1', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({ pricePaise: 9900 })
        }),
        TEST_ENV
      );
      expect(prodUpdateRes.status).toBe(200);

      // Admin cancels the order -> stock restored from 7 back to 10, and order still retains original 6800 unit price
      const cancelRes = await worker.fetch(
        new Request(`https://vatsom.com/api/v1/admin/orders/${orderData.data.orderId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({ status: 'Cancelled' })
        }),
        TEST_ENV
      );
      expect(cancelRes.status).toBe(200);
      const cancelledOrder = (await cancelRes.json()) as {
        data: { items: Array<{ unitPricePaise: number }>; status: string };
      };
      expect(cancelledOrder.data.status).toBe('Cancelled');
      expect(cancelledOrder.data.items[0]?.unitPricePaise).toBe(6800);
      expect(testDb.products.get('11111111-1111-4111-8111-111111111111')?.stock_quantity).toBe(10);
    });
  });

  // ==========================================================================
  // 4. ABUSE PREVENTION, TURNSTILE & RATE LIMITING TESTS
  // ==========================================================================
  describe('4. Abuse Prevention, Turnstile & Rate Limiting', () => {
    it('rejects missing, invalid, expired, and replayed Turnstile tokens on checkout', async () => {
      const cust = await loginCustomer('valid-customer-a');

      const sendCheckout = (turnstileToken: string, idemSuffix: string) =>
        worker.fetch(
          new Request('https://vatsom.com/api/v1/orders', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: cust.cookieHeader,
              'X-CSRF-Token': cust.csrfToken,
              Origin: 'https://vatsom.com'
            },
            body: JSON.stringify({
              items: [{ legacyId: 1, quantity: 1 }],
              deliveryAddress: {
                recipientName: 'Lady Eleanor Vance',
                phoneNumber: '9876543210',
                addressLine1: '14 Chancery Lane',
                city: 'New Delhi',
                state: 'Delhi',
                pinCode: '110001'
              },
              idempotencyKey: `idem-ts-${idemSuffix}`,
              turnstileToken
            })
          }),
          TEST_ENV
        );

      // Missing/short Turnstile token -> 403
      const resMissing = await sendCheckout('short', '1');
      expect(resMissing.status).toBe(403);

      // Invalid Turnstile token -> 403
      const resInvalid = await sendCheckout('invalid-ts-token-0001', '2');
      expect(resInvalid.status).toBe(403);

      // Expired Turnstile token -> 403
      const resExpired = await sendCheckout('expired-ts-token-0001', '3');
      expect(resExpired.status).toBe(403);

      // Valid Turnstile token -> 201 on first use, 403 on replay
      const singleUseToken = 'valid-ts-single-use-token-9999';
      const resFirst = await sendCheckout(singleUseToken, '4');
      expect(resFirst.status).toBe(201);

      const resReplay = await sendCheckout(singleUseToken, '5');
      expect(resReplay.status).toBe(403);
    });

    it('enforces route-specific rate limits (HTTP 429 with Retry-After) on excessive authentication and checkout requests', async () => {
      // Send 13 authentication requests from the same IP (limit is 12/min)
      let lastRes!: Response;
      for (let i = 0; i < 13; i++) {
        lastRes = await worker.fetch(
          new Request('https://vatsom.com/api/v1/auth/google', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '203.0.113.55'
            },
            body: JSON.stringify({ credential: `valid-customer-a-${i}-${crypto.randomUUID()}` })
          }),
          TEST_ENV
        );
      }
      expect(lastRes.status).toBe(429);
      expect(lastRes.headers.get('Retry-After')).toBeTruthy();
    });

    it('rejects oversized request payloads with HTTP 413', async () => {
      const cust = await loginCustomer('valid-customer-a');
      const hugeNotes = 'A'.repeat(100000);
      const res = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 1, quantity: 1 }],
            customerNotes: hugeNotes,
            idempotencyKey: 'idem-oversized',
            turnstileToken: 'valid-ts-token-oversize'
          })
        }),
        TEST_ENV
      );
      expect(res.status).toBe(413);
    });
  });

  // ==========================================================================
  // 5. DATABASE INTEGRITY, ROLLBACK & PARAMETERIZATION TESTS
  // ==========================================================================
  describe('5. Database Migrations, Rollback, Constraints & Parameterized SQL', () => {
    it('verifies SQL migration files exist and define all 16 required normalized tables and constraints', () => {
      const schemaSql = fs.readFileSync(
        path.resolve(__dirname, '../DATABASE_MIGRATIONS/0001_initial_schema.sql'),
        'utf-8'
      );
      const requiredTables = [
        'customers',
        'sessions',
        'addresses',
        'products',
        'product_media',
        'orders',
        'order_items',
        'order_status_history',
        'shipment_tracking',
        'site_content',
        'marketing_consent',
        'email_preferences',
        'admin_audit_logs',
        'idempotency_records',
        'notification_outbox',
        'rate_limit_counters'
      ];
      for (const table of requiredTables) {
        expect(schemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      }
    });

    it('rolls back entire transaction if an error occurs mid-checkout and never leaks raw database errors on connection failure', async () => {
      const cust = await loginCustomer('valid-customer-a');

      // Simulate database connection failure
      testDb.simulateConnectionFailure = true;
      const failRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/products', { method: 'GET' }),
        TEST_ENV
      );
      expect(failRes.status).toBe(500);
      const failBody = (await failRes.json()) as { error: { message: string } };
      // Must not leak ECONNREFUSED or internal stack details
      expect(failBody.error.message).toBe(
        'An unexpected server error occurred. Please try again shortly.'
      );
      testDb.simulateConnectionFailure = false;

      // Verify all recorded queries use parameterized $1 placeholders
      for (const q of testDb.recordedQueries) {
        if (q.params.length > 0) {
          expect(q.sql).toContain('$1');
        }
      }
    });
  });

  // ==========================================================================
  // 6. ADMINISTRATION, IMAGE VALIDATION & AUDIT LOGGING TESTS
  // ==========================================================================
  describe('6. Administrative Security, Image Magic Bytes & Audit Logs', () => {
    it('allows authenticated allowlisted Admin to perform product CRUD, rejects SVG uploads, sanitizes site content XSS, and records audit logs', async () => {
      const admin = await loginCustomer('valid-admin-token', true);
      expect(admin.res.status).toBe(200);

      // 1. Reject SVG disguised as image upload
      const svgBase64 = Buffer.from('<svg onload="alert(1)"></svg>').toString('base64');
      const svgRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/products', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            name: 'Malicious SVG Vessel',
            category: 'Edible',
            description: 'Testing SVG upload rejection.',
            pricePaise: 5000,
            volume: '250ml',
            notes: 'Test | Herbal',
            images: [`data:image/svg+xml;base64,${svgBase64}`]
          })
        }),
        TEST_ENV
      );
      expect(svgRes.status).toBe(400);

      // 2. Accept valid WebP magic bytes ("RIFF....WEBP") and create product
      const validWebpBytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
        0x20
      ]);
      const validWebpBase64 = `data:image/webp;base64,${Buffer.from(validWebpBytes).toString('base64')}`;

      const createRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/products', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            name: 'Kashmiri Saffron Reserve Oil',
            category: 'Gastronomic Edible',
            filterTag: 'Edible',
            description: 'Infused with Pampore Mongra saffron stigmas in cold-pressed almond oil.',
            pricePaise: 14500,
            volume: '100ml',
            notes: 'Crocus Sativus | Warm, Honeyed, Earthy',
            images: [validWebpBase64, '', '']
          })
        }),
        TEST_ENV
      );
      expect(createRes.status).toBe(201);
      const createdProd = (await createRes.json()) as {
        data: { uuid: string; images: [string, string, string]; pricePaise: number };
      };
      expect(createdProd.data.pricePaise).toBe(14500);
      expect(createdProd.data.images[0]).toMatch(/^\/api\/v1\/media\//);

      // 3. Sanitize XSS in site content update
      const cmsRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/site-content', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            heroBanner: 'Purified Botanical & Culinary Extracts',
            heroTitleHtml:
              'SACRED <span class="italic text-accentGold">OILS</span> <script>alert("xss")</script>',
            heroSubtitle: 'Hand-harvested edible elixirs.',
            manifestoTitle: 'Ancient Extraction',
            manifestoP1: 'Paragraph 1 copy.',
            manifestoP2: 'Paragraph 2 copy.'
          })
        }),
        TEST_ENV
      );
      expect(cmsRes.status).toBe(200);
      const cmsData = (await cmsRes.json()) as { data: { heroTitleHtml: string } };
      expect(cmsData.data.heroTitleHtml).toContain('<span class="italic text-accentGold">OILS</span>');
      expect(cmsData.data.heroTitleHtml).not.toContain('<script>');

      // 4. Verify administrative audit logs were recorded
      expect(testDb.adminAuditLogs.length).toBeGreaterThanOrEqual(2);
    });

    it('verifies courier webhook HMAC-SHA256 signatures and rejects forged or replayed webhooks', async () => {
      const cust = await loginCustomer('valid-customer-a');
      const admin = await loginCustomer('valid-admin-token', true);

      // Create order and attach AWB tracking
      const orderRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 1, quantity: 1 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: 'idem-webhook-test',
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );
      const orderJson = (await orderRes.json()) as { data: { orderId: string } };

      await worker.fetch(
        new Request(`https://vatsom.com/api/v1/admin/orders/${orderJson.data.orderId}/tracking`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            courierCode: 'BLUEDART',
            courierName: 'BlueDart Priority',
            awbNumber: 'BD123456789IN',
            currentShipmentState: 'MANIFESTED'
          })
        }),
        TEST_ENV
      );

      const rawPayload = JSON.stringify({
        awbNumber: 'BD123456789IN',
        shipmentState: 'OUT_FOR_DELIVERY',
        orderStatus: 'OUT_FOR_DELIVERY'
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const validSig = await hmacSha256Hex(TEST_ENV.COURIER_WEBHOOK_SECRET!, `${ts}.${rawPayload}`);

      // Forged signature -> 403
      const badWebhook = await worker.fetch(
        new Request('https://vatsom.com/api/v1/webhooks/courier', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-courier-timestamp': ts,
            'x-courier-signature': 'deadbeef'
          },
          body: rawPayload
        }),
        TEST_ENV
      );
      expect(badWebhook.status).toBe(403);

      // Valid signature -> 200
      const goodWebhook = await worker.fetch(
        new Request('https://vatsom.com/api/v1/webhooks/courier', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-courier-timestamp': ts,
            'x-courier-signature': validSig
          },
          body: rawPayload
        }),
        TEST_ENV
      );
      expect(goodWebhook.status).toBe(200);
    });
  });

  // ==========================================================================
  // 7. PRE-LAUNCH VERIFICATION: EXHAUSTIVE DIRECT ADMIN API REJECTION
  // ==========================================================================
  describe('7. Exhaustive Direct Admin API Rejection for Normal Customer Accounts', () => {
    it('rejects every single administrative API route server-side when manually called by an authenticated customer account', async () => {
      const cust = await loginCustomer('valid-customer-a');

      const adminRequests: Array<{ method: string; path: string; body?: unknown }> = [
        { method: 'GET', path: '/api/v1/admin/overview' },
        { method: 'GET', path: '/api/v1/admin/orders' },
        { method: 'PATCH', path: '/api/v1/admin/orders/VTS-2026-TEST', body: { status: 'Delivered' } },
        { method: 'PUT', path: '/api/v1/admin/orders/VTS-2026-TEST', body: { status: 'Delivered' } },
        { method: 'DELETE', path: '/api/v1/admin/orders/VTS-2026-TEST' },
        {
          method: 'PATCH',
          path: '/api/v1/admin/orders/VTS-2026-TEST/tracking',
          body: {
            courierCode: 'BLUEDART',
            courierName: 'BlueDart',
            awbNumber: 'BD999',
            currentShipmentState: 'IN_TRANSIT'
          }
        },
        {
          method: 'PUT',
          path: '/api/v1/admin/orders/VTS-2026-TEST/tracking',
          body: {
            courierCode: 'BLUEDART',
            courierName: 'BlueDart',
            awbNumber: 'BD999',
            currentShipmentState: 'IN_TRANSIT'
          }
        },
        { method: 'GET', path: '/api/v1/admin/products' },
        {
          method: 'POST',
          path: '/api/v1/admin/products',
          body: {
            name: 'Unauthorized Elixir',
            category: 'Edible',
            description: 'Attempted customer creation of admin product',
            pricePaise: 1000,
            volume: '100ml',
            notes: 'Forbidden | Test'
          }
        },
        { method: 'PATCH', path: '/api/v1/admin/products/1', body: { pricePaise: 100 } },
        { method: 'PUT', path: '/api/v1/admin/products/1', body: { pricePaise: 100 } },
        { method: 'DELETE', path: '/api/v1/admin/products/1' },
        {
          method: 'PATCH',
          path: '/api/v1/admin/site-content',
          body: {
            heroBanner: 'Hacked',
            heroTitleHtml: 'Hacked',
            heroSubtitle: 'Hacked correctly',
            manifestoTitle: 'Hacked',
            manifestoP1: 'Hacked paragraph one content',
            manifestoP2: 'Hacked paragraph two content'
          }
        },
        {
          method: 'PUT',
          path: '/api/v1/admin/site-content',
          body: {
            heroBanner: 'Hacked',
            heroTitleHtml: 'Hacked',
            heroSubtitle: 'Hacked correctly',
            manifestoTitle: 'Hacked',
            manifestoP1: 'Hacked paragraph one content',
            manifestoP2: 'Hacked paragraph two content'
          }
        },
        { method: 'GET', path: '/api/v1/admin/audit-logs' },
        { method: 'POST', path: '/api/v1/admin/migrate-localstorage', body: { dryRun: true } },
        { method: 'POST', path: '/api/v1/admin/migrate-legacy', body: { dryRun: true } },
        { method: 'GET', path: '/api/v1/admin/notifications/outbox' },
        { method: 'POST', path: '/api/v1/admin/notifications/dispatch', body: {} }
      ];

      for (const reqSpec of adminRequests) {
        // 1. Authenticated Customer with valid session + valid CSRF token -> MUST be 403 Forbidden
        const custRes = await worker.fetch(
          new Request(`https://vatsom.com${reqSpec.path}`, {
            method: reqSpec.method,
            headers: {
              ...(reqSpec.body ? { 'Content-Type': 'application/json' } : {}),
              Cookie: cust.cookieHeader,
              'X-CSRF-Token': cust.csrfToken,
              Origin: 'https://vatsom.com'
            },
            ...(reqSpec.body ? { body: JSON.stringify(reqSpec.body) } : {})
          }),
          TEST_ENV
        );
        expect(custRes.status, `Customer access to ${reqSpec.method} ${reqSpec.path}`).toBe(403);

        // 2. Unauthenticated caller -> MUST be 401 Unauthorized
        const unauthRes = await worker.fetch(
          new Request(`https://vatsom.com${reqSpec.path}`, {
            method: reqSpec.method,
            headers: {
              ...(reqSpec.body ? { 'Content-Type': 'application/json' } : {}),
              Origin: 'https://vatsom.com'
            },
            ...(reqSpec.body ? { body: JSON.stringify(reqSpec.body) } : {})
          }),
          TEST_ENV
        );
        expect(unauthRes.status, `Unauthenticated access to ${reqSpec.method} ${reqSpec.path}`).toBe(401);
      }
    });
  });

  // ==========================================================================
  // 8. MULTI-IP RATE LIMITING & NEGATIVE ID PROTECTION IN CART / ORDERS
  // ==========================================================================
  describe('8. Multi-IP Rate Limiting & Negative ID Protection', () => {
    it('enforces per-customer and per-phone checkout rate limits even when an attacker rotates IP addresses on every request', async () => {
      const cust = await loginCustomer('valid-customer-a');

      const statuses: number[] = [];
      // Send 8 checkout requests, each from a completely different CF-Connecting-IP
      for (let i = 0; i < 8; i++) {
        const res = await worker.fetch(
          new Request('https://vatsom.com/api/v1/orders', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: cust.cookieHeader,
              'X-CSRF-Token': cust.csrfToken,
              Origin: 'https://vatsom.com',
              'CF-Connecting-IP': `198.51.100.${20 + i}`
            },
            body: JSON.stringify({
              items: [{ legacyId: 1, quantity: 1 }],
              deliveryAddress: {
                recipientName: 'Lady Eleanor Vance',
                phoneNumber: '9876543210',
                addressLine1: '14 Chancery Lane',
                city: 'New Delhi',
                state: 'Delhi',
                pinCode: '110001'
              },
              idempotencyKey: `idem-multi-ip-${i}-${crypto.randomUUID()}`,
              turnstileToken: `valid-ts-${crypto.randomUUID()}`
            })
          }),
          TEST_ENV
        );
        statuses.push(res.status);
      }

      // Even though every IP was unique, per-account/per-phone rate limiting triggers HTTP 429
      expect(statuses).toContain(429);
    });

    it('rejects negative or zero IDs in cart checkout payloads, product lookups, and order lookups with 400 ValidationError', async () => {
      const cust = await loginCustomer('valid-customer-a');
      const admin = await loginCustomer('valid-admin-token', true);

      // 1. Negative legacyId in checkout items -> 400
      const negCartLegacyRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: -1, quantity: 1 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: `idem-neg-id-${crypto.randomUUID()}`,
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );
      expect(negCartLegacyRes.status).toBe(400);

      // 2. Negative productId string (e.g. from unquoted UUID subtraction bug "-111100013332") -> 400
      const negCartProdIdRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ productId: '-111100013332', quantity: 1 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: `idem-neg-uuid-${crypto.randomUUID()}`,
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );
      expect(negCartProdIdRes.status).toBe(400);

      // 3. Negative product lookup (/api/v1/products/-1 and /api/v1/products/0) -> 400
      const negProdGet = await worker.fetch(
        new Request('https://vatsom.com/api/v1/products/-1'),
        TEST_ENV
      );
      expect(negProdGet.status).toBe(400);

      const zeroProdGet = await worker.fetch(
        new Request('https://vatsom.com/api/v1/products/0'),
        TEST_ENV
      );
      expect(zeroProdGet.status).toBe(400);

      // 4. Negative order ID in customer & admin order lookups -> 400
      const negOrderGet = await worker.fetch(
        new Request('https://vatsom.com/api/v1/customer/orders/-5', {
          headers: { Cookie: cust.cookieHeader }
        }),
        TEST_ENV
      );
      expect(negOrderGet.status).toBe(400);

      const negAdminOrderPatch = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/orders/-5', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({ status: 'Delivered' })
        }),
        TEST_ENV
      );
      expect(negAdminOrderPatch.status).toBe(400);
    });
  });

  // ==========================================================================
  // 9. NOTIFICATION OUTBOX DISPATCHER, RETRIES, DEDUPLICATION & MONITORING
  // ==========================================================================
  describe('9. Notification Outbox Processing, Retries, Deduplication & Monitoring', () => {
    it('dispatches pending notifications when provider is configured, prevents duplicate delivery on re-runs, and retries transient failures with backoff', async () => {
      const cust = await loginCustomer('valid-customer-a');
      const admin = await loginCustomer('valid-admin-token', true);

      // 1. Place order while EMAIL_PROVIDER='none' -> job stored as PROVIDER_NOT_CONFIGURED
      const orderRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 1, quantity: 1 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: `idem-outbox-test-${crypto.randomUUID()}`,
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );
      expect(orderRes.status).toBe(201);

      // Check outbox monitoring via Admin API -> 1 job in providerNotConfigured
      const monitorRes1 = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/notifications/outbox', {
          headers: { Cookie: admin.cookieHeader }
        }),
        TEST_ENV
      );
      expect(monitorRes1.status).toBe(200);
      const monitorData1 = (await monitorRes1.json()) as {
        data: { counts: { providerNotConfigured: number; sent: number } };
      };
      expect(monitorData1.data.counts.providerNotConfigured).toBeGreaterThanOrEqual(1);

      // 2. Simulate transient email provider failure -> status becomes FAILED, attempt_count = 1, next_attempt_at in future
      const failingEnv: Env = {
        ...TEST_ENV,
        EMAIL_PROVIDER: 'mock',
        EMAIL_PROVIDER_API_KEY: 'SIMULATE_PROVIDER_FAILURE'
      };

      const failDispatchRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/notifications/dispatch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({})
        }),
        failingEnv
      );
      expect(failDispatchRes.status).toBe(200);
      const failDispatchJson = (await failDispatchRes.json()) as {
        data: { processed: number; sent: number; deferred: number };
      };
      expect(failDispatchJson.data.sent).toBe(0);
      expect(failDispatchJson.data.deferred).toBeGreaterThanOrEqual(1);

      // Move next_attempt_at to now so the retry window is ready
      for (const job of testDb.notificationOutbox.values()) {
        job.next_attempt_at = new Date(Date.now() - 1000).toISOString();
      }

      // 3. Configure healthy email provider and run scheduled cron handler -> job transitions to SENT
      const activeEmailEnv: Env = {
        ...TEST_ENV,
        EMAIL_PROVIDER: 'mock',
        EMAIL_PROVIDER_API_KEY: 'live-api-key-vatsom'
      };
      await worker.scheduled({}, activeEmailEnv);

      const monitorRes2 = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/notifications/outbox', {
          headers: { Cookie: admin.cookieHeader }
        }),
        activeEmailEnv
      );
      const monitorData2 = (await monitorRes2.json()) as {
        data: {
          counts: { sent: number; failedRetryable: number };
          recentJobs: Array<{ status: string; provider_message_id: string | null; attempt_count: number }>;
        };
      };
      expect(monitorData2.data.counts.sent).toBeGreaterThanOrEqual(1);
      expect(monitorData2.data.recentJobs[0]?.status).toBe('SENT');
      expect(monitorData2.data.recentJobs[0]?.provider_message_id).toContain('provider-mock-');
      expect(monitorData2.data.recentJobs[0]?.attempt_count).toBe(2);

      // 4. Duplicate-delivery protection: re-running dispatch sends 0 duplicate emails
      const duplicateRunRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/notifications/dispatch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({})
        }),
        activeEmailEnv
      );
      const duplicateRunJson = (await duplicateRunRes.json()) as {
        data: { processed: number; sent: number };
      };
      expect(duplicateRunJson.data.sent).toBe(0);
    });

    it('recovers stale PROCESSING outbox leases and re-queues exhausted FAILED jobs without double-sending', async () => {
      const cust = await loginCustomer('valid-customer-a');
      const admin = await loginCustomer('valid-admin-token', true);

      const orderRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 1, quantity: 1 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: 'idem-outbox-recovery-1',
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );
      expect(orderRes.status).toBe(201);

      // Simulate a worker crash leaving the job stuck in PROCESSING 10 minutes ago
      for (const job of testDb.notificationOutbox.values()) {
        job.status = 'PROCESSING';
        job.attempt_count = 1;
        job.max_attempts = 5;
        job.sent_at = null;
        job.provider_message_id = null;
        job.updated_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      }

      const activeEmailEnv: Env = {
        ...TEST_ENV,
        EMAIL_PROVIDER: 'mock',
        EMAIL_PROVIDER_API_KEY: 'live-api-key-vatsom'
      };

      const staleRecoveryRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/notifications/dispatch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({})
        }),
        activeEmailEnv
      );
      expect(staleRecoveryRes.status).toBe(200);
      const staleRecoveryJson = (await staleRecoveryRes.json()) as {
        data: { recoveredStale: number; sent: number };
      };
      expect(staleRecoveryJson.data.recoveredStale).toBeGreaterThanOrEqual(1);
      expect(staleRecoveryJson.data.sent).toBeGreaterThanOrEqual(1);

      // Simulate a second job that exhausted all 5 attempts during a prolonged provider outage
      testDb.notificationOutbox.set('exhausted-job-1', {
        id: crypto.randomUUID(),
        channel: 'EMAIL',
        message_category: 'TRANSACTIONAL',
        template_name: 'ORDER_DISPATCHED',
        recipient_email: 'patron.a@example.com',
        dedupe_key: 'exhausted-job-1',
        payload: JSON.stringify({ publicOrderRef: 'VTS-EXHAUSTED' }),
        status: 'FAILED',
        attempt_count: 5,
        max_attempts: 5,
        provider_message_id: null,
        sent_at: null,
        last_error: 'Simulated 5x timeout',
        next_attempt_at: new Date(Date.now() - 1000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      const exhRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/admin/notifications/dispatch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({ recoverExhausted: true })
        }),
        activeEmailEnv
      );
      expect(exhRes.status).toBe(200);
      const exhJson = (await exhRes.json()) as {
        data: { recoveredExhausted: number; sent: number };
      };
      expect(exhJson.data.recoveredExhausted).toBe(1);
      expect(exhJson.data.sent).toBe(1);
    });

    it('restores inventory exactly once on Courier Webhook RETURN_TO_ORIGIN and blocks invalid terminal transitions', async () => {
      const cust = await loginCustomer('valid-customer-a');
      const admin = await loginCustomer('valid-admin-token', true);

      // Initial stock of product 1 is 10; order 3 units -> stock becomes 7
      const orderRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            items: [{ legacyId: 1, quantity: 3 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: 'idem-rto-verify-1',
            turnstileToken: `valid-ts-${crypto.randomUUID()}`
          })
        }),
        TEST_ENV
      );
      expect(orderRes.status).toBe(201);
      const orderData = (await orderRes.json()) as { data: { orderId: string } };
      expect(testDb.products.get('11111111-1111-4111-8111-111111111111')?.stock_quantity).toBe(7);

      // Admin assigns AWB number
      const trackRes = await worker.fetch(
        new Request(`https://vatsom.com/api/v1/admin/orders/${orderData.data.orderId}/tracking`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({
            courierCode: 'BLUEDART',
            courierName: 'BlueDart Priority',
            awbNumber: 'BD-RTO-9001',
            currentShipmentState: 'IN_TRANSIT'
          })
        }),
        TEST_ENV
      );
      expect(trackRes.status).toBe(200);

      // Courier webhook reports RETURN_TO_ORIGIN -> stock must restore from 7 back to 10 and COD remittance becomes VOIDED
      const ts = String(Math.floor(Date.now() / 1000));
      const webhookPayload = JSON.stringify({
        awbNumber: 'BD-RTO-9001',
        shipmentState: 'RTO_IN_TRANSIT',
        orderStatus: 'RETURN_TO_ORIGIN',
        note: 'Consignee unavailable after 3 delivery attempts'
      });
      const sig = await hmacSha256Hex(TEST_ENV.COURIER_WEBHOOK_SECRET!, `${ts}.${webhookPayload}`);

      const whRes = await worker.fetch(
        new Request('https://vatsom.com/api/v1/webhooks/courier', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-courier-signature': sig,
            'x-courier-timestamp': ts
          },
          body: webhookPayload
        }),
        TEST_ENV
      );
      expect(whRes.status).toBe(200);
      expect(testDb.products.get('11111111-1111-4111-8111-111111111111')?.stock_quantity).toBe(10);

      // Subsequent Admin DELETE / Cancel on the already-RTO order must NOT double-increment stock (stays 10)
      const cancelAgainRes = await worker.fetch(
        new Request(`https://vatsom.com/api/v1/admin/orders/${orderData.data.orderId}`, {
          method: 'DELETE',
          headers: {
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          }
        }),
        TEST_ENV
      );
      expect(cancelAgainRes.status).toBe(200);
      expect(testDb.products.get('11111111-1111-4111-8111-111111111111')?.stock_quantity).toBe(10);

      // Attempting to reopen a terminal RETURN_TO_ORIGIN / CANCELLED order back to Dispatched must be blocked with 409
      const reopenRes = await worker.fetch(
        new Request(`https://vatsom.com/api/v1/admin/orders/${orderData.data.orderId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: admin.cookieHeader,
            'X-CSRF-Token': admin.csrfToken,
            Origin: 'https://vatsom.com'
          },
          body: JSON.stringify({ status: 'Dispatched' })
        }),
        TEST_ENV
      );
      expect(reopenRes.status).toBe(409);
    });
  });

  // ==========================================================================
  // 10. vatsom.in MULTI-DOMAIN ARCHITECTURE, CLOUDFLARE ACCESS JWT & HSTS
  // ==========================================================================
  describe('10. vatsom.in Multi-Domain Routing, Cloudflare Access JWT, Cross-Subdomain Auth & HSTS', () => {
    const VATSOM_IN_ENV: Env = {
      ...TEST_ENV,
      ENVIRONMENT: 'production',
      APP_ORIGIN: 'https://vatsom.in',
      ADMIN_ORIGIN: 'https://admin.vatsom.in',
      API_ORIGIN: 'https://api.vatsom.in',
      COOKIE_DOMAIN: 'vatsom.in',
      TURNSTILE_ALLOWED_HOSTNAMES: 'vatsom.in,admin.vatsom.in',
      ENABLE_HSTS: 'false',
      ASSETS: {
        fetch: async (req: Request) => {
          const u = new URL(req.url);
          return new Response(`ASSET:${u.pathname}`, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
      }
    };

    it('permanently redirects https://www.vatsom.in to https://vatsom.in with 301 preserving path and query', async () => {
      const res = await worker.fetch(
        new Request('https://www.vatsom.in/catalogue?division=TABLE'),
        VATSOM_IN_ENV
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toBe('https://vatsom.in/catalogue?division=TABLE');
    });

    it('isolates vatsom.in (storefront), api.vatsom.in (API only), and admin.vatsom.in (admin portal)', async () => {
      // 1. Storefront root on vatsom.in serves storefront asset
      const storeRoot = await worker.fetch(new Request('https://vatsom.in/'), VATSOM_IN_ENV);
      expect(storeRoot.status).toBe(200);
      expect(await storeRoot.text()).toBe('ASSET:/');

      // 2. Admin portal HTML and Admin API routes are blocked (404) on the customer storefront hostname (vatsom.in)
      const storeAdminHtml = await worker.fetch(
        new Request('https://vatsom.in/admin-portal.html'),
        VATSOM_IN_ENV
      );
      expect(storeAdminHtml.status).toBe(404);

      const storeAdminApi = await worker.fetch(
        new Request('https://vatsom.in/api/v1/admin/overview'),
        VATSOM_IN_ENV
      );
      expect(storeAdminApi.status).toBe(404);

      // 3. Dedicated API hostname (api.vatsom.in) serves /api/v1/* and blocks HTML static assets (404)
      const apiHtmlAttempt = await worker.fetch(
        new Request('https://api.vatsom.in/admin-portal.html'),
        VATSOM_IN_ENV
      );
      expect(apiHtmlAttempt.status).toBe(404);

      const apiHealth = await worker.fetch(
        new Request('https://api.vatsom.in/api/v1/health', {
          headers: { Origin: 'https://vatsom.in' }
        }),
        VATSOM_IN_ENV
      );
      expect(apiHealth.status).toBe(200);
      expect(apiHealth.headers.get('Access-Control-Allow-Origin')).toBe('https://vatsom.in');
      expect(apiHealth.headers.get('Content-Security-Policy')).toContain('https://api.vatsom.in');

      // 4. Dedicated Admin hostname (admin.vatsom.in) rewrites / to /admin-portal.html and blocks /vatsom_premium_oils.html
      const adminRoot = await worker.fetch(new Request('https://admin.vatsom.in/'), VATSOM_IN_ENV);
      expect(adminRoot.status).toBe(200);
      expect(await adminRoot.text()).toBe('ASSET:/admin-portal.html');

      const adminStorefrontAttempt = await worker.fetch(
        new Request('https://admin.vatsom.in/vatsom_premium_oils.html'),
        VATSOM_IN_ENV
      );
      expect(adminStorefrontAttempt.status).toBe(404);
    });

    it('enforces cryptographic Cloudflare Access JWT verification on admin.vatsom.in and /api/v1/admin/* when CF_ACCESS_AUD is configured', async () => {
      const cfProtectedEnv: Env = {
        ...VATSOM_IN_ENV,
        CF_ACCESS_TEAM_DOMAIN: 'vatsom-atelier.cloudflareaccess.com',
        CF_ACCESS_AUD: 'aud-tag-vatsom-admin-12345'
      };

      setTestCfAccessVerifier(async (jwtAssertion, teamDomain, expectedAud) => {
        if (
          jwtAssertion === 'valid-cf-access-jwt' &&
          teamDomain === 'vatsom-atelier.cloudflareaccess.com' &&
          expectedAud === 'aud-tag-vatsom-admin-12345'
        ) {
          return { email: 'admin@vatsom.com', sub: 'google-sub-admin-1' };
        }
        throw new Error('Invalid CF Access signature or AUD');
      });

      try {
        // 1. Request to https://admin.vatsom.in/ without Cf-Access-Jwt-Assertion -> 403
        const noHeaderRes = await worker.fetch(
          new Request('https://admin.vatsom.in/'),
          cfProtectedEnv
        );
        expect(noHeaderRes.status).toBe(403);

        // 2. Request with forged/invalid Cf-Access-Jwt-Assertion -> 403
        const forgedRes = await worker.fetch(
          new Request('https://admin.vatsom.in/', {
            headers: { 'Cf-Access-Jwt-Assertion': 'forged-unsigned-token' }
          }),
          cfProtectedEnv
        );
        expect(forgedRes.status).toBe(403);

        // 3. Request with valid Cf-Access-Jwt-Assertion -> 200
        const validRes = await worker.fetch(
          new Request('https://admin.vatsom.in/', {
            headers: { 'Cf-Access-Jwt-Assertion': 'valid-cf-access-jwt' }
          }),
          cfProtectedEnv
        );
        expect(validRes.status).toBe(200);
      } finally {
        setTestCfAccessVerifier(null);
      }
    });

    it('supports cross-subdomain authentication across vatsom.in, admin.vatsom.in, and api.vatsom.in without customer login overwriting admin session', async () => {
      // 1. Admin logs in via https://api.vatsom.in/api/v1/auth/google from https://admin.vatsom.in
      const adminLoginRes = await worker.fetch(
        new Request('https://api.vatsom.in/api/v1/auth/google', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://admin.vatsom.in'
          },
          body: JSON.stringify({
            credential: `valid-admin-token-${crypto.randomUUID()}`,
            adminPortalLogin: true
          })
        }),
        VATSOM_IN_ENV
      );
      expect(adminLoginRes.status).toBe(200);
      expect(adminLoginRes.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://admin.vatsom.in'
      );

      const adminSetCookieHeader = adminLoginRes.headers.get('set-cookie') || '';
      expect(adminSetCookieHeader).toContain('Domain=vatsom.in');
      expect(adminSetCookieHeader).toContain('vatsom_admin_session=');

      const adminCookies = extractCookies(adminLoginRes);

      // 2. Customer logs in on https://vatsom.in -> sets vatsom_session; admin's vatsom_admin_session remains intact
      const custLoginRes = await worker.fetch(
        new Request('https://api.vatsom.in/api/v1/auth/google', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://vatsom.in'
          },
          body: JSON.stringify({
            credential: `valid-customer-a-${crypto.randomUUID()}`,
            adminPortalLogin: false
          })
        }),
        VATSOM_IN_ENV
      );
      expect(custLoginRes.status).toBe(200);
      const custCookies = extractCookies(custLoginRes);

      // Combine customer vatsom_session with admin's vatsom_admin_session in the same browser cookie jar for *.vatsom.in
      const adminOnlyPart = adminCookies.cookieHeader
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('vatsom_admin_'))
        .join('; ');
      const combinedBrowserCookies = `${custCookies.cookieHeader}; ${adminOnlyPart}`;

      // 3. Admin portal calling /api/v1/auth/me with X-Vatsom-Portal: admin resolves the admin session & returns csrfToken
      const adminMeRes = await worker.fetch(
        new Request('https://api.vatsom.in/api/v1/auth/me', {
          headers: {
            Cookie: combinedBrowserCookies,
            Origin: 'https://admin.vatsom.in',
            'X-Vatsom-Portal': 'admin'
          }
        }),
        VATSOM_IN_ENV
      );
      expect(adminMeRes.status).toBe(200);
      const adminMeJson = (await adminMeRes.json()) as {
        data: { authenticated: boolean; sessionScope: string; csrfToken?: string };
      };
      expect(adminMeJson.data.authenticated).toBe(true);
      expect(adminMeJson.data.sessionScope).toBe('admin');
      expect(adminMeJson.data.csrfToken).toBe(adminCookies.csrfToken);
    });

    it('rejects Turnstile tokens solved on unauthorized hostnames when TURNSTILE_ALLOWED_HOSTNAMES is set and controls HSTS via ENABLE_HSTS', async () => {
      const cust = await loginCustomer('valid-customer-a');

      setTestTurnstileFetcher(async (_secret, token) => ({
        success: true,
        hostname: token.includes('phishing-host') ? 'evil-clone.example.com' : 'vatsom.in',
        action: 'checkout'
      }));

      const wrongHostRes = await worker.fetch(
        new Request('https://api.vatsom.in/api/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cust.cookieHeader,
            'X-CSRF-Token': cust.csrfToken,
            Origin: 'https://vatsom.in'
          },
          body: JSON.stringify({
            items: [{ legacyId: 1, quantity: 1 }],
            deliveryAddress: {
              recipientName: 'Lady Eleanor Vance',
              phoneNumber: '9876543210',
              addressLine1: '14 Chancery Lane',
              city: 'New Delhi',
              state: 'Delhi',
              pinCode: '110001'
            },
            idempotencyKey: 'idem-turnstile-host-check',
            turnstileToken: 'valid-ts-phishing-host-12345'
          })
        }),
        VATSOM_IN_ENV
      );
      expect(wrongHostRes.status).toBe(403);

      // Verify HSTS is omitted when ENABLE_HSTS="false", and emitted without premature preload when ENABLE_HSTS="true"
      expect(wrongHostRes.headers.get('Strict-Transport-Security')).toBeNull();

      const hstsEnabledRes = await worker.fetch(
        new Request('https://api.vatsom.in/api/v1/health'),
        { ...VATSOM_IN_ENV, ENABLE_HSTS: 'true' }
      );
      expect(hstsEnabledRes.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    });
  });
});
