import {
  generatePublicOrderReference,
  generateSecureToken,
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualStr
} from '../crypto';
import { DatabaseClient, SqlExecutor } from '../db/client';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError
} from '../errors';
import {
  AdminStatusLabel,
  AuthenticatedUser,
  CodRemittanceStatus,
  Division,
  Env,
  OrderStatus
} from '../types';
import { recordMarketingConsentInTx } from './retention-service';

export function mapOrderStatusToAdminLabel(status: OrderStatus): AdminStatusLabel {
  switch (status) {
    case 'PENDING_CONFIRMATION':
      return 'Pending Seal';
    case 'CONFIRMED':
    case 'PROCESSING':
    case 'PACKED':
      return 'In Extraction';
    case 'DISPATCHED':
    case 'OUT_FOR_DELIVERY':
      return 'Dispatched';
    case 'DELIVERED':
      return 'Delivered';
    case 'CANCELLED':
    case 'RETURN_TO_ORIGIN':
      return 'Cancelled';
  }
}

export function mapAdminLabelToOrderStatus(label: AdminStatusLabel): OrderStatus {
  switch (label) {
    case 'Pending Seal':
      return 'PENDING_CONFIRMATION';
    case 'In Extraction':
      return 'PROCESSING';
    case 'Dispatched':
      return 'DISPATCHED';
    case 'Delivered':
      return 'DELIVERED';
    case 'Cancelled':
      return 'CANCELLED';
  }
}

export interface OrderItemDto {
  id: string;
  productId: string;
  name: string;
  sku: string;
  volume: string;
  division: Division;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  price: number;
  lineTotal: number;
}

export interface ShipmentTrackingDto {
  courierCode: string;
  courierName: string;
  awbNumber: string;
  trackingUrl: string | null;
  currentShipmentState: string;
  estimatedDeliveryAt: string | null;
  lastEventAt: string;
  eventHistory: unknown[];
}

export interface OrderDto {
  id: string;
  orderId: string; // Public non-enumerable VTS-XXXX-XXXX reference
  publicOrderRef: string;
  trackingToken?: string;
  customerId: string;
  customer: string;
  customerEmail?: string;
  date: string;
  createdAt: string;
  orderStatus: OrderStatus;
  status: AdminStatusLabel;
  paymentMethod: 'COD';
  codRemittanceStatus: CodRemittanceStatus;
  subtotalPaise: number;
  taxPaise: number;
  deliveryChargePaise: number;
  discountPaise: number;
  finalAmountPaise: number;
  codAmountDuePaise: number;
  subtotal: number;
  total: number;
  addressSnapshot: {
    recipientName: string;
    phoneNumber: string;
    addressLine1: string;
    addressLine2?: string | null;
    landmark?: string | null;
    city: string;
    state: string;
    pinCode: string;
  };
  items: OrderItemDto[];
  tracking: ShipmentTrackingDto | null;
  statusHistory?: Array<{
    previousStatus: string | null;
    newStatus: string;
    actorType: string;
    notes: string | null;
    createdAt: string;
  }>;
}

function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

