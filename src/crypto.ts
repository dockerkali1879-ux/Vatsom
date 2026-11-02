const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export function generateSecureToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Generates a non-enumerable, human-readable public order reference
 * compatible with the VTS- prefix (e.g., VTS-26-9K4M7X2P).
 * Uses 40+ bits of cryptographic entropy from an unambiguous Crockford alphabet.
 */
export function generatePublicOrderReference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet[(randomBytes[i] ?? 0) % alphabet.length];
  }
  return `VTS-${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export function serializeCookie(
  name: string,
  value: string,
  options: {
    maxAgeSeconds?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    path?: string;
    domain?: string;
  }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.domain && options.domain.trim()) {
    parts.push(`Domain=${options.domain.trim()}`);
  }
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
    const expires = new Date(Date.now() + options.maxAgeSeconds * 1000);
    parts.push(`Expires=${expires.toUTCString()}`);
  }
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  if (options.secure !== false) {
    parts.push('Secure');
  }
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Sanitizes the Hero Headline HTML so only safe inline `<span class="...">...</span>`
 * or `<em class="...">...</em>` tags used for the gold italic title accent are permitted.
 * All scripts, event handlers, or other tags are strictly stripped/escaped.
 */
export function sanitizeHeroTitleHtml(input: string): string {
  // Replace allowed gold-accent span temporarily with placeholders, escape everything else, then restore
  const tokens: string[] = [];
  const tokenized = input.replace(
    /<span\s+class="([a-zA-Z0-9_\-\s]+)">([\s\S]*?)<\/span>/gi,
    (_match, classList: string, innerText: string) => {
      const safeClass = classList.replace(/[^a-zA-Z0-9_\-\s]/g, '');
      const safeInner = escapeHtml(innerText);
      const idx = tokens.push(`<span class="${safeClass}">${safeInner}</span>`) - 1;
      return `__VATSOM_SAFE_SPAN_${idx}__`;
    }
  );
  const escaped = escapeHtml(tokenized);
  return escaped.replace(/__VATSOM_SAFE_SPAN_(\d+)__/g, (_m, i) => tokens[Number(i)] ?? '');
}

