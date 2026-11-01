-- ============================================================================
-- VATSOM — Initial Catalogue & Site Content Seed Migration
-- Migration: 0002_seed_initial_data.sql
--
-- COMMERCIAL SAFETY POLICY:
-- All six initial seeded products are inserted as UNPUBLISHED DRAFTS
-- (`is_active = FALSE`, `stock_quantity = 0`, `"commercialVerified": false`).
-- No seeded product is published as a live commercial product until an
-- Administrator explicitly verifies its origin, quality specification,
-- and pricing in the Admin Portal and marks it active.
-- ============================================================================

BEGIN;

INSERT INTO products (
    legacy_numeric_id,
    slug,
    sku,
    name,
    division,
    category,
    description,
    long_description,
    price_paise,
    mrp_paise,
    volume_label,
    volume_ml,
    attributes,
    is_active,
    track_inventory,
    stock_quantity,
    max_order_quantity,
    sort_priority
) VALUES
(
    1,
    'cold-pressed-black-seed-oil',
    'VTS-TBL-001',
    'Cold-Pressed Black Seed Oil',
    'TABLE',
    'Edible & Therapeutic',
    'Sourced from pristine Egyptian fields, mechanically expressed without heat to safeguard high thymoquinone concentration.',
    'Harvested at dawn from mineral-rich alluvial soils in the Faiyum Oasis, our Nigella Sativa seeds are single-pressed in small granite batches below 27°C. Unfiltered and deeply aromatic, this obsidian-hued elixir preserves over 2.4% native thymoquinone and volatile essential lipids.',
    6800,
    7500,
    '250ml',
    250,
    '{"notes": "Nigella Sativa | Pungent, Spicy, Deep Herbal", "origin": "Faiyum Oasis, Egypt", "extraction": "Raw Granite Cold-Press", "ritual": "Drizzle over warm artisanal flatbreads, charred root vegetables, or take one measured teaspoon neat at dawn.", "badge": "Bestseller", "filterTag": "Edible", "commercialVerified": false}'::jsonb,
    FALSE,
    TRUE,
    0,
    5,
    10
),
(
    2,
    'wild-forest-oregano-aromatic-oil',
    'VTS-ATM-002',
    'Wild Forest Oregano Aromatic Oil',
    'ATMOSPHERE',
    'Aromatic Essence',
    'Wild-foraged from high-altitude Balkan cliffs. Possesses a deeply grounding and clarifying aromatic profile.',
    'Hand-gathered above 1,600 meters from sun-drenched limestone ridges, this wild mountain oregano undergoes slow copper-alembic hydro-distillation. Rich in carvacrol and wild forest terpenes, it clears the atmosphere and anchors meditative spaces.',
    8500,
    9500,
    '100ml',
    100,
    '{"notes": "Origanum Vulgare | Herbaceous, Warm, Camphorous", "origin": "Dinaric Alps, Balkans", "extraction": "Copper-Alembic Distillation", "ritual": "Add 3–4 drops to a ceramic stone diffuser, or dilute in carrier oil for a warming chest and temple compress.", "badge": "Rare Harvest", "filterTag": "Aromatic", "commercialVerified": false}'::jsonb,
    FALSE,
    TRUE,
    0,
    5,
    20
),
(
    3,
    'tuscan-white-truffle-infused-olive-oil',
    'VTS-TBL-003',
    'Tuscan White Truffle Infused Olive Oil',
    'TABLE',
    'Gastronomic Edible',
    'Freshly shaved white truffles macerated in early-harvest organic extra virgin olive oil from San Miniato.',
    'Foraged beneath ancient oak and hazelnut roots in San Miniato, real Alba & Tuscan white truffles are cold-macerated directly into first-day Moraiolo extra virgin olive oil. Free of synthetic aromas, delivering an unmistakable, hauntingly earthy finish.',
    12000,
    13500,
    '200ml',
    200,
    '{"notes": "Tuber Magnatum | Earthy, Musky, Luxurious", "origin": "San Miniato, Tuscany", "extraction": "Cold Botanical Maceration", "ritual": "Anoint handmade tagliolini, aged Parmigiano-Reggiano risottos, or poached farm eggs immediately before serving.", "badge": "Chef''s Choice", "filterTag": "Edible", "commercialVerified": false}'::jsonb,
    FALSE,
    TRUE,
    0,
    4,
    30
),
(
    4,
    'moroccan-argan-culinary-skin-oil',
    'VTS-TBL-004',
    'Moroccan Argan Culinary & Skin Oil',
    'TABLE',
    'Dual-Purpose Elixir',
    'Hand-cracked by women''s cooperatives in the Sous Valley. Lightly toasted for complex culinary finishing or deep nourishment.',
    'Collected from UNESCO-protected biosphere argan forests, each nut is cracked between two river stones by master artisans. Gently rested to develop a silk-textured, golden hazelnut bouquet brimming with tocopherols and squalene.',
    9500,
    10500,
    '250ml',
    250,
    '{"notes": "Argania Spinosa | Roasted Nut, Warm Amber", "origin": "Sous Valley, Morocco", "extraction": "Artisanal Stone-Cracked Press", "ritual": "Finish grilled sea bass and couscous, or warm two drops between palms to seal moisture into damp skin.", "badge": "Organic", "filterTag": "Edible", "commercialVerified": false}'::jsonb,
    FALSE,
    TRUE,
    0,
    5,
    40
),
(
    5,
    'himalayan-rhododendron-aromatic-oil',
    'VTS-ATM-005',
    'Himalayan Rhododendron Aromatic Oil',
    'ATMOSPHERE',
    'Aromatic Essence',
    'Distilled from crimson blossoms gathered in restricted high-altitude Himalayan wildlife sanctuaries.',
    'During the brief spring thaw at 3,200 meters, fallen rhododendron petals are collected by local mountain stewards and steam-distilled using glacial spring water. Opens with crisp alpine nectar before settling into a balsamic cedarwood undertone.',
    11000,
    12500,
    '100ml',
    100,
    '{"notes": "Rhododendron Arboreum | Floral, Sweet, Resinous", "origin": "Langtang Valley, Himalayas", "extraction": "Glacial Spring Hydro-Distillation", "ritual": "Diffuse during evening wind-down or anoint pulse points for a serene, high-altitude botanical sanctuary.", "badge": "Limited Batch", "filterTag": "Aromatic", "commercialVerified": false}'::jsonb,
    FALSE,
    TRUE,
    0,
    4,
    50
),
(
    6,
    'sicilian-lemon-zest-infused-oil',
    'VTS-TBL-006',
    'Sicilian Lemon Zest Infused Oil',
    'TABLE',
    'Gastronomic Edible',
    'Cold-pressed simultaneously with organic Syracuse lemon peels to capture immediate, electric citrus notes.',
    'Using the traditional ''Olio Agrumato'' method, whole organic Femminello Siracusano lemons are crushed together with green Nocellara del Belice olives in the same granite mill, locking volatile citrus essential oils directly into the golden lipid matrix.',
    6000,
    6800,
    '250ml',
    250,
    '{"notes": "Citrus Limon | Vibrant, Zesty, Bright Zest", "origin": "Syracuse, Sicily", "extraction": "Simultaneous Granite Agrumato", "ritual": "Drizzle over crudo, burrata, steamed asparagus, or substitute into olive-oil citrus cakes.", "badge": "Seasonal", "filterTag": "Edible", "commercialVerified": false}'::jsonb,
    FALSE,
    TRUE,
    0,
    6,
    60
)
ON CONFLICT (slug) DO UPDATE SET
    is_active = FALSE,
    stock_quantity = 0
WHERE (products.attributes->>'commercialVerified')::boolean IS NOT TRUE;

INSERT INTO site_content (
    key,
    hero_banner,
    hero_title_html,
    hero_subtitle,
    manifesto_title,
    manifesto_p1,
    manifesto_p2
) VALUES (
    'primary',
    'Purified Botanical & Culinary Extracts',
    'SACRED <span class="italic font-serif font-light text-accentGold">OILS</span> OF DISTINCTION',
    'Hand-harvested edible elixirs and rare aromatic essences. Pressed in nocturnal silence, inscribed on ribbed parchment, and sealed in obsidian glass.',
    'Where Ancient Extraction Meets Modern Precision',
    'Vatsom was born from an obsession with purity. In an era of mass-industrialized refining, our laboratory-studios adhere strictly to ancestral stone-grinding and pristine cold-expeller techniques.',
    'Every drop of our culinary or aromatic essence tells a silent story of soil, rain, and careful hand-harvesting.'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO schema_migrations (version, description)
VALUES ('0002_seed_initial_data', 'Seed initial VATSOM 6 elixirs and default site content')
ON CONFLICT (version) DO NOTHING;

COMMIT;

