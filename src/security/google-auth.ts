import { createRemoteJWKSet, jwtVerify } from 'jose';
import { sha256Hex } from '../crypto';
import { DatabaseClient } from '../db/client';
import { AuthenticationError } from '../errors';
import { Env } from '../types';

export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
  nonce?: string;
  exp: number;
}

export type GoogleTokenVerifier = (
  idToken: string,
  expectedClientId: string
) => Promise<VerifiedGoogleIdentity>;

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

let customGoogleVerifier: GoogleTokenVerifier | null = null;

export function setTestGoogleTokenVerifier(verifier: GoogleTokenVerifier | null): void {
  customGoogleVerifier = verifier;
}

async function defaultGoogleTokenVerifier(
  idToken: string,
  expectedClientId: string
): Promise<VerifiedGoogleIdentity> {
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: expectedClientId,
      clockTolerance: 5
    });

    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const emailVerified = payload.email_verified === true;
    const name =
      typeof payload.name === 'string' && payload.name.trim().length > 0
        ? payload.name.trim()
        : email.split('@')[0] || 'Vatsom Patron';
    const exp = typeof payload.exp === 'number' ? payload.exp : 0;

    return {
      sub,
      email,
      emailVerified,
      name,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
      nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
      exp
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('exp') || msg.includes('expired')) {
      throw new AuthenticationError('Google ID token has expired.');
    }
    if (msg.includes('aud') || msg.includes('audience')) {
      throw new AuthenticationError('Google ID token audience does not match VATSOM client ID.');
    }
    if (msg.includes('iss') || msg.includes('issuer')) {
      throw new AuthenticationError('Google ID token issuer is invalid.');
    }
    throw new AuthenticationError('Invalid Google ID token signature or claims.');
  }
}

export function isEmailOrSubInAdminAllowlist(env: Env, email: string, googleSub: string): boolean {
  const raw = env.ADMIN_ALLOWLIST || '';
  if (!raw.trim()) return false;
  const entries = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return entries.includes(email.toLowerCase()) || entries.includes(googleSub.toLowerCase());
}

/**
 * Verifies a Google Identity Services ID token server-side, checks verified email status,
 * validates optional nonce, and prevents ID token replay.
 */
export async function verifyGoogleIdToken(
  db: DatabaseClient,
  env: Env,
  idToken: string,
  expectedNonce?: string
): Promise<VerifiedGoogleIdentity> {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new AuthenticationError('Server Google OAuth client ID is not configured.');
  }

  // 1. Check replay cache first
  const tokenHash = await sha256Hex(`google_jwt:${idToken.trim()}`);
  const consumed = await db.query<{ token_hash: string }>(
    `SELECT token_hash FROM consumed_security_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  if (consumed.rowCount > 0) {
    throw new AuthenticationError('Google ID token has already been used (replay rejected).');
  }

  // 2. Cryptographically verify JWT signature, issuer, audience, and expiry
  const verifier = customGoogleVerifier ?? defaultGoogleTokenVerifier;
  const identity = await verifier(idToken.trim(), clientId);

  if (!identity.sub || !identity.email) {
    throw new AuthenticationError('Google ID token is missing required subject or email claims.');
  }

  if (identity.emailVerified !== true) {
    throw new AuthenticationError('Google account email address is not verified.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (identity.exp <= nowSeconds) {
    throw new AuthenticationError('Google ID token has expired.');
  }

  if (expectedNonce && identity.nonce !== expectedNonce) {
    throw new AuthenticationError('Google ID token nonce mismatch.');
  }

  // 3. Mark token as consumed until its expiration timestamp
  const expiresAtIso = new Date((identity.exp + 300) * 1000).toISOString();
  await db.query(
    `INSERT INTO consumed_security_tokens (token_hash, token_type, expires_at)
     VALUES ($1, 'GOOGLE_ID_TOKEN', $2)
     ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, expiresAtIso]
  );

  return identity;
}