async function hydrateOrders(
  db: SqlExecutor,
  orderRows: Array<Record<string, unknown>>,
  includeHistory = false
): Promise<OrderDto[]> {
  if (orderRows.length === 0) return [];

  const orderIds = orderRows.map((r) => String(r.id));
  const placeholders = orderIds.map((_, idx) => `$${idx + 1}`).join(', ');

  const itemsRes = await db.query<Record<string, unknown>>(
    `SELECT id, order_id, product_id, product_name_snapshot, sku_snapshot,
            volume_snapshot, division_snapshot, quantity, unit_price_paise, line_total_paise
     FROM order_items
     WHERE order_id IN (${placeholders})
     ORDER BY created_at ASC`,
    orderIds
  );

  const itemsByOrder = new Map<string, OrderItemDto[]>();
  for (const row of itemsRes.rows) {
    const oid = String(row.order_id);
    const list = itemsByOrder.get(oid) ?? [];
    const unitPaise = Number(row.unit_price_paise);
    const linePaise = Number(row.line_total_paise);
    list.push({
      id: String(row.id),
      productId: String(row.product_id),
      name: String(row.product_name_snapshot),
      sku: String(row.sku_snapshot),
      volume: String(row.volume_snapshot),
      division: (row.division_snapshot as Division) || 'TABLE',
      quantity: Number(row.quantity),
      unitPricePaise: unitPaise,
      lineTotalPaise: linePaise,
      price: Number((unitPaise / 100).toFixed(2)),
      lineTotal: Number((linePaise / 100).toFixed(2))
    });
    itemsByOrder.set(oid, list);
  }

  const trackingRes = await db.query<Record<string, unknown>>(
    `SELECT order_id, courier_code, courier_name, awb_number, tracking_url,
            current_shipment_state, estimated_delivery_at, last_event_at, event_history
     FROM shipment_tracking
     WHERE order_id IN (${placeholders})`,
    orderIds
  );

  const trackingByOrder = new Map<string, ShipmentTrackingDto>();
  for (const row of trackingRes.rows) {
    trackingByOrder.set(String(row.order_id), {
      courierCode: String(row.courier_code),
      courierName: String(row.courier_name),
      awbNumber: String(row.awb_number),
      trackingUrl: row.tracking_url ? String(row.tracking_url) : null,
      currentShipmentState: String(row.current_shipment_state),
      estimatedDeliveryAt: row.estimated_delivery_at ? String(row.estimated_delivery_at) : null,
      lastEventAt: String(row.last_event_at),
      eventHistory: parseJsonSafe<unknown[]>(row.event_history, [])
    });
  }

  const historyByOrder = new Map<
    string,
    Array<{
      previousStatus: string | null;
      newStatus: string;
      actorType: string;
      notes: string | null;
      createdAt: string;
    }>
  >();

  if (includeHistory) {
    const histRes = await db.query<Record<string, unknown>>(
      `SELECT order_id, previous_status, new_status, actor_type, notes, created_at
       FROM order_status_history
       WHERE order_id IN (${placeholders})
       ORDER BY created_at ASC`,
      orderIds
    );
    for (const row of histRes.rows) {
      const oid = String(row.order_id);
      const list = historyByOrder.get(oid) ?? [];
      list.push({
        previousStatus: row.previous_status ? String(row.previous_status) : null,
        newStatus: String(row.new_status),
        actorType: String(row.actor_type),
        notes: row.notes ? String(row.notes) : null,
        createdAt: String(row.created_at)
      });
      historyByOrder.set(oid, list);
    }
  }

  return orderRows.map((row) => {
    const oid = String(row.id);
    const addr = parseJsonSafe<OrderDto['addressSnapshot']>(row.address_snapshot, {
      recipientName: 'Patron',
      phoneNumber: '',
      addressLine1: '',
      city: '',
      state: '',
      pinCode: ''
    });
    const subtotalPaise = Number(row.subtotal_paise);
    const finalPaise = Number(row.final_amount_paise);
    const createdAtIso = new Date(String(row.created_at)).toISOString();
    const formattedDate = createdAtIso.slice(0, 16).replace('T', ' ');
    const orderStatus = row.order_status as OrderStatus;
    const adminLabel =
      (row.admin_status_label as AdminStatusLabel) || mapOrderStatusToAdminLabel(orderStatus);

    return {
      id: oid,
      orderId: String(row.public_order_ref),
      publicOrderRef: String(row.public_order_ref),
      customerId: String(row.customer_id),
      customer: addr.recipientName || String(row.customer_name || 'Private Client'),
      customerEmail: row.customer_email ? String(row.customer_email) : undefined,
      date: formattedDate,
      createdAt: createdAtIso,
      orderStatus,
      status: adminLabel,
      paymentMethod: 'COD',
      codRemittanceStatus: (row.cod_remittance_status as CodRemittanceStatus) || 'PENDING',
      subtotalPaise,
      taxPaise: Number(row.tax_paise ?? 0),
      deliveryChargePaise: Number(row.delivery_charge_paise ?? 0),
      discountPaise: Number(row.discount_paise ?? 0),
      finalAmountPaise: finalPaise,
      codAmountDuePaise: Number(row.cod_amount_due_paise ?? finalPaise),
      subtotal: Number((subtotalPaise / 100).toFixed(2)),
      total: Number((finalPaise / 100).toFixed(2)),
      addressSnapshot: addr,
      items: itemsByOrder.get(oid) ?? [],
      tracking: trackingByOrder.get(oid) ?? null,
      ...(includeHistory ? { statusHistory: historyByOrder.get(oid) ?? [] } : {})
    };
  });
}

/**
 * Authoritative Transactional COD Checkout.
 * - Enforces idempotency keys to prevent duplicate orders from double-clicks or retries.
 * - Locks product rows (`FOR UPDATE`) inside a database transaction to prevent race conditions and stock overselling.
 * - Computes all monetary amounts strictly in integer paise using database product prices (never trusts client prices/totals).
 */
