import { z } from 'zod';
import { PayloadTooLargeError, ValidationError } from '../errors';

export const INDIAN_PHONE_REGEX = /^(\+91)?[6-9][0-9]{9}$/;
export const INDIAN_PIN_REGEX = /^[1-9][0-9]{5}$/;
export const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function parseAndValidateJson<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  maxBytes = 131072 // Default 128 KB max payload; image upload routes pass explicit higher limit
): Promise<z.infer<T>> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ValidationError('Request Content-Type must be application/json.');
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new PayloadTooLargeError(`Payload exceeds maximum allowed size of ${maxBytes} bytes.`);
  }

  const rawText = await request.text();
  const byteLen = new TextEncoder().encode(rawText).byteLength;
  if (byteLen > maxBytes) {
    throw new PayloadTooLargeError(`Payload exceeds maximum allowed size of ${maxBytes} bytes.`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    throw new ValidationError('Malformed JSON payload.');
  }

  // Honeypot check: if a hidden bot trap field (`_hp` or `website_url_trap`) is populated, reject immediately
  if (
    parsedJson &&
    typeof parsedJson === 'object' &&
    !Array.isArray(parsedJson) &&
    (('_hp' in parsedJson && Boolean((parsedJson as Record<string, unknown>)._hp)) ||
      ('website_url_trap' in parsedJson && Boolean((parsedJson as Record<string, unknown>).website_url_trap)))
  ) {
    throw new ValidationError('Automated form submission rejected.');
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    const formattedIssues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message
    }));
    throw new ValidationError('Request validation failed.', formattedIssues);
  }

  return result.data;
}

/**
 * Validates binary magic bytes of a base64 or data URL image upload.
 * Strictly allows only WebP, PNG, or JPEG raster formats up to 512 KB.
 * Rejects SVG, HTML, scripts, and disguised executables.
 */
export function validateAndDecodeRasterImage(dataUrlOrBase64: string): {
  mimeType: 'image/webp' | 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
} {
  const trimmed = dataUrlOrBase64.trim();
  // Reject SVG or script strings immediately
  if (
    trimmed.toLowerCase().includes('image/svg') ||
    trimmed.toLowerCase().includes('<svg') ||
    trimmed.toLowerCase().includes('<script')
  ) {
    throw new ValidationError('SVG and executable content are forbidden. Upload WebP, PNG, or JPEG raster images.');
  }

  let base64Part = trimmed;
  const dataUrlMatch = /^data:(image\/(?:webp|png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (dataUrlMatch) {
    base64Part = dataUrlMatch[2] ?? '';
  } else if (trimmed.startsWith('data:')) {
    throw new ValidationError('Unsupported image data URL format. Only WebP, PNG, and JPEG are allowed.');
  }

  let binaryStr: string;
  try {
    binaryStr = atob(base64Part.replace(/\s+/g, ''));
  } catch {
    throw new ValidationError('Invalid base64 image encoding.');
  }

  if (binaryStr.length < 12) {
    throw new ValidationError('Image file is truncated or empty.');
  }

  if (binaryStr.length > 524288) {
    throw new PayloadTooLargeError('Compressed image exceeds the 512 KB per-plate size limit.');
  }

  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // Verify actual magic bytes (File Signature)
  // 1. WebP: "RIFF" (52 49 46 46) ... "WEBP" (57 45 42 50 at offset 8..11)
  const isWebp =
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;

  if (isWebp) {
    return { mimeType: 'image/webp', bytes };
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;

  if (isPng) {
    return { mimeType: 'image/png', bytes };
  }

  // 3. JPEG: FF D8 FF
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isJpeg) {
    return { mimeType: 'image/jpeg', bytes };
  }

  throw new ValidationError(
    'File signature verification failed. Uploaded file does not match valid WebP, PNG, or JPEG magic bytes.'
  );
}

// ============================================================================
// AUTHENTICATION SCHEMAS
// ============================================================================
export const GoogleAuthRequestSchema = z
  .object({
    credential: z.string().min(20).max(4096),
    nonce: z.string().min(8).max(128).optional(),
    turnstileToken: z.string().min(10).max(4096).optional(),
    adminPortalLogin: z.boolean().optional(),
    _hp: z.string().optional()
  })
  .strict();

// ============================================================================
// CUSTOMER PROFILE & ADDRESS SCHEMAS
// ============================================================================
export const CustomerProfileUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    mobileNumber: z
      .string()
      .trim()
      .regex(INDIAN_PHONE_REGEX, 'Mobile number must be a valid 10-digit Indian phone number.')
      .optional()
  })
  .strict();

