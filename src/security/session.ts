import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  generateSecureToken,
  parseCookies,
  serializeCookie,
  sha256Hex,
  timingSafeEqualStr
} from '../crypto';
import { DatabaseClient } from '../db/client';
import { AuthenticationError, AuthorizationError, CsrfError } from '../errors';
import { getAllowedOrigins } from '../response';
import { AuthenticatedUser, Env, RequestContext, SessionInfo, UserRole } from '../types';
import { isEmailOrSubInAdminAllowlist } from './google-auth';

export const SESSION_COOKIE_NAME = 'vatsom_session';
export const CSRF_COOKIE_NAME = 'vatsom_csrf';
export const ADMIN_SESSION_COOKIE_NAME = 'vatsom_admin_session';
export const ADMIN_CSRF_COOKIE_NAME = 'vatsom_admin_csrf';

export type CfAccessVerifier = (
  jwtAssertion: string,
  teamDomain: string,
  expectedAud: string
) => Promise<{ email?: string; sub?: string }>;

const cfAccessJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
let customCfAccessVerifier: CfAccessVerifier | null = null;

export function setTestCfAccessVerifier(verifier: CfAccessVerifier | null): void {
  customCfAccessVerifier = verifier;
}

function normalizeTeamDomain(raw: string): string {
  const cleaned = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  if (!cleaned) return '';
  return cleaned.includes('.') ? cleaned : `${cleaned}.cloudflareaccess.com`;
}

async function defaultCfAccessVerifier(
  jwtAssertion: string,
  teamDomain: string,
  expectedAud: string
): Promise<{ email?: string; sub?: string }> {
  const normalizedDomain = normalizeTeamDomain(teamDomain);
  if (!normalizedDomain) {
    throw new AuthorizationError(
      'Cloudflare Access team domain (CF_ACCESS_TEAM_DOMAIN) is not configured for JWT signature verification.'
    );
  }
  const issuer = `https://${normalizedDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let jwks = cfAccessJwksCache.get(certsUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(certsUrl));
    cfAccessJwksCache.set(certsUrl, jwks);
  }

  try {
    const { payload } = await jwtVerify(jwtAssertion, jwks, {
      issuer,
      audience: expectedAud,
      clockTolerance: 5
    });
    return {
      email: typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined,
      sub: typeof payload.sub === 'string' ? payload.sub : undefined
    };
  } catch {
    throw new AuthorizationError('Invalid or expired Cloudflare Access perimeter JWT assertion.');
  }
}

export async function verifyCloudflareAccessJwt(env: Env, request: Request): Promise<void> {
  if (!env.CF_ACCESS_AUD) {
    return;
  }
  const cfAccessJwt = request.headers.get('Cf-Access-Jwt-Assertion')?.trim();
  if (!cfAccessJwt) {
    throw new AuthorizationError('Missing Cloudflare Access perimeter assertion.');
  }
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN || '';
  const verifier = customCfAccessVerifier ?? defaultCfAccessVerifier;
  try {
    await verifier(cfAccessJwt, teamDomain, env.CF_ACCESS_AUD.trim());
  } catch (err) {
    if (err instanceof AuthorizationError) {
      throw err;
    }
    throw new AuthorizationError('Invalid or expired Cloudflare Access perimeter JWT assertion.');
  }
}

export function resolveCookieDomain(env: Env, requestHostname?: string): string | undefined {
  if (env.COOKIE_DOMAIN && env.COOKIE_DOMAIN.trim()) {
    return env.COOKIE_DOMAIN.trim();
  }
  const host = (requestHostname || '').toLowerCase();
  if (host === 'vatsom.in' || host.endsWith('.vatsom.in')) {
    return 'vatsom.in';
  }
  return undefined;
}

export interface IssuedSessionBundle {
  sessionId: string;
  rawSessionToken: string;
  rawCsrfToken: string;
  expiresAt: Date;
  sessionScope: UserRole;
  setCookieHeaders: string[];
}

export async function issueSession(
  db: DatabaseClient,
  env: Env,
  customer: AuthenticatedUser,
  requestedScope: UserRole,
  ipHash: string,
  userAgent: string,
  requestHostname?: string
): Promise<IssuedSessionBundle> {
  // Never issue an admin session unless the customer is an active admin AND in ADMIN_ALLOWLIST
  let effectiveScope: UserRole = 'customer';
  if (requestedScope === 'admin') {
    const allowlisted = isEmailOrSubInAdminAllowlist(env, customer.email, customer.googleSub);
    if (customer.role !== 'admin' || !allowlisted) {
      throw new AuthorizationError(
        'Your Google account is not authorized to access the VATSOM Administrative Chancery.'
      );
    }
    effectiveScope = 'admin';
  }

  const rawSessionToken = generateSecureToken(32);
  const rawCsrfToken = generateSecureToken(24);
  const tokenHash = await sha256Hex(rawSessionToken);
  const csrfTokenHash = await sha256Hex(rawCsrfToken);

  const ttlSeconds =
    effectiveScope === 'admin'
      ? Number(env.ADMIN_SESSION_TTL_SECONDS || 28800)
      : Number(env.SESSION_TTL_SECONDS || 604800);

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const insertRes = await db.query<{ id: string }>(
    `INSERT INTO sessions (
       token_hash,
       csrf_token_hash,
       customer_id,
       session_scope,
       ip_hash,
       user_agent,
       expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      tokenHash,
      csrfTokenHash,
      customer.id,
      effectiveScope,
      ipHash,
      userAgent.slice(0, 255),
      expiresAt.toISOString()
    ]
  );

  const sessionId = insertRes.rows[0]?.id ?? '';
  const isSecure =
    env.ENVIRONMENT === 'production' ||
    env.ENVIRONMENT === 'staging' ||
    env.APP_ORIGIN?.startsWith('https://');
  const cookieDomain = resolveCookieDomain(env, requestHostname);

  const sessionCookie = serializeCookie(SESSION_COOKIE_NAME, rawSessionToken, {
    maxAgeSeconds: ttlSeconds,
    httpOnly: true,
    secure: Boolean(isSecure),
    sameSite: effectiveScope === 'admin' ? 'Strict' : 'Lax',
    path: '/',
    domain: cookieDomain
  });

  // Readable CSRF cookie paired with session-bound CSRF hash verification
  const csrfCookie = serializeCookie(CSRF_COOKIE_NAME, rawCsrfToken, {
    maxAgeSeconds: ttlSeconds,
    httpOnly: false,
    secure: Boolean(isSecure),
    sameSite: effectiveScope === 'admin' ? 'Strict' : 'Lax',
    path: '/',
    domain: cookieDomain
  });

  const setCookieHeaders = [sessionCookie, csrfCookie];

  if (effectiveScope === 'admin') {
    setCookieHeaders.push(
      serializeCookie(ADMIN_SESSION_COOKIE_NAME, rawSessionToken, {
        maxAgeSeconds: ttlSeconds,
        httpOnly: true,
        secure: Boolean(isSecure),
        sameSite: 'Strict',
        path: '/',
        domain: cookieDomain
      }),
      serializeCookie(ADMIN_CSRF_COOKIE_NAME, rawCsrfToken, {
        maxAgeSeconds: ttlSeconds,
        httpOnly: false,
        secure: Boolean(isSecure),
        sameSite: 'Strict',
        path: '/',
        domain: cookieDomain
      })
    );
  }

  return {
    sessionId,
    rawSessionToken,
    rawCsrfToken,
    expiresAt,
    sessionScope: effectiveScope,
    setCookieHeaders
  };
}

