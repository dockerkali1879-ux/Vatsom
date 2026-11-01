import { escapeHtml, sanitizeHeroTitleHtml } from '../crypto';
import { DatabaseClient } from '../db/client';
import { AuthenticatedUser, Division } from '../types';
import { createAdminProduct, slugifyProductName } from './product-service';

export interface SiteContentDto {
  heroBanner: string;
  heroTitleHtml: string;
  heroSubtitle: string;
  manifestoTitle: string;
  manifestoP1: string;
  manifestoP2: string;
  updatedAt?: string;
}

export const DEFAULT_SITE_CONTENT: SiteContentDto = {
  heroBanner: 'Purified Botanical & Culinary Extracts',
  heroTitleHtml:
    'SACRED <span class="italic font-serif font-light text-accentGold">OILS</span> OF DISTINCTION',
  heroSubtitle:
    'Hand-harvested edible elixirs and rare aromatic essences. Pressed in nocturnal silence, inscribed on ribbed parchment, and sealed in obsidian glass.',
  manifestoTitle: 'Where Ancient Extraction Meets Modern Precision',
  manifestoP1:
    'Vatsom was born from an obsession with purity. In an era of mass-industrialized refining, our laboratory-studios adhere strictly to ancestral stone-grinding and pristine cold-expeller techniques.',
  manifestoP2:
    'Every drop of our culinary or aromatic essence tells a silent story of soil, rain, and careful hand-harvesting.'
};

export async function getSiteContent(db: DatabaseClient): Promise<SiteContentDto> {
  const res = await db.query<{
    hero_banner: string;
    hero_title_html: string;
    hero_subtitle: string;
    manifesto_title: string;
    manifesto_p1: string;
    manifesto_p2: string;
    updated_at: string;
  }>(
    `SELECT hero_banner, hero_title_html, hero_subtitle,
            manifesto_title, manifesto_p1, manifesto_p2, updated_at
     FROM site_content
     WHERE key = 'primary'
     LIMIT 1`
  );

  const row = res.rows[0];
  if (!row) {
    return { ...DEFAULT_SITE_CONTENT };
  }

  return {
    heroBanner: row.hero_banner,
    heroTitleHtml: row.hero_title_html,
    heroSubtitle: row.hero_subtitle,
    manifestoTitle: row.manifesto_title,
    manifestoP1: row.manifesto_p1,
    manifestoP2: row.manifesto_p2,
    updatedAt: String(row.updated_at)
  };
}

export async function updateSiteContent(
  db: DatabaseClient,
  admin: AuthenticatedUser,
  input: SiteContentDto,
  ipHash: string,
  userAgent: string
): Promise<SiteContentDto> {
  const safeHeroBanner = escapeHtml(input.heroBanner.trim());
  const safeHeroTitleHtml = sanitizeHeroTitleHtml(input.heroTitleHtml.trim());
  const safeHeroSubtitle = escapeHtml(input.heroSubtitle.trim());
  const safeManifestoTitle = escapeHtml(input.manifestoTitle.trim());
  const safeManifestoP1 = escapeHtml(input.manifestoP1.trim());
  const safeManifestoP2 = escapeHtml(input.manifestoP2.trim());

  return db.withTransaction(async (tx) => {
    const prev = await getSiteContent(db);

    const res = await tx.query<{
      hero_banner: string;
      hero_title_html: string;
      hero_subtitle: string;
      manifesto_title: string;
      manifesto_p1: string;
      manifesto_p2: string;
      updated_at: string;
    }>(
      `INSERT INTO site_content (
         key, hero_banner, hero_title_html, hero_subtitle,
         manifesto_title, manifesto_p1, manifesto_p2, updated_by, updated_at
       ) VALUES ('primary', $1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (key) DO UPDATE SET
         hero_banner = EXCLUDED.hero_banner,
         hero_title_html = EXCLUDED.hero_title_html,
         hero_subtitle = EXCLUDED.hero_subtitle,
         manifesto_title = EXCLUDED.manifesto_title,
         manifesto_p1 = EXCLUDED.manifesto_p1,
         manifesto_p2 = EXCLUDED.manifesto_p2,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING hero_banner, hero_title_html, hero_subtitle,
                 manifesto_title, manifesto_p1, manifesto_p2, updated_at`,
      [
        safeHeroBanner,
        safeHeroTitleHtml,
        safeHeroSubtitle,
        safeManifestoTitle,
        safeManifestoP1,
        safeManifestoP2,
        admin.id
      ]
    );

    const updated = res.rows[0]!;

    await tx.query(
      `INSERT INTO admin_audit_logs (
         admin_customer_id, admin_email, action, target_type, target_id,
         before_state, after_state, ip_hash, user_agent
       ) VALUES ($1, $2, 'UPDATE_SITE_CONTENT', 'site_content', 'primary', $3, $4, $5, $6)`,
      [
        admin.id,
        admin.email,
        JSON.stringify(prev),
        JSON.stringify({
          heroBanner: updated.hero_banner,
          manifestoTitle: updated.manifesto_title
        }),
        ipHash,
        userAgent
      ]
    );

    return {
      heroBanner: updated.hero_banner,
      heroTitleHtml: updated.hero_title_html,
      heroSubtitle: updated.hero_subtitle,
      manifestoTitle: updated.manifesto_title,
      manifestoP1: updated.manifesto_p1,
      manifestoP2: updated.manifesto_p2,
      updatedAt: String(updated.updated_at)
    };
  });
}

