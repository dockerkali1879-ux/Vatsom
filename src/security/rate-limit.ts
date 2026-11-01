import { DatabaseClient } from '../db/client';
import { RateLimitError } from '../errors';

export interface RateLimitPolicy {
  scope: string;
  identifier: string;
  maxRequests: number;
  windowSeconds: number;
}

/**
 * Enforces persistent application-level rate limits across one or more dimensions
 * (e.g., IP hash, Customer ID, Email hash, Phone number hash).
 * Uses atomic upsert in PostgreSQL `rate_limit_counters` so limits are consistent across Worker isolates.
 */
export async function enforceRateLimits(
  db: DatabaseClient,
  policies: RateLimitPolicy[]
): Promise<void> {
  const now = Date.now();

  for (const policy of policies) {
    if (!policy.identifier) continue;
    const windowMs = policy.windowSeconds * 1000;
    const windowIndex = Math.floor(now / windowMs);
    const bucketKey = `${policy.scope}:${policy.identifier}:${windowIndex}`;
    const windowStartIso = new Date(windowIndex * windowMs).toISOString();
    const expiresAtIso = new Date((windowIndex + 1) * windowMs + 10000).toISOString();

    const res = await db.query<{ request_count: number }>(
      `INSERT INTO rate_limit_counters (bucket_key, window_start, request_count, expires_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (bucket_key)
       DO UPDATE SET request_count = rate_limit_counters.request_count + 1
       RETURNING request_count`,
      [bucketKey, windowStartIso, expiresAtIso]
    );

    const count = Number(res.rows[0]?.request_count ?? 1);
    if (count > policy.maxRequests) {
      const resetAtMs = (windowIndex + 1) * windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
      throw new RateLimitError(
        retryAfterSeconds,
        `Rate limit exceeded for ${policy.scope}. Please wait ${retryAfterSeconds} seconds.`
      );
    }
  }
}