export async function createCodOrder(
  db: DatabaseClient,
  env: Env,
  customer: AuthenticatedUser,
  input: {
    items: Array<{
      productId?: string;
      legacyId?: number;
      slug?: string;
      quantity: number;
    }>;
    addressId?: string;
    deliveryAddress?: {
      recipientName: string;
      phoneNumber: string;
      addressLine1: string;
      addressLine2?: string | null;
      landmark?: string | null;
      city: string;
      state: string;
      pinCode: string;
      saveAddress?: boolean;
    };
    customerNotes?: string;
    idempotencyKey: string;
    marketingOptIn?: {
      table?: boolean;
      atmosphere?: boolean;
      newCollections?: boolean;
    };
  },
  ipHash: string
): Promise<{ order: OrderDto; idempotentReplay: boolean }> {
  const scope = `checkout:${customer.id}`;
  // Compute canonical request hash from items & address (ignoring any forged client price fields)
  const canonicalPayload = JSON.stringify({
    items: input.items.map((i) => ({
      productId: i.productId ?? null,
      legacyId: i.legacyId ?? null,
      slug: i.slug ?? null,
      quantity: i.quantity
    })),
    addressId: input.addressId ?? null,
    deliveryAddress: input.deliveryAddress ?? null
  });
  const requestHash = await sha256Hex(canonicalPayload);

  return db.withTransaction(async (tx) => {
    // 1. Check idempotency record inside transaction
    const existingIdemRes = await tx.query<{
      request_hash: string;
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, response_status, response_body
       FROM idempotency_records
       WHERE scope = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [scope, input.idempotencyKey]
    );

    const existingIdem = existingIdemRes.rows[0];
    if (existingIdem) {
      if (existingIdem.request_hash !== requestHash) {
        throw new ConflictError(
          'Idempotency key has already been used with a different checkout payload.',
          'IDEMPOTENCY_PAYLOAD_MISMATCH'
        );
      }
      if (existingIdem.response_body) {
        const cachedOrder = parseJsonSafe<OrderDto>(existingIdem.response_body, null as unknown as OrderDto);
        if (cachedOrder) {
          return { order: cachedOrder, idempotentReplay: true };
        }
      }
      throw new ConflictError('A checkout with this idempotency key is currently in progress.');
    }

    // Reserve idempotency slot
    const lockedUntilIso = new Date(Date.now() + 60000).toISOString();
    const expiresAtIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await tx.query(
      `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, locked_until, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [scope, input.idempotencyKey, requestHash, lockedUntilIso, expiresAtIso]
    );

    // 2. Enforce COD velocity protection: max 5 unfulfilled COD orders per customer
    const pendingOrdersRes = await tx.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM orders
       WHERE customer_id = $1
         AND order_status IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'PROCESSING', 'PACKED')`,
      [customer.id]
    );
    if (Number(pendingOrdersRes.rows[0]?.cnt ?? 0) >= 5) {
      throw new ConflictError(
        'You have reached the maximum number of active pending COD allocations (5). Please await dispatch or contact the Atelier Concierge.',
        'COD_VELOCITY_LIMIT_EXCEEDED'
      );
    }

    // 3. Resolve & validate delivery address (with strict customer ownership check if addressId is used)
    let addressSnapshot: OrderDto['addressSnapshot'];
    if (input.addressId) {
      const addrRes = await tx.query<Record<string, unknown>>(
        `SELECT recipient_name, phone_number, address_line1, address_line2, landmark, city, state, pin_code
         FROM addresses
         WHERE id = $1 AND customer_id = $2
         LIMIT 1`,
        [input.addressId, customer.id]
      );
      const addrRow = addrRes.rows[0];
      if (!addrRow) {
        throw new AuthorizationError('Selected delivery address does not belong to your account.');
      }
      addressSnapshot = {
        recipientName: String(addrRow.recipient_name),
        phoneNumber: String(addrRow.phone_number),
        addressLine1: String(addrRow.address_line1),
        addressLine2: addrRow.address_line2 ? String(addrRow.address_line2) : null,
        landmark: addrRow.landmark ? String(addrRow.landmark) : null,
        city: String(addrRow.city),
        state: String(addrRow.state),
        pinCode: String(addrRow.pin_code).trim()
      };
    } else if (input.deliveryAddress) {
      addressSnapshot = {
        recipientName: input.deliveryAddress.recipientName,
        phoneNumber: input.deliveryAddress.phoneNumber,
        addressLine1: input.deliveryAddress.addressLine1,
        addressLine2: input.deliveryAddress.addressLine2 ?? null,
        landmark: input.deliveryAddress.landmark ?? null,
        city: input.deliveryAddress.city,
        state: input.deliveryAddress.state,
        pinCode: input.deliveryAddress.pinCode
      };

      if (input.deliveryAddress.saveAddress) {
        await tx.query(
          `INSERT INTO addresses (
             customer_id, recipient_name, phone_number, address_line1,
             address_line2, landmark, city, state, pin_code, address_type, is_default
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'home', FALSE)`,
          [
            customer.id,
            addressSnapshot.recipientName,
            addressSnapshot.phoneNumber,
            addressSnapshot.addressLine1,
            addressSnapshot.addressLine2,
            addressSnapshot.landmark,
            addressSnapshot.city,
            addressSnapshot.state,
            addressSnapshot.pinCode
          ]
        );
      }
    } else {
      throw new ValidationError('Delivery address is required.');
    }

    // 4. Consolidate duplicate items in cart and lock each product row (`FOR UPDATE`) in deterministic order
    const requestedItems: Array<{
      productId?: string;
      legacyId?: number;
      slug?: string;
      quantity: number;
    }> = [];

    for (const item of input.items) {
      const existing = requestedItems.find(
        (r) =>
          (item.productId && r.productId === item.productId) ||
          (item.legacyId && r.legacyId === item.legacyId) ||
          (item.slug && r.slug === item.slug)
      );
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        requestedItems.push({ ...item });
      }
    }

    let subtotalPaise = 0;
    const verifiedOrderLines: Array<{
      productId: string;
      name: string;
      sku: string;
      volume: string;
      division: Division;
      quantity: number;
      unitPricePaise: number;
      lineTotalPaise: number;
      trackInventory: boolean;
    }> = [];

    for (const reqItem of requestedItems) {
      let prodQuery = `SELECT id, name, sku, volume_label, division, price_paise, is_active,
                              track_inventory, stock_quantity, max_order_quantity
                       FROM products WHERE `;
      let param: unknown;
      if (reqItem.productId) {
        prodQuery += `id = $1 FOR UPDATE`;
        param = reqItem.productId;
      } else if (reqItem.legacyId !== undefined) {
        prodQuery += `legacy_numeric_id = $1 FOR UPDATE`;
        param = reqItem.legacyId;
      } else {
        prodQuery += `slug = $1 FOR UPDATE`;
        param = reqItem.slug;
      }

      const prodRes = await tx.query<{
        id: string;
        name: string;
        sku: string;
        volume_label: string;
        division: Division;
        price_paise: number;
        is_active: boolean;
        track_inventory: boolean;
        stock_quantity: number;
        max_order_quantity: number;
      }>(prodQuery, [param]);

      const prod = prodRes.rows[0];
      if (!prod || !prod.is_active) {
        throw new ValidationError('One or more selected elixirs are unavailable or archived.');
      }

      if (reqItem.quantity > Number(prod.max_order_quantity)) {
        throw new ValidationError(
          `Maximum allowed quantity for ${prod.name} is ${prod.max_order_quantity} per order.`
        );
      }

      if (prod.track_inventory && Number(prod.stock_quantity) < reqItem.quantity) {
        throw new ConflictError(
          `Insufficient stock for ${prod.name}. Available vessels: ${prod.stock_quantity}.`,
          'OUT_OF_STOCK',
          { productId: prod.id, availableStock: Number(prod.stock_quantity) }
        );
      }

      const unitPricePaise = Number(prod.price_paise);
      const lineTotalPaise = unitPricePaise * reqItem.quantity;
      subtotalPaise += lineTotalPaise;

      verifiedOrderLines.push({
        productId: prod.id,
        name: prod.name,
        sku: prod.sku,
        volume: prod.volume_label,
        division: prod.division,
        quantity: reqItem.quantity,
        unitPricePaise,
        lineTotalPaise,
        trackInventory: Boolean(prod.track_inventory)
      });
    }

    // 5. Calculate authoritative server-side totals in integer paise
    const taxPaise = 0; // Inclusive / complimentary archival presentation
    const deliveryChargePaise = 0; // Complimentary Ribbed Parchment Wrap & Wax Seal
    const discountPaise = 0;
    const finalAmountPaise = subtotalPaise + taxPaise + deliveryChargePaise - discountPaise;

    const maxCodPaise = Number(env.COD_MAX_ORDER_PAISE || 5000000);
    if (finalAmountPaise > maxCodPaise) {
      throw new ValidationError(
        `Order amount exceeds the maximum permitted Cash on Delivery limit.`
      );
    }

    // 6. Atomically decrement stock for each ordered product
    for (const line of verifiedOrderLines) {
      if (line.trackInventory) {
        const decRes = await tx.query<{ stock_quantity: number }>(
          `UPDATE products
           SET stock_quantity = stock_quantity - $1,
               updated_at = NOW()
           WHERE id = $2 AND stock_quantity >= $1
           RETURNING stock_quantity`,
          [line.quantity, line.productId]
        );
        if (decRes.rowCount === 0) {
          throw new ConflictError(`Stock exhausted during checkout for ${line.name}.`, 'OUT_OF_STOCK');
        }
      }
    }

    // 7. Create unique cryptographic public order reference and tracking token
    const publicOrderRef = generatePublicOrderReference();
    const rawTrackingToken = generateSecureToken(24);
    const trackingTokenHash = await sha256Hex(rawTrackingToken);

    const orderInsertRes = await tx.query<Record<string, unknown>>(
      `INSERT INTO orders (
         public_order_ref,
         tracking_token_hash,
         customer_id,
         address_snapshot,
         order_status,
         admin_status_label,
         payment_method,
         cod_remittance_status,
         subtotal_paise,
         tax_paise,
         delivery_charge_paise,
         discount_paise,
         final_amount_paise,
         cod_amount_due_paise,
         customer_notes
       ) VALUES (
         $1, $2, $3, $4,
         'PENDING_CONFIRMATION', 'Pending Seal', 'COD', 'PENDING',
         $5, $6, $7, $8, $9, $9, $10
       ) RETURNING *`,
      [
        publicOrderRef,
        trackingTokenHash,
        customer.id,
        JSON.stringify(addressSnapshot),
        subtotalPaise,
        taxPaise,
        deliveryChargePaise,
        discountPaise,
        finalAmountPaise,
        input.customerNotes ?? null
      ]
    );

    const createdOrderRow = orderInsertRes.rows[0]!;
    const orderUuid = String(createdOrderRow.id);

    // 8. Insert immutable order_items snapshots
    for (const line of verifiedOrderLines) {
      await tx.query(
        `INSERT INTO order_items (
           order_id, product_id, product_name_snapshot, sku_snapshot,
           volume_snapshot, division_snapshot, quantity, unit_price_paise, line_total_paise
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          orderUuid,
          line.productId,
          line.name,
          line.sku,
          line.volume,
          line.division,
          line.quantity,
          line.unitPricePaise,
          line.lineTotalPaise
        ]
      );
    }

    // 9. Record initial status in order_status_history
    await tx.query(
      `INSERT INTO order_status_history (
         order_id, previous_status, new_status, actor_type, actor_id, notes
       ) VALUES ($1, NULL, 'PENDING_CONFIRMATION', 'customer', $2, 'COD order inscribed and sealed by patron')`,
      [orderUuid, customer.id]
    );

    // 10. Record explicit marketing opt-in ONLY if the customer checked opt-in boxes
    if (
      input.marketingOptIn &&
      (input.marketingOptIn.table ||
        input.marketingOptIn.atmosphere ||
        input.marketingOptIn.newCollections)
    ) {
      await recordMarketingConsentInTx(tx, {
        customerId: customer.id,
        email: customer.email,
        segments: {
          table: Boolean(input.marketingOptIn.table),
          atmosphere: Boolean(input.marketingOptIn.atmosphere),
          newCollections: Boolean(input.marketingOptIn.newCollections)
        },
        source: 'checkout_explicit_opt_in',
        policyVersion: env.PRIVACY_POLICY_VERSION || '2026.11',
        ipHash
      });
    }

    // 11. Enqueue transactional Order Confirmation email in notification_outbox
    await tx.query(
      `INSERT INTO notification_outbox (
         channel, message_category, template_name, recipient_email,
         customer_id, order_id, dedupe_key, payload
       ) VALUES (
         'EMAIL', 'TRANSACTIONAL', 'ORDER_CONFIRMATION', $1,
         $2, $3, $4, $5
       ) ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        customer.email,
        customer.id,
        orderUuid,
        `order_confirm:${orderUuid}`,
        JSON.stringify({
          publicOrderRef,
          finalAmountPaise,
          recipientName: addressSnapshot.recipientName,
          itemCount: verifiedOrderLines.length
        })
      ]
    );

    const hydrated = await hydrateOrders(tx, [createdOrderRow], true);
    const finalOrderDto: OrderDto = {
      ...hydrated[0]!,
      trackingToken: rawTrackingToken
    };

    // 12. Save completed response into idempotency_records
    await tx.query(
      `UPDATE idempotency_records
       SET response_status = 201,
           response_body = $1
       WHERE scope = $2 AND idempotency_key = $3`,
      [JSON.stringify(finalOrderDto), scope, input.idempotencyKey]
    );

    return { order: finalOrderDto, idempotentReplay: false };
  });
}

