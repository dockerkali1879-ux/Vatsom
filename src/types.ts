export interface Env {
  ENVIRONMENT: 'development' | 'staging' | 'production' | 'test';
  API_VERSION: string;
  APP_ORIGIN: string;
  ADMIN_ORIGIN?: string;
  API_ORIGIN?: string;
  COOKIE_DOMAIN?: string;
  TURNSTILE_ALLOWED_HOSTNAMES?: string;
  ENABLE_HSTS?: string;
  PRIVACY_POLICY_VERSION: string;
  COD_MAX_ORDER_PAISE: string;
  COD_FREE_DELIVERY_THRESHOLD_PAISE: string;
  COD_STANDARD_DELIVERY_PAISE: string;
  SESSION_TTL_SECONDS: string;
  ADMIN_SESSION_TTL_SECONDS: string;

  // Database connections
  DATABASE_URL?: string;
  HYPERDRIVE?: {
    connectionString: string;
  };

  // Secrets
  GOOGLE_CLIENT_ID?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  SESSION_SIGNING_SECRET?: string;
  ADMIN_ALLOWLIST?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_PROVIDER_API_KEY?: string;
  EMAIL_FROM_ADDRESS?: string;
  COURIER_WEBHOOK_SECRET?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;

  // Static Assets binding
  ASSETS?: {
    fetch: (request: Request) => Promise<Response>;
  };
}

export type UserRole = 'customer' | 'admin';
export type AccountStatus = 'active' | 'suspended' | 'deleted';
export type Division = 'TABLE' | 'ATMOSPHERE';

export type OrderStatus =
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'PACKED'
  | 'DISPATCHED'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'RETURN_TO_ORIGIN';

export type AdminStatusLabel =
  | 'Pending Seal'
  | 'In Extraction'
  | 'Dispatched'
  | 'Delivered'
  | 'Cancelled';

export type CodRemittanceStatus =
  | 'PENDING'
  | 'COLLECTED_BY_COURIER'
  | 'REMITTED_TO_VATSOM'
  | 'VOIDED';

export interface AuthenticatedUser {
  id: string;
  googleSub: string;
  name: string;
  email: string;
  emailVerified: boolean;
  mobileNumber: string | null;
  role: UserRole;
  accountStatus: AccountStatus;
}

export interface SessionInfo {
  id: string;
  customerId: string;
  sessionScope: UserRole;
  csrfTokenHash: string;
  expiresAt: Date;
}

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  ipHash: string;
  userAgent: string;
  requestId: string;
  user: AuthenticatedUser | null;
  session: SessionInfo | null;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

