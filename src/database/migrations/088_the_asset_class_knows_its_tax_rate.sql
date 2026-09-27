-- ============================================================
-- 088 · THE ASSET CLASS KNOWS ITS TAX RATE (ACT-1 · #322, MNE-001-020)
--
-- `asset_categories` (003) had one life column in YEARS and nowhere to say
-- which rate the income tax law allows for the class. So `base_depreciacion =
-- tasa_lisr` changed the method label and the `schedule_type`, but spread the
-- tax schedule over the same useful life as the book one: the fiscal answer
-- of the panel posted the book number.
--
-- The owner's decision (#322, 2026-09-26): the class stores the MAXIMUM rate
-- of LISR arts. 34/35 with its legal basis and the BOOK life in months; the
-- asset stores its own tax rate (equal to or below the maximum); the run posts
-- on the basis the panel names. The parallel, unposted tax calendar stays in
-- #112 (F07g).
--
-- CONTRACT: schema — four additive, nullable columns. NULL on existing rows
-- means "not known": an asset without `tax_rate` keeps depreciating on its
-- useful life under either basis, exactly as before this migration.
-- ============================================================

ALTER TABLE asset_categories
    ADD COLUMN IF NOT EXISTS max_tax_rate NUMERIC(7,4)
        CHECK (max_tax_rate > 0 AND max_tax_rate <= 1),
    ADD COLUMN IF NOT EXISTS legal_basis TEXT,
    ADD COLUMN IF NOT EXISTS default_useful_life_months INTEGER
        CHECK (default_useful_life_months > 0);

COMMENT ON COLUMN asset_categories.max_tax_rate IS
  'Maximum annual deduction rate of the class (LISR arts. 34/35), as a fraction: 0.3000 is 30 %. Copied from legal_parameters when the class is seeded; an asset may deduct slower, never faster.';
COMMENT ON COLUMN asset_categories.legal_basis IS
  'Article and fraction the maximum rate comes from, so it can be checked against the law.';
COMMENT ON COLUMN asset_categories.default_useful_life_months IS
  'Default BOOK useful life (NIF C-6) in months. Not derived from the tax rate at run time: 35 % gives 34.29 months and this column is an integer.';

ALTER TABLE fixed_assets
    ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(7,4)
        CHECK (tax_rate > 0 AND tax_rate <= 1);

COMMENT ON COLUMN fixed_assets.tax_rate IS
  'Annual tax depreciation rate of this asset, as a fraction, at most its class maximum. Read by the monthly run when base_depreciacion = tasa_lisr.';

-- WHY THE RATES GO THROUGH `legal_parameters` AND NOT A CONSTANT. The audited
-- report (docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-mx.md,
-- row «LISR 34 fr. I-XV») found them correct but hardcoded in
-- `CATALOGO_LISR`, and asked for a dated parameter. A migration and not only
-- the demo seeder, for the reason 082 gives: the integration suite and every
-- migrated-but-unseeded install would otherwise fail `never_loaded`.
--
-- The date is the day the current LISR came into force (DOF 11-12-2013, in
-- force 2014-01-01), the same one `legal-parameters-seed.ts` uses for its
-- other LISR rows. Idempotent through the unique key of 080.
INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'income_tax.depreciation_max_rate.buildings', '2014-01-01', '0.0500', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 34, fr. I, inciso b): 5 % for constructions other than historic monuments.'),
  ('MX', 'income_tax.depreciation_max_rate.office_furniture', '2014-01-01', '0.1000', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 34, fr. III: 10 % for office furniture and equipment.'),
  ('MX', 'income_tax.depreciation_max_rate.vehicles', '2014-01-01', '0.2500', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 34, fr. VI: 25 % for cars, buses, trucks, tractor-trailers, forklifts and trailers.'),
  ('MX', 'income_tax.depreciation_max_rate.computers', '2014-01-01', '0.3000', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 34, fr. VII: 30 % for personal computers, servers, printers, optical readers, digitizers and network hubs.'),
  ('MX', 'income_tax.depreciation_max_rate.dies_and_tools', '2014-01-01', '0.3500', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 34, fr. VIII: 35 % for dies, punches, moulds, matrices and tooling.'),
  ('MX', 'income_tax.depreciation_max_rate.machinery_other', '2014-01-01', '0.1000', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 35, fr. XIV: 10 % for machinery and equipment in activities not listed in the other fractions.')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