export async function listCustomerOrders(
  db: DatabaseClient,
  customerId: string,
  options?: { page?: number; limit?: number }
): Promise<{ items: OrderDto[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, options?.page ?? 1);
  const limit = Math.min(50, Math.max(1, options?.limit ?? 20));
  const offset = (page - 1) * limit;

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM orders WHERE customer_id = $1`,
    [customerId]
  );
  const total = Number(countRes.rows[0]?.total ?? 0);

  const rowsRes = await db.query<Record<string, unknown>>(
    `SELECT * FROM orders
     WHERE customer_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [customerId, limit, offset]
  );

  const items = await hydrateOrders(db, rowsRes.rows, true);
  return { items, total, page, limit };
}

function validateOrderIdentifier(orderIdentifier: string): {
  isUuid: boolean;
  cleaned: string;
} {
  const cleaned = (orderIdentifier || '').trim();
  if (!cleaned || cleaned.startsWith('-') || (/^-?\d+$/.test(cleaned) && Number(cleaned) <= 0)) {
    throw new ValidationError('Invalid order identifier: negative or zero IDs are not permitted.');
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned);
  return { isUuid, cleaned };
}

export async function getCustomerOrderById(
  db: DatabaseClient,
  customerId: string,
  orderIdentifier: string
): Promise<OrderDto> {
  const { isUuid, cleaned } = validateOrderIdentifier(orderIdentifier);

  const res = await db.query<Record<string, unknown>>(
    isUuid
      ? `SELECT * FROM orders WHERE id = $1 LIMIT 1`
      : `SELECT * FROM orders WHERE public_order_ref = $1 LIMIT 1`,
    [cleaned]
  );

  const row = res.rows[0];
  if (!row) {
    throw new NotFoundError('Order folio not found.');
  }

  // Strict IDOR protection: verify order belongs to the authenticated customer
  if (String(row.customer_id) !== customerId) {
    throw new AuthorizationError('You do not have permission to view this order.');
  }

  const hydrated = await hydrateOrders(db, [row], true);
  return hydrated[0]!;
}

