import { ApiErrorResponse } from './types';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly headers?: Record<string, string>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
    headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication is required to perform this action.') {
    super(401, 'UNAUTHENTICATED', message);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'You do not have permission to access this resource.') {
    super(403, 'FORBIDDEN', message);
  }
}

export class CsrfError extends AppError {
  constructor(message = 'Invalid or missing CSRF security token.') {
    super(403, 'CSRF_INVALID', message);
  }
}

export class TurnstileError extends AppError {
  constructor(message = 'Security verification challenge failed or expired.') {
    super(403, 'TURNSTILE_VERIFICATION_FAILED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', details?: unknown) {
    super(409, code, message, details);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request payload exceeds the maximum permitted size.') {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number, message = 'Too many requests. Please wait before trying again.') {
    super(
      429,
      'RATE_LIMITED',
      message,
      { retryAfterSeconds },
      { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) }
    );
  }
}

export function formatErrorResponse(err: unknown, requestId: string): {
  status: number;
  body: ApiErrorResponse;
  headers?: Record<string, string>;
} {
  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      body: {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
          requestId
        }
      },
      headers: err.headers
    };
  }

  // Never leak raw database errors, SQL queries, stack traces, or internal details
  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      errorName: err instanceof Error ? err.name : 'UnknownError',
      errorMessage: err instanceof Error ? err.message : 'Internal error'
    })
  );

  return {
    status: 500,
    body: {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected server error occurred. Please try again shortly.',
        requestId
      }
    }
  };
}