export const AddressCreateSchema = z
  .object({
    recipientName: z.string().trim().min(2).max(120),
    phoneNumber: z
      .string()
      .trim()
      .regex(INDIAN_PHONE_REGEX, 'Phone number must be a valid 10-digit Indian mobile number.'),
    addressLine1: z.string().trim().min(3).max(250),
    addressLine2: z.string().trim().max(250).optional().nullable(),
    landmark: z.string().trim().max(150).optional().nullable(),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().min(2).max(100),
    pinCode: z
      .string()
      .trim()
      .regex(INDIAN_PIN_REGEX, 'PIN code must be a valid 6-digit Indian postal code.'),
    addressType: z.enum(['home', 'atelier', 'office', 'other']).default('home'),
    isDefault: z.boolean().default(false)
  })
  .strict();

export const AddressUpdateSchema = AddressCreateSchema.partial().strict();

// ============================================================================
// COD CHECKOUT SCHEMA
// Note: Any client-supplied price or total fields are ignored/rejected;
// only productId/slug/legacyId and quantity are accepted for cart items.
// ============================================================================
export const CheckoutItemSchema = z
  .object({
    productId: z.string().uuid().optional(),
    legacyId: z.number().int().positive().optional(),
    slug: z.string().regex(SLUG_REGEX).optional(),
    quantity: z.number().int().min(1, 'Minimum quantity is 1').max(10, 'Maximum 10 units per item in a single COD order'),
    // Optional client fields that are explicitly ignored by server pricing calculation
    clientIgnoredPrice: z.unknown().optional()
  })
  .refine((item) => Boolean(item.productId || item.legacyId || item.slug), {
    message: 'Each item must specify productId, legacyId, or slug.'
  });

export const InlineDeliveryAddressSchema = z
  .object({
    recipientName: z.string().trim().min(2).max(120),
    phoneNumber: z.string().trim().regex(INDIAN_PHONE_REGEX, 'Valid 10-digit Indian mobile number required.'),
    addressLine1: z.string().trim().min(3).max(250),
    addressLine2: z.string().trim().max(250).optional().nullable(),
    landmark: z.string().trim().max(150).optional().nullable(),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().min(2).max(100),
    pinCode: z.string().trim().regex(INDIAN_PIN_REGEX, 'Valid 6-digit Indian PIN code required.'),
    saveAddress: z.boolean().optional()
  })
  .strict();

export const CodCheckoutRequestSchema = z
  .object({
    items: z.array(CheckoutItemSchema).min(1, 'Cart cannot be empty').max(15, 'Maximum 15 distinct items per order'),
    addressId: z.string().uuid().optional(),
    deliveryAddress: InlineDeliveryAddressSchema.optional(),
    customerNotes: z.string().trim().max(400).optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
    turnstileToken: z.string().min(1, 'Turnstile verification token is required'),
    marketingOptIn: z
      .object({
        table: z.boolean().default(false),
        atmosphere: z.boolean().default(false),
        newCollections: z.boolean().default(false)
      })
      .optional(),
    _hp: z.string().optional()
  })
  .refine((data) => Boolean(data.addressId || data.deliveryAddress), {
    message: 'Either a saved addressId or a complete deliveryAddress is required for COD dispatch.'
  });

// ============================================================================
// MARKETING & RETENTION SCHEMAS
// ============================================================================
export const MarketingSubscribeSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    explicitConsent: z.literal(true, {
      error: 'Explicit opt-in consent is required to subscribe to marketing communications.'
    }),
    segments: z
      .object({
        table: z.boolean().default(false),
        atmosphere: z.boolean().default(false),
        newCollections: z.boolean().default(false),
        productUpdates: z.boolean().default(false),
        promotionalCampaigns: z.boolean().default(false)
      })
      .refine((s) => s.table || s.atmosphere || s.newCollections || s.productUpdates || s.promotionalCampaigns, {
        message: 'At least one interest segment (e.g., VATSOM TABLE or VATSOM ATMOSPHERE) must be selected.'
      }),
    turnstileToken: z.string().min(1, 'Turnstile verification token is required'),
    _hp: z.string().optional()
  })
  .strict();

export const MarketingUnsubscribeSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    token: z.string().trim().min(16).max(256).optional(),
    reason: z.string().trim().max(300).optional()
  })
  .refine((d) => Boolean(d.email || d.token), {
    message: 'Either email or unsubscribe token is required.'
  });

export const MarketingPreferencesUpdateSchema = z
  .object({
    table: z.boolean(),
    atmosphere: z.boolean(),
    newCollections: z.boolean(),
    productUpdates: z.boolean(),
    promotionalCampaigns: z.boolean()
  })
  .strict();