/**
 * Retrieves an order by its public order reference (`VTS-XXXX-XXXX`).
 * Requires either:
 *   1. An authenticated session belonging to the order owner or an administrator, OR
 *   2. The order's cryptographic `trackingToken` query parameter.
 * Never exposes PII through predictable unauthenticated URLs.
 */
export async function getOrderByTrackingReference(
  db: DatabaseClient,
  trackingReference: string,
  user: AuthenticatedUser | null,
  trackingToken?: string | null
): Promise<OrderDto> {
  const { cleaned } = validateOrderIdentifier(trackingReference);
  const res = await db.query<Record<string, unknown>>(
    `SELECT * FROM orders WHERE public_order_ref = $1 LIMIT 1`,
    [cleaned.toUpperCase()]
  );

  const row = res.rows[0];
  if (!row) {
    throw new NotFoundError('Order reference not found.');
  }

  const isOwner = user && String(row.customer_id) === user.id;
  const isAdmin = user && user.role === 'admin';

  if (!isOwner && !isAdmin) {
    if (!trackingToken || trackingToken.trim().length < 16) {
      throw new AuthorizationError(
        'Authentication or a valid tracking token is required to view this order.'
      );
    }
    const providedHash = await sha256Hex(trackingToken.trim());
    const storedHash = String(row.tracking_token_hash);
    if (!timingSafeEqualStr(providedHash, storedHash)) {
      throw new AuthorizationError('Invalid tracking token for this order reference.');
    }
  }

  const hydrated = await hydrateOrders(db, [row], true);
  return hydrated[0]!;
}

