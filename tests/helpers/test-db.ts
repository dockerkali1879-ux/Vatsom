import { DatabaseClient, QueryResult, QueryResultRow, SqlExecutor } from '../../src/db/client';

/**
 * Transactional Relational Test Database Engine for VATSOM.
 * - Verifies that every SQL query uses parameterized placeholders ($1, $2...) and never interpolates user input.
 * - Enforces ACID transaction semantics: serializes `withTransaction` calls (simulating row-level `FOR UPDATE` locking)
 *   and restores a full deep-cloned state snapshot on `ROLLBACK` when any error is thrown inside a transaction.
 * - Enforces foreign key integrity and check constraints.
 */
export class TransactionalTestDatabase implements DatabaseClient {
  public customers = new Map<string, Record<string, unknown>>();
  public sessions = new Map<string, Record<string, unknown>>();
  public addresses = new Map<string, Record<string, unknown>>();
  public products = new Map<string, Record<string, unknown>>();
  public productMedia = new Map<string, Record<string, unknown>>();
  public orders = new Map<string, Record<string, unknown>>();
  public orderItems = new Map<string, Record<string, unknown>>();
  public orderStatusHistory: Array<Record<string, unknown>> = [];
  public shipmentTracking = new Map<string, Record<string, unknown>>();
  public siteContent = new Map<string, Record<string, unknown>>();
  public marketingConsent: Array<Record<string, unknown>> = [];
  public emailPreferences = new Map<string, Record<string, unknown>>();
  public adminAuditLogs: Array<Record<string, unknown>> = [];
  public idempotencyRecords = new Map<string, Record<string, unknown>>();
  public notificationOutbox = new Map<string, Record<string, unknown>>();
  public rateLimitCounters = new Map<string, Record<string, unknown>>();
  public consumedTokens = new Map<string, Record<string, unknown>>();

  public recordedQueries: Array<{ sql: string; params: unknown[] }> = [];
  public simulateConnectionFailure = false;
  private txLock: Promise<void> = Promise.resolve();

  constructor() {
    this.seedDefaults();
  }

  public seedDefaults(): void {
    const initialProducts = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        legacy_numeric_id: 1,
        slug: 'cold-pressed-black-seed-oil',
        sku: 'VTS-TBL-001',
        name: 'Cold-Pressed Black Seed Oil',
        division: 'TABLE',
        category: 'Edible & Therapeutic',
        description:
          'Sourced from pristine Egyptian fields, mechanically expressed without heat to safeguard high thymoquinone concentration.',
        long_description:
          'Harvested at dawn from mineral-rich alluvial soils in the Faiyum Oasis, our Nigella Sativa seeds are single-pressed in small granite batches below 27°C.',
        price_paise: 6800,
        mrp_paise: 7500,
        volume_label: '250ml',
        volume_ml: 250,
        attributes: {
          notes: 'Nigella Sativa | Pungent, Spicy, Deep Herbal',
          origin: 'Faiyum Oasis, Egypt',
          extraction: 'Raw Granite Cold-Press',
          ritual: 'Drizzle over warm artisanal flatbreads.',
          badge: 'Bestseller',
          filterTag: 'Edible'
        },
        is_active: true,
        track_inventory: true,
        stock_quantity: 10,
        max_order_quantity: 5,
        sort_priority: 10,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        legacy_numeric_id: 2,
        slug: 'wild-forest-oregano-aromatic-oil',
        sku: 'VTS-ATM-002',
        name: 'Wild Forest Oregano Aromatic Oil',
        division: 'ATMOSPHERE',
        category: 'Aromatic Essence',
        description: 'Wild-foraged from high-altitude Balkan cliffs.',
        long_description: 'Hand-gathered above 1,600 meters from sun-drenched limestone ridges.',
        price_paise: 8500,
        mrp_paise: 9500,
        volume_label: '100ml',
        volume_ml: 100,
        attributes: {
          notes: 'Origanum Vulgare | Herbaceous, Warm, Camphorous',
          origin: 'Dinaric Alps, Balkans',
          extraction: 'Copper-Alembic Distillation',
          ritual: 'Add 3–4 drops to a ceramic stone diffuser.',
          badge: 'Rare Harvest',
          filterTag: 'Aromatic'
        },
        is_active: true,
        track_inventory: true,
        stock_quantity: 5,
        max_order_quantity: 5,
        sort_priority: 20,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];

    for (const p of initialProducts) {
      this.products.set(p.id, p);
    }

