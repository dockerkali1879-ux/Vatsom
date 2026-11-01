import { sha256Hex } from '../crypto';
import { DatabaseClient } from '../db/client';
import { TurnstileError } from '../errors';
import { Env } from '../types';

export interface TurnstileVerifyResult {
  success: boolean;
  hostname?: string;
  action?: string;
  challenge_ts?: string;
  'error-codes'?: string[];
}

export type TurnstileFetcher = (
  secretKey: string,
  token: string,
  remoteIp?: string
) => Promise<TurnstileVerifyResult>;

let customTurnstileFetcher: TurnstileFetcher | null = null;

export function setTestTurnstileFetcher(fetcher: TurnstileFetcher | null): void {
  customTurnstileFetcher = fetcher;
}

async function defaultTurnstileFetcher(
  secretKey: string,
  token: string,
  remoteIp?: string
): Promise<TurnstileVerifyResult> {
  const formData = new URLSearchParams();
  formData.set('secret', secretKey);
  formData.set('response', token);
  if (remoteIp) {
    formData.set('remoteip', remoteIp);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
      signal: controller.signal
    });
    if (!res.ok) {
      return { success: false, 'error-codes': ['siteverify-http-error'] };
    }
    return (await res.json()) as TurnstileVerifyResult;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Verifies a Cloudflare Turnstile token server-side and prevents token replay.
 */
export async function verifyTurnstileToken(
  db: DatabaseClient,
  env: Env,
  token: string | undefined,
  options?: {
    expectedAction?: string;
    expectedHostname?: string;
    remoteIp?: string;
  }
): Promise<void> {
  if (!token || token.trim().length < 10) {
    throw new TurnstileError('Missing or malformed Turnstile security token.');
  }

  const secretKey = env.TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    throw new TurnstileError('Server Turnstile verification secret is not configured.');
  }

  // 1. Check replay protection table first — each Turnstile token is strictly single-use
  const tokenHash = await sha256Hex(`turnstile:${token.trim()}`);
  const existing = await db.query<{ token_hash: string }>(
    `SELECT token_hash FROM consumed_security_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  if (existing.rowCount > 0) {
    throw new TurnstileError('Turnstile token has already been used (replay rejected).');
  }

  // 2. Verify with Cloudflare Siteverify API (or injected test verifier)
  const fetcher = customTurnstileFetcher ?? defaultTurnstileFetcher;
  const result = await fetcher(secretKey, token.trim(), options?.remoteIp);

  if (!result.success) {
    const codes = result['error-codes'] ?? [];
    if (codes.includes('timeout-or-duplicate')) {
      throw new TurnstileError('Turnstile security challenge has expired or been duplicated.');
    }
    throw new TurnstileError('Turnstile security verification failed.');
  }

  if (options?.expectedAction && result.action && result.action !== options.expectedAction) {
    throw new TurnstileError('Turnstile action mismatch.');
  }

  if (options?.expectedHostname && result.hostname && result.hostname !== options.expectedHostname) {
    throw new TurnstileError('Turnstile hostname mismatch.');
  }

  // 3. Record token hash so it can never be replayed
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await db.query(
    `INSERT INTO consumed_security_tokens (token_hash, token_type, expires_at)
     VALUES ($1, 'TURNSTILE', $2)
     ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, expiresAt]
  );
}