export async function listAdminOrders(
  db: DatabaseClient,
  options?: { status?: string; search?: string; page?: number; limit?: number }
): Promise<{ items: OrderDto[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, options?.page ?? 1);
  const limit = Math.min(100, Math.max(1, options?.limit ?? 50));
  const offset = (page - 1) * limit;

  const params: unknown[] = [];
  const conditions: string[] = [];

  if (options?.status && options.status !== 'all') {
    params.push(options.status);
    conditions.push(`(o.admin_status_label = $${params.length} OR o.order_status = $${params.length})`);
  }

  if (options?.search && options.search.trim().length > 0) {
    params.push(`%${options.search.trim()}%`);
    conditions.push(
      `(o.public_order_ref ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0]?.total ?? 0);

  const queryParams = [...params, limit, offset];
  const rowsRes = await db.query<Record<string, unknown>>(
    `SELECT o.*, c.name AS customer_name, c.email AS customer_email
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     ${whereClause}
     ORDER BY o.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    queryParams
  );

  const items = await hydrateOrders(db, rowsRes.rows, true);
  return { items, total, page, limit };
}

async function restoreOrderInventoryOnce(
  tx: SqlExecutor,
  orderId: string,
  existingOrder: Record<string, unknown>
): Promise<boolean> {
  const prevStatus = String(existingOrder.order_status || '');
  const alreadyRestored =
    Boolean(existingOrder.stock_restored) ||
    prevStatus === 'CANCELLED' ||
    prevStatus === 'RETURN_TO_ORIGIN';

  if (alreadyRestored) {
    return false;
  }

  const itemsRes = await tx.query<{ product_id: string; quantity: number }>(
    `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
    [orderId]
  );
  for (const item of itemsRes.rows) {
    await tx.query(
      `UPDATE products
       SET stock_quantity = stock_quantity + $1,
           updated_at = NOW()
       WHERE id = $2 AND track_inventory = TRUE`,
      [item.quantity, item.product_id]
    );
  }
  return true;
}

export async function updateAdminOrderStatus(
  db: DatabaseClient,
  admin: AuthenticatedUser,
  orderIdentifier: string,
  input: {
    orderStatus?: OrderStatus;
    status?: AdminStatusLabel;
    codRemittanceStatus?: CodRemittanceStatus;
    codRemittanceReference?: string;
    notes?: string;
  },
  ipHash: string,
  userAgent: string
): Promise<OrderDto> {
  const { isUuid, cleaned } = validateOrderIdentifier(orderIdentifier);
  return db.withTransaction(async (tx) => {
    const existingRes = await tx.query<Record<string, unknown>>(
      isUuid
        ? `SELECT * FROM orders WHERE id = $1 FOR UPDATE`
        : `SELECT * FROM orders WHERE public_order_ref = $1 FOR UPDATE`,
      [cleaned]
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new NotFoundError('Order not found.');
    }

    const orderId = String(existing.id);
    const prevStatus = existing.order_status as OrderStatus;

    let nextOrderStatus: OrderStatus = prevStatus;
    if (input.orderStatus) {
      nextOrderStatus = input.orderStatus;
    } else if (input.status) {
      nextOrderStatus = mapAdminLabelToOrderStatus(input.status);
    }

    const wasCancelledOrRto =
      prevStatus === 'CANCELLED' || prevStatus === 'RETURN_TO_ORIGIN' || Boolean(existing.stock_restored);
    const isNowCancelledOrRto =
      nextOrderStatus === 'CANCELLED' || nextOrderStatus === 'RETURN_TO_ORIGIN';

    // Guard 1: Delivered orders cannot be cancelled or marked Return-to-Origin
    if (prevStatus === 'DELIVERED' && isNowCancelledOrRto) {
      throw new ConflictError(
        'Cannot cancel or mark Return-to-Origin on an order that has already been delivered.'
      );
    }

    // Guard 2: Cancelled or Return-to-Origin orders are terminal (stock has already been returned)
    if (wasCancelledOrRto && !isNowCancelledOrRto) {
      throw new ConflictError(
        'Order is already in a terminal Cancelled or Return-to-Origin state and its inventory was restored.'
      );
    }

    const nextAdminLabel = input.status ?? mapOrderStatusToAdminLabel(nextOrderStatus);
    const nextRemittance: CodRemittanceStatus =
      input.codRemittanceStatus ??
      (isNowCancelledOrRto
        ? 'VOIDED'
        : ((existing.cod_remittance_status as CodRemittanceStatus) || 'PENDING'));

    // Restore product stock if transitioning into CANCELLED or RETURN_TO_ORIGIN for the first time
    if (!wasCancelledOrRto && isNowCancelledOrRto) {
      await restoreOrderInventoryOnce(tx, orderId, existing);
    }

    const fulfilledAt =
      nextOrderStatus === 'DELIVERED'
        ? existing.fulfilled_at || new Date().toISOString()
        : existing.fulfilled_at;
    const cancelledAt = isNowCancelledOrRto
      ? existing.cancelled_at || new Date().toISOString()
      : existing.cancelled_at;
    const stockRestored = Boolean(existing.stock_restored) || isNowCancelledOrRto;

    const updatedRes = await tx.query<Record<string, unknown>>(
      `UPDATE orders SET
         order_status = $1,
         admin_status_label = $2,
         cod_remittance_status = $3,
         cod_remittance_reference = COALESCE($4, cod_remittance_reference),
         fulfilled_at = $5,
         cancelled_at = $6,
         cancelled_by = CASE WHEN $7 THEN $8 ELSE cancelled_by END,
         cancellation_reason = COALESCE($9, cancellation_reason),
         stock_restored = $10,
         updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        nextOrderStatus,
        nextAdminLabel,
        nextRemittance,
        input.codRemittanceReference ?? null,
        fulfilledAt ?? null,
        cancelledAt ?? null,
        isNowCancelledOrRto,
        admin.email,
        isNowCancelledOrRto
          ? input.notes ??
            (nextOrderStatus === 'RETURN_TO_ORIGIN'
              ? 'Return to Origin (RTO) recorded by Administrator'
              : 'Cancelled by Administrator')
          : null,
        stockRestored,
        orderId
      ]
    );

    if (prevStatus !== nextOrderStatus) {
      await tx.query(
        `INSERT INTO order_status_history (
           order_id, previous_status, new_status, actor_type, actor_id, notes
         ) VALUES ($1, $2, $3, 'admin', $4, $5)`,
        [orderId, prevStatus, nextOrderStatus, admin.id, input.notes ?? `Updated to ${nextAdminLabel}`]
      );

      // Enqueue dispatch / delivery notification email in notification_outbox
      if (nextOrderStatus === 'DISPATCHED' || nextOrderStatus === 'DELIVERED') {
        const custRes = await tx.query<{ email: string }>(
          `SELECT email FROM customers WHERE id = $1 LIMIT 1`,
          [existing.customer_id]
        );
        const custEmail = custRes.rows[0]?.email;
        if (custEmail) {
          const template =
            nextOrderStatus === 'DISPATCHED' ? 'ORDER_DISPATCHED' : 'ORDER_DELIVERED';
          await tx.query(
            `INSERT INTO notification_outbox (
               channel, message_category, template_name, recipient_email,
               customer_id, order_id, dedupe_key, payload
             ) VALUES (
               'EMAIL', 'TRANSACTIONAL', $1, $2, $3, $4, $5, $6
             ) ON CONFLICT (dedupe_key) DO NOTHING`,
            [
              template,
              custEmail,
              existing.customer_id,
              orderId,
              `${template.toLowerCase()}:${orderId}`,
              JSON.stringify({
                publicOrderRef: existing.public_order_ref,
                status: nextOrderStatus
              })
            ]
          );
        }
      }
    }

    await tx.query(
      `INSERT INTO admin_audit_logs (
         admin_customer_id, admin_email, action, target_type, target_id,
         before_state, after_state, ip_hash, user_agent
       ) VALUES ($1, $2, 'UPDATE_ORDER_STATUS', 'order', $3, $4, $5, $6, $7)`,
      [
        admin.id,
        admin.email,
        orderId,
        JSON.stringify({
          orderStatus: prevStatus,
          adminStatusLabel: existing.admin_status_label,
          codRemittanceStatus: existing.cod_remittance_status
        }),
        JSON.stringify({
          orderStatus: nextOrderStatus,
          adminStatusLabel: nextAdminLabel,
          codRemittanceStatus: nextRemittance
        }),
        ipHash,
        userAgent
      ]
    );

    const hydrated = await hydrateOrders(tx, [updatedRes.rows[0]!], true);
    return hydrated[0]!;
  });
}