export function clearSessionCookies(env: Env, requestHostname?: string): string[] {
  const isSecure =
    env.ENVIRONMENT === 'production' ||
    env.ENVIRONMENT === 'staging' ||
    env.APP_ORIGIN?.startsWith('https://');
  const cookieDomain = resolveCookieDomain(env, requestHostname);
  return [
    serializeCookie(SESSION_COOKIE_NAME, '', {
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: Boolean(isSecure),
      sameSite: 'Lax',
      path: '/',
      domain: cookieDomain
    }),
    serializeCookie(CSRF_COOKIE_NAME, '', {
      maxAgeSeconds: 0,
      httpOnly: false,
      secure: Boolean(isSecure),
      sameSite: 'Lax',
      path: '/',
      domain: cookieDomain
    }),
    serializeCookie(ADMIN_SESSION_COOKIE_NAME, '', {
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: Boolean(isSecure),
      sameSite: 'Strict',
      path: '/',
      domain: cookieDomain
    }),
    serializeCookie(ADMIN_CSRF_COOKIE_NAME, '', {
      maxAgeSeconds: 0,
      httpOnly: false,
      secure: Boolean(isSecure),
      sameSite: 'Strict',
      path: '/',
      domain: cookieDomain
    })
  ];
}

export async function resolveRequestSession(
  db: DatabaseClient,
  request: Request
): Promise<{ user: AuthenticatedUser | null; session: SessionInfo | null }> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const url = new URL(request.url);
  const preferAdminCookie =
    url.pathname.startsWith('/api/v1/admin') ||
    url.hostname.toLowerCase().startsWith('admin.') ||
    request.headers.get('x-vatsom-portal') === 'admin';

  const rawToken = preferAdminCookie
    ? cookies[ADMIN_SESSION_COOKIE_NAME] || cookies[SESSION_COOKIE_NAME]
    : cookies[SESSION_COOKIE_NAME] || cookies[ADMIN_SESSION_COOKIE_NAME];

  if (!rawToken || rawToken.length < 32) {
    return { user: null, session: null };
  }

  const tokenHash = await sha256Hex(rawToken);
  const res = await db.query<{
    session_id: string;
    customer_id: string;
    session_scope: UserRole;
    csrf_token_hash: string;
    expires_at: string;
    revoked_at: string | null;
    google_sub: string;
    name: string;
    email: string;
    email_verified: boolean;
    mobile_number: string | null;
    role: UserRole;
    account_status: 'active' | 'suspended' | 'deleted';
  }>(
    `SELECT
       s.id AS session_id,
       s.customer_id,
       s.session_scope,
       s.csrf_token_hash,
       s.expires_at,
       s.revoked_at,
       c.google_sub,
       c.name,
       c.email,
       c.email_verified,
       c.mobile_number,
       c.role,
       c.account_status
     FROM sessions s
     INNER JOIN customers c ON c.id = s.customer_id
     WHERE s.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );

  const row = res.rows[0];
  if (!row) {
    return { user: null, session: null };
  }

  if (row.revoked_at !== null) {
    return { user: null, session: null };
  }

  const expiresAt = new Date(row.expires_at);
  if (expiresAt.getTime() <= Date.now()) {
    return { user: null, session: null };
  }

  if (row.account_status !== 'active' || !row.email_verified) {
    return { user: null, session: null };
  }

  return {
    user: {
      id: row.customer_id,
      googleSub: row.google_sub,
      name: row.name,
      email: row.email,
      emailVerified: row.email_verified,
      mobileNumber: row.mobile_number,
      role: row.role,
      accountStatus: row.account_status
    },
    session: {
      id: row.session_id,
      customerId: row.customer_id,
      sessionScope: row.session_scope,
      csrfTokenHash: row.csrf_token_hash,
      expiresAt
    }
  };
}

export async function resolveVerifiedCsrfCookie(
  request: Request,
  session: SessionInfo
): Promise<string | undefined> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const candidates = [cookies[ADMIN_CSRF_COOKIE_NAME], cookies[CSRF_COOKIE_NAME]].filter(
    (c): c is string => Boolean(c && c.length >= 16)
  );
  for (const candidate of candidates) {
    const hash = await sha256Hex(candidate);
    if (timingSafeEqualStr(hash, session.csrfTokenHash)) {
      return candidate;
    }
  }
  return undefined;
}

export async function verifyCsrfProtection(ctx: RequestContext): Promise<void> {
  const method = ctx.request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return;
  }

  // Validate Origin header if present (must match either the Worker's own origin or one of the configured allowed origins)
  const origin = ctx.request.headers.get('origin')?.trim().replace(/\/+$/, '');
  if (origin) {
    const allowedOrigins = getAllowedOrigins(ctx.env);
    if (origin !== ctx.url.origin && !allowedOrigins.has(origin)) {
      throw new CsrfError('Cross-origin state-changing request rejected.');
    }
  }

  if (!ctx.session) {
    throw new AuthenticationError();
  }

  const headerCsrf = ctx.request.headers.get('x-csrf-token') || '';
  if (!headerCsrf || headerCsrf.length < 16) {
    throw new CsrfError('Missing X-CSRF-Token header on authenticated mutation.');
  }

  const providedHash = await sha256Hex(headerCsrf);
  if (!timingSafeEqualStr(providedHash, ctx.session.csrfTokenHash)) {
    throw new CsrfError('CSRF token mismatch.');
  }
}

export async function requireAuthenticatedCustomer(
  ctx: RequestContext,
  options?: { requireCsrf?: boolean }
): Promise<AuthenticatedUser> {
  if (!ctx.user || !ctx.session) {
    throw new AuthenticationError('Please sign in with Google to continue.');
  }
  if (ctx.user.accountStatus !== 'active') {
    throw new AuthorizationError('Your customer account is not active.');
  }
  if (options?.requireCsrf !== false) {
    await verifyCsrfProtection(ctx);
  }
  return ctx.user;
}

export async function requireAuthenticatedAdmin(
  ctx: RequestContext,
  options?: { requireCsrf?: boolean }
): Promise<AuthenticatedUser> {
  if (!ctx.user || !ctx.session) {
    throw new AuthenticationError('Administrative authentication is required.');
  }

  // Server-side role & allowlist enforcement — never trust frontend flags or customer sessions
  const isAllowlisted = isEmailOrSubInAdminAllowlist(ctx.env, ctx.user.email, ctx.user.googleSub);
  if (
    ctx.user.role !== 'admin' ||
    ctx.session.sessionScope !== 'admin' ||
    !isAllowlisted ||
    ctx.user.accountStatus !== 'active'
  ) {
    throw new AuthorizationError('Administrative privileges are required for this operation.');
  }

  // Cryptographic Cloudflare Access JWT verification when CF_ACCESS_AUD is configured
  await verifyCloudflareAccessJwt(ctx.env, ctx.request);

  if (options?.requireCsrf !== false) {
    await verifyCsrfProtection(ctx);
  }

  return ctx.user;
}

