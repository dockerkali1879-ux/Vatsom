import { formatErrorResponse } from './errors';
import { ApiSuccessResponse, Env } from './types';

export function buildSecurityHeaders(env: Env, requestOrigin?: string | null): Record<string, string> {
  const allowedOrigin = env.APP_ORIGIN || 'http://localhost:8787';
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    // CSP compatible with existing VATSOM frontend (Tailwind CDN, Lenis, Three.js r128, Google Fonts, FontAwesome, Google Identity Services, Turnstile)
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdnjs.cloudflare.com https://accounts.google.com https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://accounts.google.com",
      "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
      "img-src 'self' data: blob: https:",
      "frame-src https://accounts.google.com https://challenges.cloudflare.com",
      "connect-src 'self' https://accounts.google.com https://challenges.cloudflare.com"
    ].join('; ')
  };

  if (env.ENVIRONMENT === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains; preload';
  }

  if (requestOrigin && requestOrigin === allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  }

  return headers;
}

export function jsonSuccess<T>(
  data: T,
  env: Env,
  options?: {
    status?: number;
    meta?: Record<string, unknown>;
    headers?: Record<string, string>;
    cacheControl?: string;
    requestOrigin?: string | null;
  }
): Response {
  const payload: ApiSuccessResponse<T> = {
    success: true,
    data,
    ...(options?.meta ? { meta: options.meta } : {})
  };

  const secHeaders = buildSecurityHeaders(env, options?.requestOrigin);
  return new Response(JSON.stringify(payload), {
    status: options?.status ?? 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': options?.cacheControl ?? 'no-store, no-cache, must-revalidate, private',
      ...secHeaders,
      ...(options?.headers ?? {})
    }
  });
}

export function jsonError(
  err: unknown,
  env: Env,
  requestId: string,
  requestOrigin?: string | null
): Response {
  const formatted = formatErrorResponse(err, requestId);
  const secHeaders = buildSecurityHeaders(env, requestOrigin);

  return new Response(JSON.stringify(formatted.body), {
    status: formatted.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      ...secHeaders,
      ...(formatted.headers ?? {})
    }
  });
}