export async function updateAdminOrderTracking(
  db: DatabaseClient,
  admin: AuthenticatedUser,
  orderIdentifier: string,
  input: {
    courierCode: string;
    courierName: string;
    awbNumber: string;
    trackingUrl?: string | null;
    currentShipmentState: string;
    estimatedDeliveryAt?: string | null;
    eventNote?: string;
  },
  ipHash: string,
  userAgent: string
): Promise<OrderDto> {
  const { isUuid, cleaned } = validateOrderIdentifier(orderIdentifier);
  return db.withTransaction(async (tx) => {
    const existingRes = await tx.query<Record<string, unknown>>(
      isUuid
        ? `SELECT * FROM orders WHERE id = $1 FOR UPDATE`
        : `SELECT * FROM orders WHERE public_order_ref = $1 FOR UPDATE`,
      [cleaned]
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new NotFoundError('Order not found.');
    }

    const orderId = String(existing.id);
    const newEvent = {
      state: input.currentShipmentState,
      timestamp: new Date().toISOString(),
      note: input.eventNote || `AWB ${input.awbNumber} assigned via ${input.courierName}`
    };

    const existingTrackRes = await tx.query<{ event_history: unknown }>(
      `SELECT event_history FROM shipment_tracking WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    );

    const prevHistory = existingTrackRes.rows[0]
      ? parseJsonSafe<unknown[]>(existingTrackRes.rows[0].event_history, [])
      : [];
    const updatedHistory = [...prevHistory, newEvent];

    await tx.query(
      `INSERT INTO shipment_tracking (
         order_id, courier_code, courier_name, awb_number,
         tracking_url, current_shipment_state, estimated_delivery_at,
         last_event_at, event_history
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
       ON CONFLICT (order_id) DO UPDATE SET
         courier_code = EXCLUDED.courier_code,
         courier_name = EXCLUDED.courier_name,
         awb_number = EXCLUDED.awb_number,
         tracking_url = EXCLUDED.tracking_url,
         current_shipment_state = EXCLUDED.current_shipment_state,
         estimated_delivery_at = EXCLUDED.estimated_delivery_at,
         last_event_at = NOW(),
         event_history = EXCLUDED.event_history,
         updated_at = NOW()`,
      [
        orderId,
        input.courierCode,
        input.courierName,
        input.awbNumber,
        input.trackingUrl ?? null,
        input.currentShipmentState,
        input.estimatedDeliveryAt ?? null,
        JSON.stringify(updatedHistory)
      ]
    );

    // Enqueue shipment tracking notification in notification_outbox
    const custRes = await tx.query<{ email: string }>(
      `SELECT email FROM customers WHERE id = $1 LIMIT 1`,
      [existing.customer_id]
    );
    const custEmail = custRes.rows[0]?.email;
    if (custEmail) {
      await tx.query(
        `INSERT INTO notification_outbox (
           channel, message_category, template_name, recipient_email,
           customer_id, order_id, dedupe_key, payload
         ) VALUES (
           'EMAIL', 'TRANSACTIONAL', 'SHIPMENT_TRACKING_UPDATE', $1, $2, $3, $4, $5
         ) ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          custEmail,
          existing.customer_id,
          orderId,
          `tracking:${orderId}:${input.awbNumber}:${input.currentShipmentState}`,
          JSON.stringify({
            publicOrderRef: existing.public_order_ref,
            courierName: input.courierName,
            awbNumber: input.awbNumber,
            currentShipmentState: input.currentShipmentState,
            trackingUrl: input.trackingUrl ?? null
          })
        ]
      );
    }

    await tx.query(
      `INSERT INTO admin_audit_logs (
         admin_customer_id, admin_email, action, target_type, target_id,
         before_state, after_state, ip_hash, user_agent
       ) VALUES ($1, $2, 'UPDATE_ORDER_TRACKING', 'order', $3, NULL, $4, $5, $6)`,
      [
        admin.id,
        admin.email,
        orderId,
        JSON.stringify({
          courierName: input.courierName,
          awbNumber: input.awbNumber,
          state: input.currentShipmentState
        }),
        ipHash,
        userAgent
      ]
    );

    const hydrated = await hydrateOrders(tx, [existing], true);
    return hydrated[0]!;
  });
}

/**
 * Courier Webhook Adapter with HMAC-SHA256 signature verification and replay protection.
 */
