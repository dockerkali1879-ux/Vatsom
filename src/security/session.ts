import {
  generateSecureToken,
  parseCookies,
  serializeCookie,
  sha256Hex,
  timingSafeEqualStr
} from '../crypto';
import { DatabaseClient } from '../db/client';
import { AuthenticationError, AuthorizationError, CsrfError } from '../errors';
import { AuthenticatedUser, Env, RequestContext, SessionInfo, UserRole } from '../types';
import { isEmailOrSubInAdminAllowlist } from './google-auth';

export const SESSION_COOKIE_NAME = 'vatsom_session';
export const CSRF_COOKIE_NAME = 'vatsom_csrf';

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
  userAgent: string
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
  const isSecure = env.ENVIRONMENT === 'production' || env.APP_ORIGIN?.startsWith('https://');

  const sessionCookie = serializeCookie(SESSION_COOKIE_NAME, rawSessionToken, {
    maxAgeSeconds: ttlSeconds,
    httpOnly: true,
    secure: Boolean(isSecure),
    sameSite: effectiveScope === 'admin' ? 'Strict' : 'Lax',
    path: '/'
  });

  // Readable CSRF cookie paired with session-bound CSRF hash verification
  const csrfCookie = serializeCookie(CSRF_COOKIE_NAME, rawCsrfToken, {
    maxAgeSeconds: ttlSeconds,
    httpOnly: false,
    secure: Boolean(isSecure),
    sameSite: effectiveScope === 'admin' ? 'Strict' : 'Lax',
    path: '/'
  });

  return {
    sessionId,
    rawSessionToken,
    rawCsrfToken,
    expiresAt,
    sessionScope: effectiveScope,
    setCookieHeaders: [sessionCookie, csrfCookie]
  };
}

export function clearSessionCookies(env: Env): string[] {
  const isSecure = env.ENVIRONMENT === 'production' || env.APP_ORIGIN?.startsWith('https://');
  return [
    serializeCookie(SESSION_COOKIE_NAME, '', {
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: Boolean(isSecure),
      sameSite: 'Lax',
      path: '/'
    }),
    serializeCookie(CSRF_COOKIE_NAME, '', {
      maxAgeSeconds: 0,
      httpOnly: false,
      secure: Boolean(isSecure),
      sameSite: 'Lax',
      path: '/'
    })
  ];
}

export async function resolveRequestSession(
  db: DatabaseClient,
  request: Request
): Promise<{ user: AuthenticatedUser | null; session: SessionInfo | null }> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const rawToken = cookies[SESSION_COOKIE_NAME];
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

export async function verifyCsrfProtection(ctx: RequestContext): Promise<void> {
  const method = ctx.request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return;
  }

  // Validate Origin header if present (must match either configured APP_ORIGIN or the Worker's own origin)
  const origin = ctx.request.headers.get('origin');
  if (
    origin &&
    origin !== ctx.url.origin &&
    (!ctx.env.APP_ORIGIN || origin !== ctx.env.APP_ORIGIN)
  ) {
    throw new CsrfError('Cross-origin state-changing request rejected.');
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

  // Optional Cloudflare Access header verification as an additional perimeter when configured
  if (ctx.env.CF_ACCESS_AUD) {
    const cfAccessJwt = ctx.request.headers.get('Cf-Access-Jwt-Assertion');
    if (!cfAccessJwt) {
      throw new AuthorizationError('Missing Cloudflare Access perimeter assertion.');
    }
  }

  if (options?.requireCsrf !== false) {
    await verifyCsrfProtection(ctx);
  }

  return ctx.user;
}