export async function listAdminAuditLogs(
  db: DatabaseClient,
  limit = 50
): Promise<Array<Record<string, unknown>>> {
  const res = await db.query<Record<string, unknown>>(
    `SELECT id, admin_customer_id, admin_email, action, target_type, target_id,
            before_state, after_state, created_at
     FROM admin_audit_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(100, Math.max(1, limit))]
  );
  return res.rows;
}

/**
 * One-time safe migration tool for importing legacy localStorage data
 * (`vatsom_products_v1`, `vatsom_site_content_v1`, `vatsom_orders_v1`) into PostgreSQL.
 * - Supports `dryRun: true` (default) to preview what will be imported vs skipped.
 * - Never overwrites existing valid database records silently.
 * - Reviews and flags demo/test orders (`VTS-8492`, `VTS-8479`, `VTS-8451`, `VTS-8410`) so they are not blindly imported as real orders.
 */
export async function migrateLegacyLocalStorageData(
  db: DatabaseClient,
  admin: AuthenticatedUser,
  input: {
    dryRun: boolean;
    products?: Array<Record<string, unknown>>;
    siteContent?: SiteContentDto;
    orders?: Array<Record<string, unknown>>;
  },
  ipHash: string,
  userAgent: string
): Promise<{
  dryRun: boolean;
  productsImported: number;
  productsSkippedDuplicates: number;
  siteContentUpdated: boolean;
  demoOrdersSkipped: number;
  warnings: string[];
}> {
  let productsImported = 0;
  let productsSkippedDuplicates = 0;
  let siteContentUpdated = false;
  let demoOrdersSkipped = 0;
  const warnings: string[] = [];

  const knownDemoOrderIds = new Set(['VTS-8492', 'VTS-8479', 'VTS-8451', 'VTS-8410']);

  if (Array.isArray(input.orders)) {
    for (const o of input.orders) {
      const ref = String(o.orderId || '');
      if (knownDemoOrderIds.has(ref) || String(o.customer || '').includes('Private Atelier Client')) {
        demoOrdersSkipped++;
        warnings.push(`Skipped demo/simulated localStorage order ${ref} (${String(o.customer || 'Demo')}).`);
      }
    }
  }

  if (Array.isArray(input.products)) {
    for (const rawProd of input.products) {
      const name = String(rawProd.name || '').trim();
      if (!name || name.length < 2) {
        warnings.push('Skipped product with missing or invalid name.');
        continue;
      }

      const slug = slugifyProductName(name);
      const existingRes = await db.query<{ id: string }>(
        `SELECT id FROM products WHERE slug = $1 OR lower(name) = lower($2) LIMIT 1`,
        [slug, name]
      );

      if (existingRes.rowCount > 0) {
        productsSkippedDuplicates++;
        continue;
      }

      if (!input.dryRun) {
        const filterTag = rawProd.filterTag === 'Aromatic' ? 'Aromatic' : 'Edible';
        const division: Division = filterTag === 'Aromatic' ? 'ATMOSPHERE' : 'TABLE';
        const priceNum = Number(rawProd.price ?? 0);
        const pricePaise = Math.max(0, Math.round(priceNum * 100));

        await createAdminProduct(
          db,
          admin,
          {
            name,
            slug,
            division,
            filterTag,
            category: String(rawProd.category || 'Botanical Reserve'),
            description: String(rawProd.description || name),
            longDescription: String(rawProd.longDescription || rawProd.description || name),
            pricePaise,
            mrpPaise: pricePaise,
            volume: String(rawProd.volume || '250ml'),
            badge: String(rawProd.badge || 'Reserve'),
            notes: String(rawProd.notes || name),
            origin: String(rawProd.origin || 'Single-Origin Estate'),
            extraction: String(rawProd.extraction || 'First Cold-Press (<27°C)'),
            ritual: String(rawProd.ritual || ''),
            isActive: false,
            stockQuantity: 0,
            images: Array.isArray(rawProd.images)
              ? (rawProd.images.slice(0, 3) as string[])
              : []
          },
          ipHash,
          userAgent
        );
      }
      productsImported++;
    }
  }

  if (input.siteContent) {
    if (!input.dryRun) {
      await updateSiteContent(db, admin, input.siteContent, ipHash, userAgent);
    }
    siteContentUpdated = true;
  }

  return {
    dryRun: input.dryRun,
    productsImported,
    productsSkippedDuplicates,
    siteContentUpdated,
    demoOrdersSkipped,
    warnings
  };
}