export async function handleCourierWebhook(
  db: DatabaseClient,
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null
): Promise<{ updated: boolean; awbNumber: string }> {
  const secret = env.COURIER_WEBHOOK_SECRET;
  if (!secret) {
    throw new AuthorizationError('Courier webhook secret is not configured.');
  }

  if (!signatureHeader || !timestampHeader) {
    throw new AuthorizationError('Missing courier webhook signature or timestamp headers.');
  }

  const tsSeconds = Number(timestampHeader);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsSeconds) || Math.abs(nowSeconds - tsSeconds) > 300) {
    throw new AuthorizationError('Courier webhook timestamp is outside the 5-minute replay window.');
  }

  const expectedSig = await hmacSha256Hex(secret, `${timestampHeader}.${rawBody}`);
  if (!timingSafeEqualStr(expectedSig, signatureHeader.trim().toLowerCase())) {
    throw new AuthorizationError('Invalid courier webhook HMAC signature.');
  }

  const eventDigest = await sha256Hex(`courier_webhook:${timestampHeader}:${rawBody}`);
  const consumed = await db.query(
    `SELECT token_hash FROM consumed_security_tokens WHERE token_hash = $1`,
    [eventDigest]
  );
  if (consumed.rowCount > 0) {
    throw new ConflictError('Duplicate courier webhook event ignored.');
  }

  await db.query(
    `INSERT INTO consumed_security_tokens (token_hash, token_type, expires_at)
     VALUES ($1, 'COURIER_WEBHOOK', $2)`,
    [eventDigest, new Date(Date.now() + 24 * 3600 * 1000).toISOString()]
  );

  const payload = JSON.parse(rawBody) as {
    awbNumber?: string;
    shipmentState?: string;
    orderStatus?: OrderStatus;
    note?: string;
  };

  if (!payload.awbNumber || !payload.shipmentState) {
    throw new ValidationError('Webhook payload must contain awbNumber and shipmentState.');
  }
  const awbNumber = payload.awbNumber;
  const shipmentState = payload.shipmentState;

  return db.withTransaction(async (tx) => {
    const trackRes = await tx.query<{ order_id: string; event_history: unknown }>(
      `SELECT order_id, event_history FROM shipment_tracking WHERE awb_number = $1 FOR UPDATE`,
      [awbNumber]
    );
    const trackRow = trackRes.rows[0];
    if (!trackRow) {
      throw new NotFoundError('AWB number not found.');
    }

    const orderRes = await tx.query<Record<string, unknown>>(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [trackRow.order_id]
    );
    const orderRow = orderRes.rows[0];
    if (!orderRow) {
      throw new NotFoundError('Associated order not found.');
    }

    const prevStatus = orderRow.order_status as OrderStatus;
    const normShipmentState = shipmentState.trim().toUpperCase();
    const isRtoShipmentState =
      normShipmentState === 'RETURN_TO_ORIGIN' ||
      normShipmentState === 'RTO' ||
      normShipmentState === 'RTO_IN_TRANSIT' ||
      normShipmentState === 'RTO_DELIVERED';

    const nextOrderStatus: OrderStatus | undefined =
      payload.orderStatus ?? (isRtoShipmentState ? 'RETURN_TO_ORIGIN' : undefined);

    if (nextOrderStatus) {
      const wasCancelledOrRto =
        prevStatus === 'CANCELLED' ||
        prevStatus === 'RETURN_TO_ORIGIN' ||
        Boolean(orderRow.stock_restored);
      const isNowCancelledOrRto =
        nextOrderStatus === 'CANCELLED' || nextOrderStatus === 'RETURN_TO_ORIGIN';

      if (prevStatus === 'DELIVERED' && isNowCancelledOrRto) {
        throw new ConflictError(
          'Cannot transition an already delivered order to Return-to-Origin via webhook.'
        );
      }
      if (wasCancelledOrRto && !isNowCancelledOrRto) {
        throw new ConflictError(
          'Order is already in a terminal Cancelled or Return-to-Origin state.'
        );
      }

      if (!wasCancelledOrRto && isNowCancelledOrRto) {
        await restoreOrderInventoryOnce(tx, trackRow.order_id, orderRow);
      }

      const adminLabel = mapOrderStatusToAdminLabel(nextOrderStatus);
      const nextRemittance: CodRemittanceStatus = isNowCancelledOrRto
        ? 'VOIDED'
        : ((orderRow.cod_remittance_status as CodRemittanceStatus) || 'PENDING');
      const stockRestored = Boolean(orderRow.stock_restored) || isNowCancelledOrRto;

      await tx.query(
        `UPDATE orders
         SET order_status = $1,
             admin_status_label = $2,
             cod_remittance_status = $3,
             stock_restored = $4,
             cancelled_at = CASE WHEN $5 THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
             cancelled_by = CASE WHEN $5 THEN COALESCE(cancelled_by, 'courier_webhook') ELSE cancelled_by END,
             cancellation_reason = CASE WHEN $5 THEN COALESCE(cancellation_reason, $6) ELSE cancellation_reason END,
             updated_at = NOW()
         WHERE id = $7`,
        [
          nextOrderStatus,
          adminLabel,
          nextRemittance,
          stockRestored,
          isNowCancelledOrRto,
          payload.note || 'Courier Return to Origin (RTO)',
          trackRow.order_id
        ]
      );

      if (prevStatus !== nextOrderStatus) {
        await tx.query(
          `INSERT INTO order_status_history (
             order_id, previous_status, new_status, actor_type, actor_id, notes
           ) VALUES ($1, $2, $3, 'courier_webhook', $4, $5)`,
          [
            trackRow.order_id,
            prevStatus,
            nextOrderStatus,
            awbNumber,
            payload.note || `Courier webhook state: ${shipmentState}`
          ]
        );
      }
    }

    const history = parseJsonSafe<unknown[]>(trackRow.event_history, []);
    history.push({
      state: shipmentState,
      timestamp: new Date().toISOString(),
      note: payload.note || 'Automated courier webhook update'
    });

    await tx.query(
      `UPDATE shipment_tracking
       SET current_shipment_state = $1,
           last_event_at = NOW(),
           event_history = $2,
           updated_at = NOW()
       WHERE order_id = $3`,
      [shipmentState, JSON.stringify(history), trackRow.order_id]
    );

    return { updated: true, awbNumber };
  });
}
