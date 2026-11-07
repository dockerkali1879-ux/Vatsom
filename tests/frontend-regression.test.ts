import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

describe('VATSOM Frontend Preservation & Regression Suite', () => {
  const storefrontHtml = readFileSync(join(ROOT, 'vatsom_premium_oils.html'), 'utf8');
  const adminHtml = readFileSync(join(ROOT, 'admin-portal.html'), 'utf8');
  const paperCrumpleJs = readFileSync(join(ROOT, 'paper_crumple_effect.js'), 'utf8');

  it('1. Preserves obsidian & ribbed parchment design system, colour palette, and typography', () => {
    expect(storefrontHtml).toContain("paper: '#f4f1ea'");
    expect(storefrontHtml).toContain("charcoal: '#121212'");
    expect(storefrontHtml).toContain("accentGold: '#c5a059'");
    expect(storefrontHtml).toContain('Cinzel');
    expect(storefrontHtml).toContain('Playfair+Display');
    expect(storefrontHtml).toContain('Plus+Jakarta+Sans');
    expect(storefrontHtml).toContain('.ribbed-paper');
    expect(storefrontHtml).toContain('.paper-stack');
    expect(storefrontHtml).toContain('.paper-card');
  });

  it('2. Preserves Origami V emblem branding and header alignment', () => {
    expect(storefrontHtml).toContain('vatsom_logo.png');
    expect(storefrontHtml).toContain('origami-logo-wrap');
    expect(storefrontHtml).toContain('origami-flap-left');
    expect(storefrontHtml).toContain('origami-flap-right');
    expect(adminHtml).toContain('vatsom_logo.png');
    expect(adminHtml).toContain('origami-logo-wrap');
  });

  it('3. Preserves Three.js r128 <PaperCrumple /> physics engine and cart removal animation', () => {
    expect(paperCrumpleJs).toContain('buildAndBakeCrumplePath');
    expect(paperCrumpleJs).toContain('crumpleAndFall');
    expect(paperCrumpleJs).toContain('window.PaperCrumpleEffect');
    expect(storefrontHtml).toContain('paper_crumple_effect.js');
    expect(storefrontHtml).toContain('PaperCrumpleEffect');
  });

  it('4. Preserves Lenis inertial scrolling and 3D paper tilt interactions', () => {
    expect(storefrontHtml).toContain('lenis.min.js');
    expect(storefrontHtml).toContain('new Lenis(');
    expect(storefrontHtml).toContain('bindPaperCardPhysics');
  });

  it('5. Preserves product filters (All, Edible, Aromatic), 3-image gallery modal, and cart controls', () => {
    expect(storefrontHtml).toContain('data-filter="all"');
    expect(storefrontHtml).toContain('data-filter="Edible"');
    expect(storefrontHtml).toContain('data-filter="Aromatic"');
    expect(storefrontHtml).toContain('id="product-modal"');
    expect(storefrontHtml).toContain('id="modal-gallery-thumbs"');
    expect(storefrontHtml).toContain('switchModalPlate');
    expect(storefrontHtml).toContain('id="cart-drawer"');
    expect(storefrontHtml).toContain('updateQuantity');
    expect(storefrontHtml).toContain('addToCart');
  });

  it('6. Connects storefront to /api/v1/* backend endpoints with COD-only checkout, Google Auth, and Turnstile', () => {
    expect(storefrontHtml).toContain('/api/v1');
    expect(storefrontHtml).toContain('/products');
    expect(storefrontHtml).toContain('/orders');
    expect(storefrontHtml).toContain('/auth/google');
    expect(storefrontHtml).toContain('id="patron-modal"');
    expect(storefrontHtml).toContain('id="cod-checkout-form"');
    expect(storefrontHtml).toContain('CASH ON DELIVERY (COD) ONLY');
    expect(storefrontHtml).toContain('idempotencyKey');
    expect(storefrontHtml).toContain('X-CSRF-Token');
  });

  it('7. Preserves admin portal views and connects them to authenticated /api/v1/admin/* routes with WebP compression', () => {
    expect(adminHtml).toContain('/api/v1');
    expect(adminHtml).toContain('id="admin-auth-gate"');
    expect(adminHtml).toContain('id="orders-section"');
    expect(adminHtml).toContain('id="products-section"');
    expect(adminHtml).toContain('id="content-section"');
    expect(adminHtml).toContain('id="tracking-modal"');
    expect(adminHtml).toContain('image/webp');
    expect(adminHtml).toContain('/admin/orders');
    expect(adminHtml).toContain('/admin/products');
    expect(adminHtml).toContain('/admin/site-content');
  });

  it('8. Ensures ./public static asset directory only exposes safe frontend assets and never source code or migrations', () => {
    const publicDir = join(ROOT, 'public');
    expect(existsSync(publicDir)).toBe(true);
    const files = readdirSync(publicDir).sort();
    expect(files).toEqual([
      'Pratham_Vatsa_Resume.pdf',
      'admin-portal.html',
      'index.html',
      'paper_crumple_effect.js',
      'portfolio.html',
      'pratham_hero.jpg',
      'pratham_portrait_crop.jpg',
      'vatsom_logo.png',
      'vatsom_premium_oils.html',
    ]);
  });

  it('9. Guards against negative IDs and unquoted hyphenated UUID subtraction in cart, modal, and PaperCrumple engine', () => {
    expect(storefrontHtml).toContain('function isValidProductIdentifier(id)');
    expect(storefrontHtml).toContain("onclick=\"openProductModal('${safeId}')\"");
    expect(storefrontHtml).toContain("addToCart('${safeId}')");
    expect(storefrontHtml).toContain("updateQuantity('${safeItemId}', -1)");
    expect(storefrontHtml).toContain("removeItem('${safeItemId}')");
    expect(paperCrumpleJs).toContain('Math.abs(Math.trunc(rawId))');
  });

  it('10. Enforces unpublished draft state on seeded SQL products and least-privilege DB role separation', () => {
    const mig1 = readFileSync(join(ROOT, 'DATABASE_MIGRATIONS/0001_initial_schema.sql'), 'utf8');
    const mig2 = readFileSync(join(ROOT, 'DATABASE_MIGRATIONS/0002_seed_initial_data.sql'), 'utf8');
    const mig3 = readFileSync(join(ROOT, 'DATABASE_MIGRATIONS/0003_bootstrap_admin.sql'), 'utf8');

    expect(mig1).toContain('is_active BOOLEAN NOT NULL DEFAULT FALSE');
    expect(mig1).toContain('stock_restored BOOLEAN NOT NULL DEFAULT FALSE');

    // No seeded product in 0002_seed_initial_data.sql may have is_active = TRUE
    expect(mig2).toContain('"commercialVerified": false');
    expect(mig2).not.toMatch(/\bTRUE,\s*\r?\n\s*TRUE,\s*\r?\n\s*(45|30|25|40|20|50)/);

    // 0003_bootstrap_admin.sql defines vatsom_migrator and vatsom_app_runtime with scoped DML privileges
    expect(mig3).toContain('CREATE ROLE vatsom_migrator');
    expect(mig3).toContain('CREATE ROLE vatsom_app_runtime');
    expect(mig3).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  });
});
