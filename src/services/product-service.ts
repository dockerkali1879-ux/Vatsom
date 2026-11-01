import { sha256Hex } from '../crypto';
import { DatabaseClient, SqlExecutor } from '../db/client';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { AuthenticatedUser, Division } from '../types';
import { validateAndDecodeRasterImage } from '../validation/schemas';

export interface ProductRecord {
  id: string;
  legacy_numeric_id: number | null;
  slug: string;
  sku: string;
  name: string;
  division: Division;
  category: string;
  description: string;
  long_description: string | null;
  price_paise: number;
  mrp_paise: number;
  volume_label: string;
  volume_ml: number | null;
  attributes: {
    notes?: string;
    origin?: string;
    extraction?: string;
    ritual?: string;
    badge?: string;
    filterTag?: string;
  };
  is_active: boolean;
  track_inventory: boolean;
  stock_quantity: number;
  max_order_quantity: number;
  sort_priority: number;
  created_at: string;
  updated_at: string;
}

export interface ProductMediaRow {
  id: string;
  product_id: string;
  plate_index: number;
  media_url: string | null;
  alt_text: string;
  mime_type: string;
}

export interface FormattedProductDto {
  id: number | string;
  uuid: string;
  legacyId: number | null;
  slug: string;
  sku: string;
  name: string;
  division: Division;
  filterTag: 'Edible' | 'Aromatic';
  category: string;
  description: string;
  longDescription: string;
  pricePaise: number;
  mrpPaise: number;
  price: number;
  mrp: number;
  volume: string;
  volumeMl: number | null;
  notes: string;
  origin: string;
  extraction: string;
  ritual: string;
  badge: string;
  isActive: boolean;
  inStock: boolean;
  stockQuantity: number;
  maxOrderQuantity: number;
  sortPriority: number;
  images: [string, string, string];
}

export function formatProductDto(
  row: ProductRecord,
  mediaRows: ProductMediaRow[]
): FormattedProductDto {
  const attrs = row.attributes || {};
  const filterTag: 'Edible' | 'Aromatic' =
    row.division === 'ATMOSPHERE' || attrs.filterTag === 'Aromatic' ? 'Aromatic' : 'Edible';

  const images: [string, string, string] = ['', '', ''];
  for (const m of mediaRows) {
    if (m.plate_index >= 0 && m.plate_index <= 2) {
      images[m.plate_index] = m.media_url || `/api/v1/media/${m.id}`;
    }
  }

  return {
    id: row.legacy_numeric_id ?? row.id,
    uuid: row.id,
    legacyId: row.legacy_numeric_id,
    slug: row.slug,
    sku: row.sku,
    name: row.name,
    division: row.division,
    filterTag,
    category: row.category,
    description: row.description,
    longDescription: row.long_description || row.description,
    pricePaise: Number(row.price_paise),
    mrpPaise: Number(row.mrp_paise),
    price: Number((Number(row.price_paise) / 100).toFixed(2)),
    mrp: Number((Number(row.mrp_paise) / 100).toFixed(2)),
    volume: row.volume_label,
    volumeMl: row.volume_ml,
    notes: attrs.notes || '',
    origin: attrs.origin || 'Single-Origin Estate',
    extraction: attrs.extraction || 'First Cold-Press (<27°C)',
    ritual: attrs.ritual || '',
    badge: attrs.badge || 'Reserve',
    isActive: Boolean(row.is_active),
    inStock: !row.track_inventory || Number(row.stock_quantity) > 0,
    stockQuantity: Number(row.stock_quantity),
    maxOrderQuantity: Number(row.max_order_quantity),
    sortPriority: Number(row.sort_priority),
    images
  };
}