// ============================================================================
// ADMIN PRODUCT, ORDER, TRACKING & SITE CONTENT SCHEMAS
// ============================================================================
export const AdminProductInputSchema = z
  .object({
    name: z.string().trim().min(2).max(180),
    slug: z.string().trim().toLowerCase().regex(SLUG_REGEX).max(140).optional(),
    sku: z.string().trim().min(3).max(64).optional(),
    division: z.enum(['TABLE', 'ATMOSPHERE']).optional(),
    filterTag: z.enum(['Edible', 'Aromatic']).optional(),
    category: z.string().trim().min(2).max(120),
    description: z.string().trim().min(10).max(1200),
    longDescription: z.string().trim().max(4000).optional().default(''),
    // Accept either integer pricePaise OR major currency unit (`price`) which is converted to integer paise server-side
    pricePaise: z.number().int().min(0).max(100000000).optional(),
    mrpPaise: z.number().int().min(0).max(100000000).optional(),
    price: z.number().min(0).max(1000000).optional(),
    volume: z.string().trim().min(2).max(40),
    volumeMl: z.number().int().min(1).max(10000).optional(),
    badge: z.string().trim().min(1).max(60).default('Reserve'),
    notes: z.string().trim().min(2).max(300),
    origin: z.string().trim().max(160).optional().default('Single-Origin Estate'),
    extraction: z.string().trim().max(160).optional().default('First Cold-Press (<27°C)'),
    ritual: z.string().trim().max(500).optional().default(''),
    isActive: z.boolean().optional().default(true),
    trackInventory: z.boolean().optional().default(true),
    stockQuantity: z.number().int().min(0).max(100000).optional().default(25),
    maxOrderQuantity: z.number().int().min(1).max(20).optional().default(5),
    sortPriority: z.number().int().min(0).max(10000).optional().default(100),
    images: z.array(z.string().max(750000)).max(3).optional()
  })
  .strict();

export const AdminProductUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(180).optional(),
    slug: z.string().trim().toLowerCase().regex(SLUG_REGEX).max(140).optional(),
    sku: z.string().trim().min(3).max(64).optional(),
    division: z.enum(['TABLE', 'ATMOSPHERE']).optional(),
    filterTag: z.enum(['Edible', 'Aromatic']).optional(),
    category: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().min(10).max(1200).optional(),
    longDescription: z.string().trim().max(4000).optional(),
    pricePaise: z.number().int().min(0).max(100000000).optional(),
    mrpPaise: z.number().int().min(0).max(100000000).optional(),
    price: z.number().min(0).max(1000000).optional(),
    volume: z.string().trim().min(2).max(40).optional(),
    volumeMl: z.number().int().min(1).max(10000).optional(),
    badge: z.string().trim().min(1).max(60).optional(),
    notes: z.string().trim().min(2).max(300).optional(),
    origin: z.string().trim().max(160).optional(),
    extraction: z.string().trim().max(160).optional(),
    ritual: z.string().trim().max(500).optional(),
    isActive: z.boolean().optional(),
    trackInventory: z.boolean().optional(),
    stockQuantity: z.number().int().min(0).max(100000).optional(),
    maxOrderQuantity: z.number().int().min(1).max(20).optional(),
    sortPriority: z.number().int().min(0).max(10000).optional(),
    images: z.array(z.string().max(750000)).max(3).optional()
  })
  .strict();

export const AdminOrderUpdateSchema = z
  .object({
    orderStatus: z
      .enum([
        'PENDING_CONFIRMATION',
        'CONFIRMED',
        'PROCESSING',
        'PACKED',
        'DISPATCHED',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'CANCELLED',
        'RETURN_TO_ORIGIN'
      ])
      .optional(),
    status: z
      .enum(['Pending Seal', 'In Extraction', 'Dispatched', 'Delivered', 'Cancelled'])
      .optional(),
    codRemittanceStatus: z
      .enum(['PENDING', 'COLLECTED_BY_COURIER', 'REMITTED_TO_VATSOM', 'VOIDED'])
      .optional(),
    codRemittanceReference: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(500).optional()
  })
  .refine((d) => Boolean(d.orderStatus || d.status || d.codRemittanceStatus), {
    message: 'Provide orderStatus, status label, or codRemittanceStatus to update.'
  });

export const AdminTrackingUpdateSchema = z
  .object({
    courierCode: z.string().trim().min(2).max(50),
    courierName: z.string().trim().min(2).max(100),
    awbNumber: z.string().trim().min(3).max(80),
    trackingUrl: z.string().trim().url().max(500).optional().nullable(),
    currentShipmentState: z.string().trim().min(2).max(80).default('IN_TRANSIT'),
    estimatedDeliveryAt: z.string().datetime().optional().nullable(),
    eventNote: z.string().trim().max(300).optional()
  })
  .strict();

export const AdminSiteContentSchema = z
  .object({
    heroBanner: z.string().trim().min(2).max(200),
    heroTitleHtml: z.string().trim().min(2).max(400),
    heroSubtitle: z.string().trim().min(5).max(800),
    manifestoTitle: z.string().trim().min(2).max(250),
    manifestoP1: z.string().trim().min(5).max(1500),
    manifestoP2: z.string().trim().min(5).max(1500)
  })
  .strict();

export const LocalStorageMigrationSchema = z
  .object({
    dryRun: z.boolean().default(true),
    products: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
    siteContent: AdminSiteContentSchema.optional(),
    orders: z.array(z.record(z.string(), z.unknown())).max(200).optional()
  })
  .strict();