    this.siteContent.set('primary', {
      key: 'primary',
      hero_banner: 'Purified Botanical & Culinary Extracts',
      hero_title_html:
        'SACRED <span class="italic font-serif font-light text-accentGold">OILS</span> OF DISTINCTION',
      hero_subtitle:
        'Hand-harvested edible elixirs and rare aromatic essences. Pressed in nocturnal silence, inscribed on ribbed parchment, and sealed in obsidian glass.',
      manifesto_title: 'Where Ancient Extraction Meets Modern Precision',
      manifesto_p1:
        'Vatsom was born from an obsession with purity. In an era of mass-industrialized refining, our laboratory-studios adhere strictly to ancestral stone-grinding and pristine cold-expeller techniques.',
      manifesto_p2:
        'Every drop of our culinary or aromatic essence tells a silent story of soil, rain, and careful hand-harvesting.',
      updated_at: new Date().toISOString()
    });
  }

  private createSnapshot() {
    return {
      customers: structuredClone(this.customers),
      sessions: structuredClone(this.sessions),
      addresses: structuredClone(this.addresses),
      products: structuredClone(this.products),
      productMedia: structuredClone(this.productMedia),
      orders: structuredClone(this.orders),
      orderItems: structuredClone(this.orderItems),
      orderStatusHistory: structuredClone(this.orderStatusHistory),
      shipmentTracking: structuredClone(this.shipmentTracking),
      siteContent: structuredClone(this.siteContent),
      marketingConsent: structuredClone(this.marketingConsent),
      emailPreferences: structuredClone(this.emailPreferences),
      adminAuditLogs: structuredClone(this.adminAuditLogs),
      idempotencyRecords: structuredClone(this.idempotencyRecords),
      notificationOutbox: structuredClone(this.notificationOutbox),
      rateLimitCounters: structuredClone(this.rateLimitCounters),
      consumedTokens: structuredClone(this.consumedTokens)
    };
  }

  private restoreSnapshot(snap: ReturnType<TransactionalTestDatabase['createSnapshot']>) {
    this.customers = snap.customers;
    this.sessions = snap.sessions;
    this.addresses = snap.addresses;
    this.products = snap.products;
    this.productMedia = snap.productMedia;
    this.orders = snap.orders;
    this.orderItems = snap.orderItems;
    this.orderStatusHistory = snap.orderStatusHistory;
    this.shipmentTracking = snap.shipmentTracking;
    this.siteContent = snap.siteContent;
    this.marketingConsent = snap.marketingConsent;
    this.emailPreferences = snap.emailPreferences;
    this.adminAuditLogs = snap.adminAuditLogs;
    this.idempotencyRecords = snap.idempotencyRecords;
    this.notificationOutbox = snap.notificationOutbox;
    this.rateLimitCounters = snap.rateLimitCounters;
    this.consumedTokens = snap.consumedTokens;
  }

  async withTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.simulateConnectionFailure) {
      throw new Error('FATAL: remaining connection slots are reserved or database unreachable');
    }

    // Serialize transactions to model PostgreSQL row-level `FOR UPDATE` locking under concurrency
    const prevLock = this.txLock;
    let releaseLock!: () => void;
    this.txLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await prevLock;
    const snapshot = this.createSnapshot();
    try {
      const result = await fn(this);
      return result;
    } catch (err) {
      this.restoreSnapshot(snapshot);
      throw err;
    } finally {
      releaseLock();
    }
  }

  async query<T = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (this.simulateConnectionFailure) {
      throw new Error('Database connection error: ECONNREFUSED');
    }

    const norm = sql.replace(/\s+/g, ' ').trim();
    this.recordedQueries.push({ sql: norm, params });

    // 1. Rate Limit Counters
    if (norm.startsWith('INSERT INTO rate_limit_counters')) {
      const bucketKey = String(params[0]);
      const windowStart = String(params[1]);
      const expiresAt = String(params[2]);
      const existing = this.rateLimitCounters.get(bucketKey);
      const nextCount = existing ? Number(existing.request_count) + 1 : 1;
      this.rateLimitCounters.set(bucketKey, {
        bucket_key: bucketKey,
        window_start: windowStart,
        request_count: nextCount,
        expires_at: expiresAt
      });
      return { rows: [{ request_count: nextCount } as unknown as T], rowCount: 1 };
    }

    // 2. Consumed Security Tokens (Replay protection)
    if (norm.startsWith('SELECT token_hash FROM consumed_security_tokens')) {
      const hash = String(params[0]);
      const row = this.consumedTokens.get(hash);
      return row ? { rows: [row as unknown as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('INSERT INTO consumed_security_tokens')) {
      const hash = String(params[0]);
      const expiresAt = String(params[1]);
      if (!this.consumedTokens.has(hash)) {
        this.consumedTokens.set(hash, {
          token_hash: hash,
          expires_at: expiresAt,
          consumed_at: new Date().toISOString()
        });
      }
      return { rows: [], rowCount: 1 };
    }

    // 3. Customers
    if (norm.includes('FROM customers WHERE google_sub = $1')) {
      const sub = String(params[0]);
      for (const c of this.customers.values()) {
        if (c.google_sub === sub) {
          return { rows: [c as unknown as T], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('INSERT INTO customers')) {
      const id = crypto.randomUUID();
      const row: Record<string, unknown> = {
        id,
        google_sub: String(params[0]),
        name: String(params[1]),
        email: String(params[2]).toLowerCase(),
        email_verified: Boolean(params[3]),
        role: String(params[4]),
        mobile_number: null,
        account_status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_login_at: new Date().toISOString()
      };
      this.customers.set(id, row);
      return { rows: [row as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE customers SET email = $1')) {
      const id = String(params[3]);
      const existing = this.customers.get(id);
      if (!existing) return { rows: [], rowCount: 0 };
      existing.email = String(params[0]);
      existing.email_verified = Boolean(params[1]);
      existing.role = String(params[2]);
      existing.last_login_at = new Date().toISOString();
      existing.updated_at = new Date().toISOString();
      return { rows: [existing as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE customers SET name = $1, mobile_number = $2')) {
      const id = String(params[2]);
      const existing = this.customers.get(id);
      if (!existing) return { rows: [], rowCount: 0 };
      existing.name = String(params[0]);
      existing.mobile_number = params[1] ? String(params[1]) : null;
      existing.updated_at = new Date().toISOString();
      return { rows: [existing as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('SELECT email FROM customers WHERE id = $1')) {
      const c = this.customers.get(String(params[0]));
      return c ? { rows: [{ email: c.email } as unknown as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    // 4. Sessions
    if (norm.startsWith('INSERT INTO sessions')) {
      const id = crypto.randomUUID();
      const customerId = String(params[2]);
      if (!this.customers.has(customerId)) {
        throw new Error('FK violation: session customer_id does not exist');
      }
      const row: Record<string, unknown> = {
        id,
        token_hash: String(params[0]),
        csrf_token_hash: String(params[1]),
        customer_id: customerId,
        session_scope: String(params[3]),
        ip_hash: String(params[4]),
        user_agent: String(params[5]),
        expires_at: String(params[6]),
        created_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
        revoked_at: null,
        revocation_reason: null
      };
      this.sessions.set(id, row);
      return { rows: [{ id } as unknown as T], rowCount: 1 };
    }

    if (norm.includes('FROM sessions s INNER JOIN customers c')) {
      const tokenHash = String(params[0]);
      for (const s of this.sessions.values()) {
        if (s.token_hash === tokenHash) {
          const c = this.customers.get(String(s.customer_id));
          if (!c) return { rows: [], rowCount: 0 };
          return {
            rows: [
              {
                session_id: s.id,
                customer_id: s.customer_id,
                session_scope: s.session_scope,
                csrf_token_hash: s.csrf_token_hash,
                expires_at: s.expires_at,
                revoked_at: s.revoked_at,
                google_sub: c.google_sub,
                name: c.name,
                email: c.email,
                email_verified: c.email_verified,
                mobile_number: c.mobile_number,
                role: c.role,
                account_status: c.account_status
              } as unknown as T
            ],
            rowCount: 1
          };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('UPDATE sessions SET revoked_at = NOW()')) {
      const id = String(params[0]);
      const s = this.sessions.get(id);
      if (s) {
        s.revoked_at = new Date().toISOString();
        s.revocation_reason = 'user_logout';
      }
      return { rows: [], rowCount: s ? 1 : 0 };
    }

    // 5. Addresses
    if (norm.startsWith('SELECT COUNT(*)::int AS cnt FROM addresses WHERE customer_id = $1')) {
      const cid = String(params[0]);
      let cnt = 0;
      for (const a of this.addresses.values()) {
        if (a.customer_id === cid) cnt++;
      }
      return { rows: [{ cnt } as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE addresses SET is_default = FALSE')) {
      const cid = String(params[0]);
      const exceptId = params[1] ? String(params[1]) : null;
      for (const a of this.addresses.values()) {
        if (a.customer_id === cid && (!exceptId || a.id !== exceptId)) {
          a.is_default = false;
        }
      }
      return { rows: [], rowCount: 1 };
    }

    if (norm.startsWith('INSERT INTO addresses')) {
      const id = crypto.randomUUID();
      const isCheckoutInline = norm.includes("'home', FALSE");
      const row: Record<string, unknown> = {
        id,
        customer_id: String(params[0]),
        recipient_name: String(params[1]),
        phone_number: String(params[2]),
        address_line1: String(params[3]),
        address_line2: params[4] ?? null,
        landmark: params[5] ?? null,
        city: String(params[6]),
        state: String(params[7]),
        pin_code: String(params[8]),
        address_type: isCheckoutInline ? 'home' : String(params[9] ?? 'home'),
        is_default: isCheckoutInline ? false : Boolean(params[10]),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.addresses.set(id, row);
      return { rows: [row as unknown as T], rowCount: 1 };
    }

    if (norm.includes('FROM addresses WHERE customer_id = $1 ORDER BY')) {
      const cid = String(params[0]);
      const rows = Array.from(this.addresses.values()).filter((a) => a.customer_id === cid);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    if (norm.includes('FROM addresses WHERE id = $1 AND customer_id = $2')) {
      const aid = String(params[0]);
      const cid = String(params[1]);
      const addr = this.addresses.get(aid);
      if (!addr || addr.customer_id !== cid) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [addr as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE addresses SET recipient_name = $1')) {
      const aid = String(params[10]);
      const cid = String(params[11]);
      const addr = this.addresses.get(aid);
      if (!addr || addr.customer_id !== cid) return { rows: [], rowCount: 0 };
      addr.recipient_name = params[0];
      addr.phone_number = params[1];
      addr.address_line1 = params[2];
      addr.address_line2 = params[3];
      addr.landmark = params[4];
      addr.city = params[5];
      addr.state = params[6];
      addr.pin_code = params[7];
      addr.address_type = params[8];
      addr.is_default = params[9];
      addr.updated_at = new Date().toISOString();
      return { rows: [addr as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('DELETE FROM addresses WHERE id = $1 AND customer_id = $2')) {
      const aid = String(params[0]);
      const cid = String(params[1]);
      const addr = this.addresses.get(aid);
      if (!addr || addr.customer_id !== cid) return { rows: [], rowCount: 0 };
      this.addresses.delete(aid);
      return { rows: [{ id: aid } as unknown as T], rowCount: 1 };
    }

    // 6. Products & Product Media
    if (norm.startsWith('SELECT COUNT(*)::int AS total FROM products WHERE is_active = TRUE')) {
      const divFilter = params[0] ? String(params[0]) : null;
      const list = Array.from(this.products.values()).filter(
        (p) => p.is_active && (!divFilter || p.division === divFilter)
      );
      return { rows: [{ total: list.length } as unknown as T], rowCount: 1 };
    }

    if (norm.includes('FROM products WHERE is_active = TRUE') && norm.includes('ORDER BY sort_priority ASC')) {
      const hasDiv = norm.includes('AND division = $1');
      const divFilter = hasDiv ? String(params[0]) : null;
      const list = Array.from(this.products.values())
        .filter((p) => p.is_active && (!divFilter || p.division === divFilter))
        .sort((a, b) => Number(a.sort_priority) - Number(b.sort_priority));
      return { rows: list as unknown as T[], rowCount: list.length };
    }

    if (norm.includes('FROM products WHERE is_active = TRUE AND')) {
      const param = params[0];
      for (const p of this.products.values()) {
        if (!p.is_active) continue;
        if (norm.includes('id = $1') && p.id === param) return { rows: [p as unknown as T], rowCount: 1 };
        if (norm.includes('legacy_numeric_id = $1') && p.legacy_numeric_id === Number(param))
          return { rows: [p as unknown as T], rowCount: 1 };
        if (norm.includes('slug = $1') && p.slug === param) return { rows: [p as unknown as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('FROM products ORDER BY sort_priority ASC')) {
      const list = Array.from(this.products.values()).sort(
        (a, b) => Number(a.sort_priority) - Number(b.sort_priority)
      );
      return { rows: list as unknown as T[], rowCount: list.length };
    }

    if (norm.startsWith('SELECT id FROM products WHERE slug = $1 OR sku = $2')) {
      for (const p of this.products.values()) {
        if (p.slug === params[0] || p.sku === params[1]) {
          return { rows: [{ id: p.id } as unknown as T], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('SELECT id FROM products WHERE slug = $1 OR lower(name) = lower($2)')) {
      for (const p of this.products.values()) {
        if (p.slug === params[0] || String(p.name).toLowerCase() === String(params[1]).toLowerCase()) {
          return { rows: [{ id: p.id } as unknown as T], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('SELECT COALESCE(MAX(legacy_numeric_id), 6)')) {
      let maxId = 6;
      for (const p of this.products.values()) {
        if (typeof p.legacy_numeric_id === 'number' && p.legacy_numeric_id > maxId) {
          maxId = p.legacy_numeric_id;
        }
      }
      return { rows: [{ max_id: maxId } as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('INSERT INTO products')) {
      const id = crypto.randomUUID();
      const pricePaise = Number(params[8]);
      const mrpPaise = Number(params[9]);
      if (pricePaise < 0 || mrpPaise < pricePaise) {
        throw new Error('CHECK constraint violation on products price_paise/mrp_paise');
      }
      const row: Record<string, unknown> = {
        id,
        legacy_numeric_id: Number(params[0]),
        slug: String(params[1]),
        sku: String(params[2]),
        name: String(params[3]),
        division: String(params[4]),
        category: String(params[5]),
        description: String(params[6]),
        long_description: String(params[7]),
        price_paise: pricePaise,
        mrp_paise: mrpPaise,
        volume_label: String(params[10]),
        volume_ml: params[11] ?? null,
        attributes: typeof params[12] === 'string' ? JSON.parse(params[12]) : params[12],
        is_active: Boolean(params[13]),
        track_inventory: Boolean(params[14]),
        stock_quantity: Number(params[15]),
        max_order_quantity: Number(params[16]),
        sort_priority: Number(params[17]),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.products.set(id, row);
      return { rows: [row as unknown as T], rowCount: 1 };
    }

    if (norm.includes('FROM products WHERE') && norm.includes('FOR UPDATE')) {
      const param = params[0];
      for (const p of this.products.values()) {
        if (norm.includes('id = $1') && p.id === param) return { rows: [p as unknown as T], rowCount: 1 };
        if (norm.includes('legacy_numeric_id = $1') && p.legacy_numeric_id === Number(param))
          return { rows: [p as unknown as T], rowCount: 1 };
        if (norm.includes('slug = $1') && p.slug === param) return { rows: [p as unknown as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('UPDATE products SET name = $1')) {
      const id = String(params[12]);
      const existing = this.products.get(id);
      if (!existing) return { rows: [], rowCount: 0 };
      existing.name = params[0];
      existing.division = params[1];
      existing.category = params[2];
      existing.description = params[3];
      existing.long_description = params[4];
      existing.price_paise = Number(params[5]);
      existing.mrp_paise = Number(params[6]);
      existing.volume_label = params[7];
      existing.attributes = typeof params[8] === 'string' ? JSON.parse(params[8]) : params[8];
      existing.is_active = Boolean(params[9]);
      existing.stock_quantity = Number(params[10]);
      existing.sort_priority = Number(params[11]);
      existing.updated_at = new Date().toISOString();
      return { rows: [existing as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE products SET stock_quantity = stock_quantity - $1')) {
      const qty = Number(params[0]);
      const pid = String(params[1]);
      const prod = this.products.get(pid);
      if (!prod || Number(prod.stock_quantity) < qty) {
        return { rows: [], rowCount: 0 };
      }
      prod.stock_quantity = Number(prod.stock_quantity) - qty;
      return { rows: [{ stock_quantity: prod.stock_quantity } as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE products SET stock_quantity = stock_quantity + $1')) {
      const qty = Number(params[0]);
      const pid = String(params[1]);
      const prod = this.products.get(pid);
      if (prod && prod.track_inventory) {
        prod.stock_quantity = Number(prod.stock_quantity) + qty;
      }
      return { rows: [], rowCount: prod ? 1 : 0 };
    }

    if (norm.startsWith('SELECT COUNT(*)::int AS cnt FROM order_items WHERE product_id = $1')) {
      const pid = String(params[0]);
      let cnt = 0;
      for (const item of this.orderItems.values()) {
        if (item.product_id === pid) cnt++;
      }
      return { rows: [{ cnt } as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE products SET is_active = FALSE')) {
      const prod = this.products.get(String(params[0]));
      if (prod) prod.is_active = false;
      return { rows: [], rowCount: prod ? 1 : 0 };
    }

    if (norm.startsWith('DELETE FROM products WHERE id = $1')) {
      const pid = String(params[0]);
      for (const item of this.orderItems.values()) {
        if (item.product_id === pid) {
          throw new Error('FK constraint violation: product is referenced in order_items');
        }
      }
      const deleted = this.products.delete(pid);
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }

    // Product Media
    if (norm.includes('FROM product_media WHERE product_id IN')) {
      const pids = new Set(params.map(String));
      const rows = Array.from(this.productMedia.values())
        .filter((m) => pids.has(String(m.product_id)))
        .sort((a, b) => Number(a.plate_index) - Number(b.plate_index));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    if (norm.startsWith('DELETE FROM product_media WHERE product_id = $1 AND plate_index = $2')) {
      const pid = String(params[0]);
      const plate = Number(params[1]);
      for (const [k, m] of this.productMedia.entries()) {
        if (m.product_id === pid && m.plate_index === plate) {
          this.productMedia.delete(k);
        }
      }
      return { rows: [], rowCount: 1 };
    }

    if (norm.startsWith('INSERT INTO product_media')) {
      const pid = String(params[0]);
      const plate = Number(params[1]);
      let existingId: string | null = null;
      for (const [k, m] of this.productMedia.entries()) {
        if (m.product_id === pid && m.plate_index === plate) {
          existingId = k;
          break;
        }
      }
      const id = existingId || crypto.randomUUID();
      if (params.length === 4) {
        this.productMedia.set(id, {
          id,
          product_id: pid,
          plate_index: plate,
          media_url: String(params[2]),
          alt_text: String(params[3]),
          mime_type: 'image/webp',
          webp_binary: null
        });
      } else {
        this.productMedia.set(id, {
          id,
          product_id: pid,
          plate_index: plate,
          media_url: `/api/v1/media/${id}`,
          alt_text: String(params[2]),
          mime_type: String(params[3]),
          file_size_bytes: Number(params[4]),
          sha256_hex: String(params[5]),
          webp_binary: params[6]
        });
      }
      return { rows: [{ id } as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE product_media SET media_url = $1 WHERE id = $2')) {
      const m = this.productMedia.get(String(params[1]));
      if (m) m.media_url = String(params[0]);
      return { rows: [], rowCount: m ? 1 : 0 };
    }

    if (norm.includes('FROM product_media WHERE id = $1')) {
      const m = this.productMedia.get(String(params[0]));
      return m ? { rows: [m as unknown as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    // 7. Idempotency Records
    if (norm.includes('FROM idempotency_records WHERE scope = $1 AND idempotency_key = $2')) {
      const key = `${params[0]}::${params[1]}`;
      const rec = this.idempotencyRecords.get(key);
      return rec ? { rows: [rec as unknown as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('INSERT INTO idempotency_records')) {
      const key = `${params[0]}::${params[1]}`;
      this.idempotencyRecords.set(key, {
        scope: String(params[0]),
        idempotency_key: String(params[1]),
        request_hash: String(params[2]),
        locked_until: String(params[3]),
        expires_at: String(params[4]),
        response_status: null,
        response_body: null
      });
      return { rows: [], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE idempotency_records SET response_status = 201')) {
      const key = `${params[1]}::${params[2]}`;
      const rec = this.idempotencyRecords.get(key);
      if (rec) {
        rec.response_status = 201;
        rec.response_body = params[0];
      }
      return { rows: [], rowCount: 1 };
    }

    // 8. Orders, Order Items, Status History & Tracking
    if (norm.includes('SELECT COUNT(*)::int AS cnt FROM orders WHERE customer_id = $1 AND order_status IN')) {
      const cid = String(params[0]);
      let cnt = 0;
      for (const o of this.orders.values()) {
        if (
          o.customer_id === cid &&
          ['PENDING_CONFIRMATION', 'CONFIRMED', 'PROCESSING', 'PACKED'].includes(String(o.order_status))
        ) {
          cnt++;
        }
      }
      return { rows: [{ cnt } as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('INSERT INTO orders')) {
      const id = crypto.randomUUID();
      const customerId = String(params[2]);
      if (!this.customers.has(customerId)) {
        throw new Error('FK violation: order customer_id does not exist');
      }
      const row: Record<string, unknown> = {
        id,
        public_order_ref: String(params[0]),
        tracking_token_hash: String(params[1]),
        customer_id: customerId,
        address_snapshot: params[3],
        order_status: 'PENDING_CONFIRMATION',
        admin_status_label: 'Pending Seal',
        payment_method: 'COD',
        cod_remittance_status: 'PENDING',
        subtotal_paise: Number(params[4]),
        tax_paise: Number(params[5]),
        delivery_charge_paise: Number(params[6]),
        discount_paise: Number(params[7]),
        final_amount_paise: Number(params[8]),
        cod_amount_due_paise: Number(params[8]),
        customer_notes: params[9] ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.orders.set(id, row);
      return { rows: [row as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('INSERT INTO order_items')) {
      const id = crypto.randomUUID();
      const orderId = String(params[0]);
      const productId = String(params[1]);
      if (!this.orders.has(orderId) || !this.products.has(productId)) {
        throw new Error('FK violation on order_items');
      }
      const qty = Number(params[6]);
      const unitPaise = Number(params[7]);
      const linePaise = Number(params[8]);
      if (qty <= 0 || linePaise !== unitPaise * qty) {
        throw new Error('CHECK constraint violation on order_items');
      }
      const row: Record<string, unknown> = {
        id,
        order_id: orderId,
        product_id: productId,
        product_name_snapshot: String(params[2]),
        sku_snapshot: String(params[3]),
        volume_snapshot: String(params[4]),
        division_snapshot: String(params[5]),
        quantity: qty,
        unit_price_paise: unitPaise,
        line_total_paise: linePaise,
        created_at: new Date().toISOString()
      };
      this.orderItems.set(id, row);
      return { rows: [row as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('INSERT INTO order_status_history')) {
      this.orderStatusHistory.push({
        id: crypto.randomUUID(),
        order_id: String(params[0]),
        previous_status: params[1] ?? null,
        new_status: String(params[2]),
        actor_type: String(params[3]),
        actor_id: params[4] ?? null,
        notes: params[5] ?? null,
        created_at: new Date().toISOString()
      });
      return { rows: [], rowCount: 1 };
    }

    if (norm.includes('FROM order_items WHERE order_id IN')) {
      const oids = new Set(params.map(String));
      const rows = Array.from(this.orderItems.values()).filter((i) => oids.has(String(i.order_id)));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    if (norm.startsWith('SELECT product_id, quantity FROM order_items WHERE order_id = $1')) {
      const oid = String(params[0]);
      const rows = Array.from(this.orderItems.values()).filter((i) => i.order_id === oid);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    if (norm.includes('FROM shipment_tracking WHERE order_id IN')) {
      const oids = new Set(params.map(String));
      const rows = Array.from(this.shipmentTracking.values()).filter((t) =>
        oids.has(String(t.order_id))
      );
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    if (norm.includes('FROM shipment_tracking WHERE order_id = $1 FOR UPDATE')) {
      const t = this.shipmentTracking.get(String(params[0]));
      return t ? { rows: [t as unknown as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (norm.includes('FROM shipment_tracking WHERE awb_number = $1 FOR UPDATE')) {
      const awb = String(params[0]);
      for (const t of this.shipmentTracking.values()) {
        if (t.awb_number === awb) {
          return { rows: [t as unknown as T], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('INSERT INTO shipment_tracking')) {
      const oid = String(params[0]);
      const row: Record<string, unknown> = {
        id: crypto.randomUUID(),
        order_id: oid,
        courier_code: String(params[1]),
        courier_name: String(params[2]),
        awb_number: String(params[3]),
        tracking_url: params[4] ?? null,
        current_shipment_state: String(params[5]),
        estimated_delivery_at: params[6] ?? null,
        last_event_at: new Date().toISOString(),
        event_history: typeof params[7] === 'string' ? JSON.parse(params[7]) : params[7]
      };
      this.shipmentTracking.set(oid, row);
      return { rows: [row as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('UPDATE shipment_tracking SET current_shipment_state = $1')) {
      const oid = String(params[2]);
      const t = this.shipmentTracking.get(oid);
      if (t) {
        t.current_shipment_state = String(params[0]);
        t.event_history = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
        t.last_event_at = new Date().toISOString();
      }
      return { rows: [], rowCount: t ? 1 : 0 };
    }

    if (norm.includes('FROM order_status_history WHERE order_id IN')) {
      const oids = new Set(params.map(String));
      const rows = this.orderStatusHistory.filter((h) => oids.has(String(h.order_id)));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    if (norm.startsWith('SELECT COUNT(*)::int AS total FROM orders WHERE customer_id = $1')) {
      const cid = String(params[0]);
      const list = Array.from(this.orders.values()).filter((o) => o.customer_id === cid);
      return { rows: [{ total: list.length } as unknown as T], rowCount: 1 };
    }

    if (norm.startsWith('SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC')) {
      const cid = String(params[0]);
      const list = Array.from(this.orders.values()).filter((o) => o.customer_id === cid);
      return { rows: list as unknown as T[], rowCount: list.length };
    }

    if (norm.startsWith('SELECT * FROM orders WHERE id = $1')) {
      const o = this.orders.get(String(params[0]));
      return o ? { rows: [o as unknown as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('SELECT * FROM orders WHERE public_order_ref = $1')) {
      const ref = String(params[0]);
      for (const o of this.orders.values()) {
        if (o.public_order_ref === ref) {
          return { rows: [o as unknown as T], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('FROM orders o LEFT JOIN customers c ON c.id = o.customer_id')) {
      if (norm.startsWith('SELECT COUNT(*)::int AS total')) {
        return { rows: [{ total: this.orders.size } as unknown as T], rowCount: 1 };
      }
      const list = Array.from(this.orders.values()).map((o) => {
        const c = this.customers.get(String(o.customer_id));
        return {
          ...o,
          customer_name: c?.name ?? 'Patron',
          customer_email: c?.email ?? ''
        };
      });
      return { rows: list as unknown as T[], rowCount: list.length };
    }

    if (norm.startsWith('UPDATE orders SET order_status = $1')) {
      if (params.length === 7) {
        const oid = String(params[6]);
        const o = this.orders.get(oid);
        if (!o) return { rows: [], rowCount: 0 };
        o.order_status = params[0];
        o.admin_status_label = params[1];
        o.cod_remittance_status = params[2];
        o.stock_restored = Boolean(params[3]);
        if (params[4]) {
          o.cancelled_at = o.cancelled_at || new Date().toISOString();
          o.cancelled_by = o.cancelled_by || 'courier_webhook';
          o.cancellation_reason = o.cancellation_reason || params[5];
        }
        o.updated_at = new Date().toISOString();
        return { rows: [o as unknown as T], rowCount: 1 };
      }
      const oid = String(params[10] ?? params[9]);
      const o = this.orders.get(oid);
      if (!o) return { rows: [], rowCount: 0 };
      o.order_status = params[0];
      o.admin_status_label = params[1];
      o.cod_remittance_status = params[2];
      if (params[3]) o.cod_remittance_reference = params[3];
      o.fulfilled_at = params[4];
      o.cancelled_at = params[5];
      if (params[6]) o.cancelled_by = params[7];
      if (params[8]) o.cancellation_reason = params[8];
      if (params.length >= 11) {
        o.stock_restored = Boolean(params[9]);
      }
      o.updated_at = new Date().toISOString();
      return { rows: [o as unknown as T], rowCount: 1 };
    }

    // 9. Site Content
    if (norm.includes("FROM site_content WHERE key = 'primary'")) {
      const row = this.siteContent.get('primary');
      return row ? { rows: [row as unknown as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('INSERT INTO site_content')) {
      const row: Record<string, unknown> = {
        key: 'primary',
        hero_banner: String(params[0]),
        hero_title_html: String(params[1]),
        hero_subtitle: String(params[2]),
        manifesto_title: String(params[3]),
        manifesto_p1: String(params[4]),
        manifesto_p2: String(params[5]),
        updated_by: params[6],
        updated_at: new Date().toISOString()
      };
      this.siteContent.set('primary', row);
      return { rows: [row as unknown as T], rowCount: 1 };
    }

    // 10. Marketing Consent & Email Preferences
    if (norm.startsWith('INSERT INTO email_preferences')) {
      const email = String(params[0]).toLowerCase();
      const existing = this.emailPreferences.get(email);
      if (params.length === 4) {
        this.emailPreferences.set(email, {
          email,
          customer_id: params[1],
          sub_table: existing ? existing.sub_table : false,
          sub_atmosphere: existing ? existing.sub_atmosphere : false,
          sub_new_collections: existing ? existing.sub_new_collections : false,
          sub_product_updates: existing ? existing.sub_product_updates : false,
          sub_promotional_campaigns: existing ? existing.sub_promotional_campaigns : false,
          is_suppressed: existing ? existing.is_suppressed : false,
          unsubscribe_token_hash: String(params[2]),
          policy_version: String(params[3]),
          updated_at: new Date().toISOString()
        });
      } else if (params.length === 9) {
        this.emailPreferences.set(email, {
          email,
          customer_id: params[1] ?? existing?.customer_id ?? null,
          sub_table: Boolean(params[2]) || Boolean(existing?.sub_table),
          sub_atmosphere: Boolean(params[3]) || Boolean(existing?.sub_atmosphere),
          sub_new_collections: Boolean(params[4]) || Boolean(existing?.sub_new_collections),
          sub_product_updates: Boolean(params[5]) || Boolean(existing?.sub_product_updates),
          sub_promotional_campaigns:
            Boolean(params[6]) || Boolean(existing?.sub_promotional_campaigns),
          is_suppressed: false,
          suppression_reason: null,
          unsubscribe_token_hash: existing?.unsubscribe_token_hash ?? String(params[7]),
          policy_version: String(params[8]),
          updated_at: new Date().toISOString()
        });
      } else if (params.length === 10) {
        this.emailPreferences.set(email, {
          email,
          customer_id: params[1],
          sub_table: Boolean(params[2]),
          sub_atmosphere: Boolean(params[3]),
          sub_new_collections: Boolean(params[4]),
          sub_product_updates: Boolean(params[5]),
          sub_promotional_campaigns: Boolean(params[6]),
          is_suppressed: Boolean(params[7]),
          unsubscribe_token_hash: String(params[8]),
          policy_version: String(params[9]),
          updated_at: new Date().toISOString()
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (norm.startsWith('INSERT INTO marketing_consent')) {
      this.marketingConsent.push({
        id: crypto.randomUUID(),
        customer_id: params[0] ?? null,
        email: String(params[1]),
        consent_category: String(params[2]),
        consent_state: norm.includes("'OPTED_IN'")
          ? 'OPTED_IN'
          : norm.includes("'OPTED_OUT'")
            ? 'OPTED_OUT'
            : String(params[3]),
        policy_version: String(params[norm.includes("'OPTED_") ? 3 : 4]),
        consented_at: new Date().toISOString()
      });
      return { rows: [], rowCount: 1 };
    }

    if (norm.includes('FROM email_preferences WHERE unsubscribe_token_hash = $1')) {
      const hash = String(params[0]);
      for (const p of this.emailPreferences.values()) {
        if (p.unsubscribe_token_hash === hash) {
          return { rows: [p as unknown as T], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('UPDATE email_preferences SET sub_table = FALSE')) {
      const email = String(params[1]).toLowerCase();
      const pref = this.emailPreferences.get(email);
      if (pref) {
        pref.sub_table = false;
        pref.sub_atmosphere = false;
        pref.sub_new_collections = false;
        pref.sub_product_updates = false;
        pref.sub_promotional_campaigns = false;
        pref.is_suppressed = true;
        pref.suppression_reason = params[0];
      } else {
        this.emailPreferences.set(email, {
          email,
          customer_id: null,
          sub_table: false,
          sub_atmosphere: false,
          sub_new_collections: false,
          sub_product_updates: false,
          sub_promotional_campaigns: false,
          is_suppressed: true,
          suppression_reason: params[0],
          unsubscribe_token_hash: crypto.randomUUID().replace(/-/g, ''),
          policy_version: '2026.11',
          updated_at: new Date().toISOString()
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (norm.includes('FROM email_preferences WHERE customer_id = $1 OR email = $2')) {
      const cid = String(params[0]);
      const email = String(params[1]).toLowerCase();
      for (const p of this.emailPreferences.values()) {
        if (p.customer_id === cid || p.email === email) {
          return { rows: [p as unknown as T], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('SELECT is_suppressed FROM email_preferences WHERE email = $1')) {
      const pref = this.emailPreferences.get(String(params[0]).toLowerCase());
      return pref
        ? { rows: [{ is_suppressed: pref.is_suppressed } as unknown as T], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    // 11. Notification Outbox
    if (norm.startsWith('INSERT INTO notification_outbox')) {
      const isOrderNotif = norm.includes('order_id');
      const hasFixedTemplate =
        norm.includes("'WELCOME_PATRON'") ||
        norm.includes("'ORDER_CONFIRMATION'") ||
        norm.includes("'SHIPMENT_TRACKING_UPDATE'");
      const dedupeKey = String(
        params[isOrderNotif ? (hasFixedTemplate ? 3 : 4) : 2]
      );
      if (!this.notificationOutbox.has(dedupeKey)) {
        const id = crypto.randomUUID();
        this.notificationOutbox.set(dedupeKey, {
          id,
          channel: 'EMAIL',
          message_category: 'TRANSACTIONAL',
          template_name: norm.includes("'WELCOME_PATRON'")
            ? 'WELCOME_PATRON'
            : norm.includes("'ORDER_CONFIRMATION'")
              ? 'ORDER_CONFIRMATION'
              : norm.includes("'SHIPMENT_TRACKING_UPDATE'")
                ? 'SHIPMENT_TRACKING_UPDATE'
                : String(params[0]),
          recipient_email: String(params[isOrderNotif && !hasFixedTemplate ? 1 : 0]),
          dedupe_key: dedupeKey,
          payload: params[params.length - 1],
          status: 'PENDING',
          attempt_count: 0,
          max_attempts: 5,
          provider_message_id: null,
          sent_at: null,
          last_error: null,
          next_attempt_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (norm.includes('FROM notification_outbox WHERE status IN')) {
      const nowMs = Date.now();
      const rows = Array.from(this.notificationOutbox.values()).filter(
        (j) =>
          (j.status === 'PENDING' ||
            j.status === 'FAILED' ||
            j.status === 'PROVIDER_NOT_CONFIGURED') &&
          !j.sent_at &&
          !j.provider_message_id &&
          Number(j.attempt_count ?? 0) < Number(j.max_attempts ?? 5) &&
          new Date(String(j.next_attempt_at)).getTime() <= nowMs + 50
      );
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    if (norm.includes('FROM notification_outbox ORDER BY created_at DESC')) {
      const rows = Array.from(this.notificationOutbox.values());
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    if (norm.startsWith('UPDATE notification_outbox')) {
      // 0A. Stale PROCESSING lease recovery
      if (norm.includes("WHERE status = 'PROCESSING'")) {
        const cutoffMs = new Date(String(params[0])).getTime();
        const recovered: Array<{ id: unknown }> = [];
        for (const job of this.notificationOutbox.values()) {
          const updatedAtMs = new Date(String(job.updated_at || job.created_at)).getTime();
          if (
            job.status === 'PROCESSING' &&
            !job.sent_at &&
            !job.provider_message_id &&
            updatedAtMs <= cutoffMs
          ) {
            job.status = 'FAILED';
            job.attempt_count = Number(job.attempt_count ?? 0) + 1;
            job.next_attempt_at = new Date().toISOString();
            job.last_error = 'Recovered from stale PROCESSING lease timeout';
            job.updated_at = new Date().toISOString();
            recovered.push({ id: job.id });
          }
        }
        return { rows: recovered as unknown as T[], rowCount: recovered.length };
      }

      // 0B. Exhausted FAILED jobs manual recovery
      if (norm.includes('SET max_attempts = attempt_count + 3')) {
        const recovered: Array<{ id: unknown }> = [];
        for (const job of this.notificationOutbox.values()) {
          if (
            job.status === 'FAILED' &&
            Number(job.attempt_count ?? 0) >= Number(job.max_attempts ?? 5) &&
            !job.sent_at &&
            !job.provider_message_id
          ) {
            job.max_attempts = Number(job.attempt_count ?? 5) + 3;
            job.next_attempt_at = new Date().toISOString();
            job.last_error = 'Re-queued by Administrator after provider recovery';
            job.updated_at = new Date().toISOString();
            recovered.push({ id: job.id });
          }
        }
        return { rows: recovered as unknown as T[], rowCount: recovered.length };
      }

      if (norm.includes("SET status = 'PROCESSING'")) {
        const id = String(params[0]);
        for (const job of this.notificationOutbox.values()) {
          if (
            job.id === id &&
            (job.status === 'PENDING' ||
              job.status === 'FAILED' ||
              job.status === 'PROVIDER_NOT_CONFIGURED') &&
            !job.sent_at &&
            !job.provider_message_id
          ) {
            job.status = 'PROCESSING';
            job.updated_at = new Date().toISOString();
            return { rows: [{ id: job.id } as unknown as T], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      const id = String(params[params.length - 1]);
      for (const job of this.notificationOutbox.values()) {
        if (job.id === id) {
          if (norm.includes("status = 'PROVIDER_NOT_CONFIGURED'")) {
            job.status = 'PROVIDER_NOT_CONFIGURED';
            job.last_error = 'Email provider not yet configured; notification safely persisted in outbox.';
            job.updated_at = new Date().toISOString();
          } else if (norm.includes("status = 'SENT'")) {
            job.status = 'SENT';
            job.attempt_count = Number(params[0]);
            job.provider_message_id = String(params[1]);
            job.sent_at = new Date().toISOString();
            job.last_error = null;
            job.updated_at = new Date().toISOString();
          } else if (norm.includes("status = 'FAILED'")) {
            job.status = 'FAILED';
            job.attempt_count = Number(params[0]);
            job.next_attempt_at = String(params[1]);
            job.last_error = String(params[2]);
            job.updated_at = new Date().toISOString();
          } else if (norm.includes("status = 'SUPPRESSED'")) {
            job.status = 'SUPPRESSED';
            job.updated_at = new Date().toISOString();
          }
        }
      }
      return { rows: [], rowCount: 1 };
    }

    // 12. Admin Audit Logs
    if (norm.startsWith('INSERT INTO admin_audit_logs')) {
      const hasDynamicAction = !norm.includes("'CREATE_PRODUCT'") &&
        !norm.includes("'UPDATE_PRODUCT'") &&
        !norm.includes("'UPDATE_ORDER_STATUS'") &&
        !norm.includes("'UPDATE_ORDER_TRACKING'") &&
        !norm.includes("'UPDATE_SITE_CONTENT'");

      this.adminAuditLogs.push({
        id: crypto.randomUUID(),
        admin_customer_id: String(params[0]),
        admin_email: String(params[1]),
        action: hasDynamicAction
          ? String(params[2])
          : norm.includes("'CREATE_PRODUCT'")
            ? 'CREATE_PRODUCT'
            : norm.includes("'UPDATE_PRODUCT'")
              ? 'UPDATE_PRODUCT'
              : norm.includes("'UPDATE_ORDER_STATUS'")
                ? 'UPDATE_ORDER_STATUS'
                : norm.includes("'UPDATE_ORDER_TRACKING'")
                  ? 'UPDATE_ORDER_TRACKING'
                  : 'UPDATE_SITE_CONTENT',
        target_id: String(params[hasDynamicAction ? 3 : 2]),
        created_at: new Date().toISOString()
      });
      return { rows: [], rowCount: 1 };
    }

    if (norm.includes('FROM admin_audit_logs ORDER BY created_at DESC')) {
      return {
        rows: this.adminAuditLogs as unknown as T[],
        rowCount: this.adminAuditLogs.length
      };
    }

    return { rows: [], rowCount: 0 };
  }
}