export function slugifyProductName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function fetchMediaMapForProducts(
  db: SqlExecutor,
  productIds: string[]
): Promise<Map<string, ProductMediaRow[]>> {
  const map = new Map<string, ProductMediaRow[]>();
  if (productIds.length === 0) return map;

  const placeholders = productIds.map((_, idx) => `$${idx + 1}`).join(', ');
  const mediaRes = await db.query<ProductMediaRow>(
    `SELECT id, product_id, plate_index, media_url, alt_text, mime_type
     FROM product_media
     WHERE product_id IN (${placeholders})
     ORDER BY plate_index ASC`,
    productIds
  );

  for (const row of mediaRes.rows) {
    const list = map.get(row.product_id) ?? [];
    list.push(row);
    map.set(row.product_id, list);
  }
  return map;
}

export async function listPublicProducts(
  db: DatabaseClient,
  options?: { division?: Division; page?: number; limit?: number }
): Promise<{ items: FormattedProductDto[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, options?.page ?? 1);
  const limit = Math.min(50, Math.max(1, options?.limit ?? 24));
  const offset = (page - 1) * limit;

  const params: unknown[] = [];
  let whereClause = `WHERE is_active = TRUE`;
  if (options?.division) {
    params.push(options.division);
    whereClause += ` AND division = $${params.length}`;
  }

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM products ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0]?.total ?? 0);

  const queryParams = [...params, limit, offset];
  const rowsRes = await db.query<ProductRecord>(
    `SELECT
       id, legacy_numeric_id, slug, sku, name, division, category,
       description, long_description, price_paise, mrp_paise,
       volume_label, volume_ml, attributes, is_active,
       track_inventory, stock_quantity, max_order_quantity,
       sort_priority, created_at, updated_at
     FROM products
     ${whereClause}
     ORDER BY sort_priority ASC, created_at ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    queryParams
  );

  const mediaMap = await fetchMediaMapForProducts(
    db,
    rowsRes.rows.map((r) => r.id)
  );

  const items = rowsRes.rows.map((row) => formatProductDto(row, mediaMap.get(row.id) ?? []));
  return { items, total, page, limit };
}

function validateProductIdentifier(identifier: string): {
  isUuid: boolean;
  isNumeric: boolean;
  cleaned: string;
} {
  const cleaned = (identifier || '').trim();
  if (!cleaned || cleaned.startsWith('-') || (/^-?\d+$/.test(cleaned) && Number(cleaned) <= 0)) {
    throw new ValidationError('Invalid product identifier: negative or zero IDs are not permitted.');
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned);
  const isNumeric = /^\d+$/.test(cleaned);
  return { isUuid, isNumeric, cleaned };
}

export async function getPublicProductBySlugOrId(
  db: DatabaseClient,
  identifier: string
): Promise<FormattedProductDto> {
  const { isUuid, isNumeric, cleaned } = validateProductIdentifier(identifier);

  let query = `
    SELECT
      id, legacy_numeric_id, slug, sku, name, division, category,
      description, long_description, price_paise, mrp_paise,
      volume_label, volume_ml, attributes, is_active,
      track_inventory, stock_quantity, max_order_quantity,
      sort_priority, created_at, updated_at
    FROM products
    WHERE is_active = TRUE AND `;

  let param: unknown = cleaned;
  if (isUuid) {
    query += `id = $1`;
  } else if (isNumeric) {
    query += `legacy_numeric_id = $1`;
    param = Number(cleaned);
  } else {
    query += `slug = $1`;
  }

  const res = await db.query<ProductRecord>(query, [param]);
  const row = res.rows[0];
  if (!row) {
    throw new NotFoundError('Product folio not found or no longer active.');
  }

  const mediaMap = await fetchMediaMapForProducts(db, [row.id]);
  return formatProductDto(row, mediaMap.get(row.id) ?? []);
}

export async function getProductMediaBinary(
  db: DatabaseClient,
  mediaId: string
): Promise<{ bytes: Uint8Array; mimeType: string; sha256Hex: string }> {
  const res = await db.query<{
    mime_type: string;
    sha256_hex: string | null;
    webp_binary: Uint8Array | Buffer | string | null;
  }>(
    `SELECT mime_type, sha256_hex, webp_binary
     FROM product_media
     WHERE id = $1
     LIMIT 1`,
    [mediaId]
  );

  const row = res.rows[0];
  if (!row || !row.webp_binary) {
    throw new NotFoundError('Product media binary plate not found.');
  }

  let bytes: Uint8Array;
  if (row.webp_binary instanceof Uint8Array) {
    bytes = row.webp_binary;
  } else if (typeof row.webp_binary === 'string') {
    // Handle PostgreSQL hex bytea format (\x...)
    const hex = row.webp_binary.startsWith('\\x') ? row.webp_binary.slice(2) : row.webp_binary;
    bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
  } else {
    bytes = new Uint8Array(row.webp_binary);
  }

  return {
    bytes,
    mimeType: row.mime_type || 'image/webp',
    sha256Hex: row.sha256_hex || (await sha256Hex(bytes))
  };
}

export async function listAdminProducts(db: DatabaseClient): Promise<FormattedProductDto[]> {
  const rowsRes = await db.query<ProductRecord>(
    `SELECT
       id, legacy_numeric_id, slug, sku, name, division, category,
       description, long_description, price_paise, mrp_paise,
       volume_label, volume_ml, attributes, is_active,
       track_inventory, stock_quantity, max_order_quantity,
       sort_priority, created_at, updated_at
     FROM products
     ORDER BY sort_priority ASC, created_at DESC`
  );

  const mediaMap = await fetchMediaMapForProducts(
    db,
    rowsRes.rows.map((r) => r.id)
  );
  return rowsRes.rows.map((r) => formatProductDto(r, mediaMap.get(r.id) ?? []));
}

async function syncProductMediaPlates(
  tx: SqlExecutor,
  productId: string,
  productName: string,
  images?: string[]
): Promise<void> {
  if (!images) return;

  for (let plateIdx = 0; plateIdx < 3; plateIdx++) {
    const rawVal = (images[plateIdx] || '').trim();
    if (!rawVal) {
      await tx.query(
        `DELETE FROM product_media WHERE product_id = $1 AND plate_index = $2`,
        [productId, plateIdx]
      );
      continue;
    }

    // Keep existing media URL if unchanged
    if (rawVal.startsWith('/api/v1/media/') || rawVal.startsWith('https://') || rawVal.startsWith('http://')) {
      if (rawVal.startsWith('http://') || rawVal.startsWith('https://')) {
        await tx.query(
          `INSERT INTO product_media (product_id, plate_index, media_url, alt_text, mime_type)
           VALUES ($1, $2, $3, $4, 'image/webp')
           ON CONFLICT (product_id, plate_index)
           DO UPDATE SET media_url = EXCLUDED.media_url, webp_binary = NULL, updated_at = NOW()`,
          [productId, plateIdx, rawVal, `${productName} - Plate ${plateIdx + 1}`]
        );
      }
      continue;
    }

    // Otherwise validate raster binary signature (WebP/PNG/JPEG, no SVG/scripts, max 512 KB)
    const { mimeType, bytes } = validateAndDecodeRasterImage(rawVal);
    const digest = await sha256Hex(bytes);

    const mediaRes = await tx.query<{ id: string }>(
      `INSERT INTO product_media (
         product_id,
         plate_index,
         media_url,
         alt_text,
         mime_type,
         file_size_bytes,
         sha256_hex,
         webp_binary
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)
       ON CONFLICT (product_id, plate_index)
       DO UPDATE SET
         media_url = NULL,
         alt_text = EXCLUDED.alt_text,
         mime_type = EXCLUDED.mime_type,
         file_size_bytes = EXCLUDED.file_size_bytes,
         sha256_hex = EXCLUDED.sha256_hex,
         webp_binary = EXCLUDED.webp_binary,
         updated_at = NOW()
       RETURNING id`,
      [
        productId,
        plateIdx,
        `${productName} - Plate ${plateIdx + 1}`,
        mimeType,
        bytes.byteLength,
        digest,
        bytes
      ]
    );

    const mediaId = mediaRes.rows[0]?.id;
    if (mediaId) {
      await tx.query(
        `UPDATE product_media SET media_url = $1 WHERE id = $2`,
        [`/api/v1/media/${mediaId}`, mediaId]
      );
    }
  }
}

export async function createAdminProduct(
  db: DatabaseClient,
  admin: AuthenticatedUser,
  input: {
    name: string;
    slug?: string;
    sku?: string;
    division?: Division;
    filterTag?: 'Edible' | 'Aromatic';
    category: string;
    description: string;
    longDescription?: string;
    pricePaise?: number;
    mrpPaise?: number;
    price?: number;
    volume: string;
    volumeMl?: number;
    badge?: string;
    notes: string;
    origin?: string;
    extraction?: string;
    ritual?: string;
    isActive?: boolean;
    trackInventory?: boolean;
    stockQuantity?: number;
    maxOrderQuantity?: number;
    sortPriority?: number;
    images?: string[];
  },
  ipHash: string,
  userAgent: string
): Promise<FormattedProductDto> {
  const division: Division =
    input.division ?? (input.filterTag === 'Aromatic' ? 'ATMOSPHERE' : 'TABLE');
  const filterTag: 'Edible' | 'Aromatic' = division === 'ATMOSPHERE' ? 'Aromatic' : 'Edible';

  const pricePaise =
    input.pricePaise !== undefined
      ? Math.round(input.pricePaise)
      : input.price !== undefined
        ? Math.round(input.price * 100)
        : -1;

  if (pricePaise < 0) {
    throw new ValidationError('A valid integer pricePaise or price is required.');
  }

  const mrpPaise =
    input.mrpPaise !== undefined ? Math.max(pricePaise, Math.round(input.mrpPaise)) : pricePaise;

  const baseSlug = input.slug || slugifyProductName(input.name);
  const sku =
    input.sku ||
    `VTS-${division === 'ATMOSPHERE' ? 'ATM' : 'TBL'}-${Math.floor(100 + Math.random() * 900)}`;

  return db.withTransaction(async (tx) => {
    const existingSlug = await tx.query<{ id: string }>(
      `SELECT id FROM products WHERE slug = $1 OR sku = $2 LIMIT 1`,
      [baseSlug, sku]
    );
    if (existingSlug.rowCount > 0) {
      throw new ConflictError('A product with this slug or SKU already exists.');
    }

    const maxLegacyRes = await tx.query<{ max_id: number | null }>(
      `SELECT COALESCE(MAX(legacy_numeric_id), 6) AS max_id FROM products`
    );
    const nextLegacyId = Number(maxLegacyRes.rows[0]?.max_id ?? 6) + 1;

    const attributes = {
      notes: input.notes,
      origin: input.origin || 'Single-Origin Estate',
      extraction: input.extraction || 'First Cold-Press (<27°C)',
      ritual: input.ritual || '',
      badge: input.badge || 'Reserve',
      filterTag
    };

    const insertRes = await tx.query<ProductRecord>(
      `INSERT INTO products (
         legacy_numeric_id, slug, sku, name, division, category,
         description, long_description, price_paise, mrp_paise,
         volume_label, volume_ml, attributes, is_active,
         track_inventory, stock_quantity, max_order_quantity, sort_priority
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14,
         $15, $16, $17, $18
       ) RETURNING *`,
      [
        nextLegacyId,
        baseSlug,
        sku,
        input.name,
        division,
        input.category,
        input.description,
        input.longDescription || input.description,
        pricePaise,
        mrpPaise,
        input.volume,
        input.volumeMl ?? null,
        JSON.stringify(attributes),
        input.isActive ?? true,
        input.trackInventory ?? true,
        input.stockQuantity ?? 25,
        input.maxOrderQuantity ?? 5,
        input.sortPriority ?? 100
      ]
    );

    const created = insertRes.rows[0]!;
    if (typeof created.attributes === 'string') {
      created.attributes = JSON.parse(created.attributes);
    }

    await syncProductMediaPlates(tx, created.id, created.name, input.images);

    await tx.query(
      `INSERT INTO admin_audit_logs (
         admin_customer_id, admin_email, action, target_type, target_id,
         before_state, after_state, ip_hash, user_agent
       ) VALUES ($1, $2, 'CREATE_PRODUCT', 'product', $3, NULL, $4, $5, $6)`,
      [
        admin.id,
        admin.email,
        created.id,
        JSON.stringify({ name: created.name, sku: created.sku, pricePaise: created.price_paise }),
        ipHash,
        userAgent
      ]
    );

    const mediaMap = await fetchMediaMapForProducts(tx, [created.id]);
    return formatProductDto(created, mediaMap.get(created.id) ?? []);
  });
}

export async function updateAdminProduct(
  db: DatabaseClient,
  admin: AuthenticatedUser,
  identifier: string,
  input: Record<string, unknown>,
  ipHash: string,
  userAgent: string
): Promise<FormattedProductDto> {
  const { isUuid, isNumeric, cleaned } = validateProductIdentifier(identifier);
  return db.withTransaction(async (tx) => {
    const lookupSql = isUuid
      ? `SELECT * FROM products WHERE id = $1 FOR UPDATE`
      : isNumeric
        ? `SELECT * FROM products WHERE legacy_numeric_id = $1 FOR UPDATE`
        : `SELECT * FROM products WHERE slug = $1 FOR UPDATE`;

    const existingRes = await tx.query<ProductRecord>(lookupSql, [
      isNumeric ? Number(cleaned) : cleaned
    ]);
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new NotFoundError('Product record not found.');
    }

    const currentAttrs =
      typeof existing.attributes === 'string'
        ? JSON.parse(existing.attributes)
        : existing.attributes || {};

    const name = typeof input.name === 'string' ? input.name : existing.name;
    const division: Division =
      input.division === 'ATMOSPHERE' || input.division === 'TABLE'
        ? input.division
        : input.filterTag === 'Aromatic'
          ? 'ATMOSPHERE'
          : input.filterTag === 'Edible'
            ? 'TABLE'
            : existing.division;

    const filterTag: 'Edible' | 'Aromatic' = division === 'ATMOSPHERE' ? 'Aromatic' : 'Edible';

    const pricePaise =
      typeof input.pricePaise === 'number'
        ? Math.round(input.pricePaise)
        : typeof input.price === 'number'
          ? Math.round(input.price * 100)
          : Number(existing.price_paise);

    const mrpPaise =
      typeof input.mrpPaise === 'number'
        ? Math.max(pricePaise, Math.round(input.mrpPaise))
        : Math.max(pricePaise, Number(existing.mrp_paise));

    const updatedAttrs = {
      ...currentAttrs,
      notes: typeof input.notes === 'string' ? input.notes : currentAttrs.notes,
      origin: typeof input.origin === 'string' ? input.origin : currentAttrs.origin,
      extraction: typeof input.extraction === 'string' ? input.extraction : currentAttrs.extraction,
      ritual: typeof input.ritual === 'string' ? input.ritual : currentAttrs.ritual,
      badge: typeof input.badge === 'string' ? input.badge : currentAttrs.badge,
      filterTag
    };

    const updateRes = await tx.query<ProductRecord>(
      `UPDATE products SET
         name = $1,
         division = $2,
         category = $3,
         description = $4,
         long_description = $5,
         price_paise = $6,
         mrp_paise = $7,
         volume_label = $8,
         attributes = $9,
         is_active = $10,
         stock_quantity = $11,
         sort_priority = $12,
         updated_at = NOW()
       WHERE id = $13
       RETURNING *`,
      [
        name,
        division,
        typeof input.category === 'string' ? input.category : existing.category,
        typeof input.description === 'string' ? input.description : existing.description,
        typeof input.longDescription === 'string'
          ? input.longDescription
          : existing.long_description,
        pricePaise,
        mrpPaise,
        typeof input.volume === 'string' ? input.volume : existing.volume_label,
        JSON.stringify(updatedAttrs),
        typeof input.isActive === 'boolean' ? input.isActive : existing.is_active,
        typeof input.stockQuantity === 'number' ? input.stockQuantity : existing.stock_quantity,
        typeof input.sortPriority === 'number' ? input.sortPriority : existing.sort_priority,
        existing.id
      ]
    );

    const updated = updateRes.rows[0]!;
    if (typeof updated.attributes === 'string') {
      updated.attributes = JSON.parse(updated.attributes);
    }

    if (Array.isArray(input.images)) {
      await syncProductMediaPlates(tx, updated.id, updated.name, input.images as string[]);
    }

    await tx.query(
      `INSERT INTO admin_audit_logs (
         admin_customer_id, admin_email, action, target_type, target_id,
         before_state, after_state, ip_hash, user_agent
       ) VALUES ($1, $2, 'UPDATE_PRODUCT', 'product', $3, $4, $5, $6, $7)`,
      [
        admin.id,
        admin.email,
        updated.id,
        JSON.stringify({ name: existing.name, pricePaise: existing.price_paise, stock: existing.stock_quantity }),
        JSON.stringify({ name: updated.name, pricePaise: updated.price_paise, stock: updated.stock_quantity }),
        ipHash,
        userAgent
      ]
    );

    const mediaMap = await fetchMediaMapForProducts(tx, [updated.id]);
    return formatProductDto(updated, mediaMap.get(updated.id) ?? []);
  });
}

export async function deleteOrArchiveAdminProduct(
  db: DatabaseClient,
  admin: AuthenticatedUser,
  identifier: string,
  ipHash: string,
  userAgent: string
): Promise<{ deleted: boolean; archived: boolean; productId: string }> {
  const { isUuid, isNumeric, cleaned } = validateProductIdentifier(identifier);
  return db.withTransaction(async (tx) => {
    const lookupSql = isUuid
      ? `SELECT * FROM products WHERE id = $1 FOR UPDATE`
      : isNumeric
        ? `SELECT * FROM products WHERE legacy_numeric_id = $1 FOR UPDATE`
        : `SELECT * FROM products WHERE slug = $1 FOR UPDATE`;

    const existingRes = await tx.query<ProductRecord>(lookupSql, [
      isNumeric ? Number(cleaned) : cleaned
    ]);
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new NotFoundError('Product record not found.');
    }

    // Check if referenced by historical orders; if so, archive (soft-delete) to preserve order_items FK integrity
    const orderRefRes = await tx.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM order_items WHERE product_id = $1`,
      [existing.id]
    );
    const hasOrders = Number(orderRefRes.rows[0]?.cnt ?? 0) > 0;

    if (hasOrders) {
      await tx.query(
        `UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [existing.id]
      );
    } else {
      await tx.query(`DELETE FROM products WHERE id = $1`, [existing.id]);
    }

    await tx.query(
      `INSERT INTO admin_audit_logs (
         admin_customer_id, admin_email, action, target_type, target_id,
         before_state, after_state, ip_hash, user_agent
       ) VALUES ($1, $2, $3, 'product', $4, $5, $6, $7, $8)`,
      [
        admin.id,
        admin.email,
        hasOrders ? 'ARCHIVE_PRODUCT' : 'DELETE_PRODUCT',
        existing.id,
        JSON.stringify({ name: existing.name, sku: existing.sku }),
        JSON.stringify({ archived: hasOrders, deleted: !hasOrders }),
        ipHash,
        userAgent
      ]
    );

    return {
      deleted: !hasOrders,
      archived: hasOrders,
      productId: existing.id
    };
  });
}

