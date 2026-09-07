-- ============================================================
-- 073 · LO QUE SE DEBE Y TODAVÍA NO SE PAGA (D1)
--
-- El devengo es la diferencia entre una contabilidad y un registro de caja. Un
-- despacho que paga el aguinaldo en diciembre y no lo provisiona durante el
-- año publica once meses de utilidad inflada y un diciembre catastrófico, y
-- ninguno de los doce estados es firmable.
--
-- Esta migración pone los CIMIENTOS que el devengo necesita y que el esquema
-- no tenía. El motor va aparte.
--
-- ── 1. LA CATEGORÍA QUE FALTABA EN EL ESTADO DE SITUACIÓN ───────────────
--
-- `fs_category` admitía once valores y ninguno era el ORI —Otros Resultados
-- Integrales—, que la NIF B-3 exige como componente propio del capital
-- contable: la revaluación de propiedades, el resultado por conversión de
-- operaciones extranjeras y las remediciones de beneficios a empleados NO
-- pasan por el resultado del ejercicio, y meterlos en `equity` a secas los
-- confunde con las aportaciones de los socios.
--
-- No es una bifurcación de criterio y por eso no va al panel: es una categoría
-- que la norma nombra y el CHECK no admitía.
-- ============================================================

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_fs_category_check;

ALTER TABLE accounts ADD CONSTRAINT accounts_fs_category_check
  CHECK (fs_category IN (
    'current_assets', 'non_current_assets',
    'current_liabilities', 'long_term_liabilities',
    'equity', 'ori',
    'revenue', 'cogs',
    'operating_expenses', 'other_income', 'other_expenses', 'tax'
  ));

COMMENT ON COLUMN accounts.fs_category IS
  'Renglón del estado financiero en que la cuenta se presenta. `ori` (NIF B-3) es el capital que NO pasó por el resultado del ejercicio: revaluación, conversión de operaciones extranjeras y remediciones de beneficios a empleados. Separarlo de `equity` es lo que impide confundir una revaluación con una aportación de socios.';
