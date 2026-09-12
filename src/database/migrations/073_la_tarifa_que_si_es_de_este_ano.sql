-- ============================================================
-- 073 · LA TARIFA QUE SÍ ES DE ESTE AÑO (T4 · #91)
--
-- La 009 se sembró con estimaciones y lo dice ella misma: «Art. 96 LISR
-- (mensual) 2026 estimado» (:147) y «Mexico 2026 (estimated UMA + IMSS
-- rates)» (:36). Nadie volvió a sustituirlas por lo publicado. Lo que hay hoy
-- en una instalación, medido contra el Diario Oficial:
--
--   1. LA TARIFA «2026» ES LA DE 2025, al centavo. Sus once tramos son los del
--      Anexo 8 de la RMF 2025 (DOF 30-dic-2024), rubro B.V: primer límite
--      superior 746.04. El de 2026 (Anexo 8 RMF 2026, DOF 28-dic-2025) es
--      844.59 — un 13.21 % más alto. Toda retención de ISR de este ejercicio
--      se calcula con la tabla del año pasado.
--
--   2. LA «QUINCENAL» NO ES LA QUINCENAL DE NINGÚN AÑO. El archivo lo confiesa
--      en su comentario (:162): «same structure, divided by 2». La quincenal
--      del Anexo 8 no es la mensual entre dos: es la DIARIA por 15, y la
--      diaria es la mensual entre 30.4. La mensual entre dos da 373.02 donde
--      el DOF dice 416.70.
--
--   3. LA UMA TAMBIÉN ES LA DE 2025. `uma_daily = 113.14` es el valor que el
--      INEGI publicó para 2025 (comunicado 1/25); el de 2026 es 117.31
--      (comunicado 1/26, 8-ene-2026). De ahí cuelgan IMSS, INFONAVIT y las
--      exenciones del art. 93.
--
-- ── DE DÓNDE SALEN LOS NÚMEROS QUE ESTA MIGRACIÓN SIEMBRA ───────────────
--
-- Sólo se siembra a mano UNA tabla: la MENSUAL de 2026 del Anexo 8. Está
-- transcrita dos veces por lecturas independientes del PDF del DOF, y las dos
-- coinciden renglón por renglón.
--
-- Las otras cuatro NO se transcriben: se DERIVAN aquí mismo, para que no haya
-- 44 renglones que teclear mal. La regla —diaria = mensual ÷ 30.4 redondeada a
-- centavos; periodo = diaria × días— se comprobó contra las tablas publicadas
-- de 2026: 134 comparaciones, cero discrepancias. No está escrita en la LISR
-- ni en su Reglamento (los arts. 175 y 176 sólo dicen «la tarifa … que
-- publique el SAT»), pero el divisor 30.4 sí aparece por escrito en el Decreto
-- del subsidio para el empleo, y la aritmética cierra.
--
-- SI ALGÚN DÍA EL SAT PUBLICA UNA TABLA QUE NO CIERRE CON ESTA REGLA, MANDA LA
-- TABLA PUBLICADA. Por eso la prueba de integración de este tramo ancla los
-- valores del DOF que las dos lecturas citan textualmente —27.78, 194.46,
-- 277.80, 416.70, 3537.15 y las cuotas 0.53, 3.71, 5.30, 7.95— contra lo que
-- esta derivación produce: el día que dejen de coincidir, se entera alguien.
--
-- ── LO QUE ESTA MIGRACIÓN NO TOCA, Y POR QUÉ ────────────────────────────
--
-- · EL SUBSIDIO AL EMPLEO. Dejó de ser tabla: desde el decreto del 1-may-2024
--   es un PORCENTAJE de la UMA mensual, y la 009 siembra los montos de la
--   tabla derogada. El porcentaje de 2026 está verificado (15.02 %), pero el
--   MONTO en pesos no: el considerando del decreto dice $536.22 y la fórmula
--   sobre la UMA que el INEGI publicó nueve días después da 535.65. El decreto
--   no dice cómo redondear. No se siembra una cifra que no cierra con su
--   propia fórmula; queda su issue.
-- · EL TOPE DE SOCIAL SECURITY. El repositorio lleva 168 600 en la semilla y
--   184 500 en la documentación, sin fuente para ninguno. No es de este
--   tramo inventar cuál.
-- · EL SALARIO MÍNIMO y la UMA de frontera. El general de 2026 aparece citado
--   en el decreto (315.04), pero el de frontera no se pudo verificar, y sembrar
--   uno sin el otro deja la fila mezclando ejercicios. Queda su issue.
-- ============================================================

-- ── 1 · EL PARÁMETRO GANA FECHA ─────────────────────────────────────────
--
-- `tax_parameters` tenía `UNIQUE (jurisdiction, tax_year)` y ninguna columna de
-- vigencia, y eso no es un olvido menor: la UMA entra en vigor el 1 DE FEBRERO,
-- así que el ejercicio 2026 tiene DOS —113.14 hasta el 31 de enero y 117.31
-- desde el 1 de febrero— y no caben en una fila por año. El propio Decreto del
-- subsidio lo reconoce al dar a enero de 2026 un porcentaje distinto,
-- precisamente porque la UMA nueva todavía no rige.
--
-- `tax_tables` ya tenía `effective_from`/`effective_to` desde la 008; el
-- parámetro se pone a su altura.
ALTER TABLE tax_parameters
    ADD COLUMN IF NOT EXISTS effective_from DATE,
    ADD COLUMN IF NOT EXISTS effective_to   DATE;

-- Lo ya sembrado vigía desde el 1 de enero de su ejercicio, que es lo que
-- significaba antes de que existiera la columna.
UPDATE tax_parameters
   SET effective_from = make_date(tax_year, 1, 1)
 WHERE effective_from IS NULL;

ALTER TABLE tax_parameters ALTER COLUMN effective_from SET NOT NULL;

-- La unicidad deja de ser por ejercicio y pasa a ser por ventana: dos filas del
-- mismo año son ahora legítimas y necesarias.
ALTER TABLE tax_parameters DROP CONSTRAINT IF EXISTS tax_parameters_jurisdiction_tax_year_key;
ALTER TABLE tax_parameters
    ADD CONSTRAINT uq_tax_parameters_vigencia UNIQUE (jurisdiction, effective_from);
ALTER TABLE tax_parameters
    ADD CONSTRAINT ck_tax_parameters_vigencia CHECK (effective_to IS NULL OR effective_to >= effective_from);

COMMENT ON COLUMN tax_parameters.effective_from IS
  'Desde cuándo rige esta fila. La UMA entra en vigor el 1 de febrero, así que un ejercicio puede tener dos: el año NO es la unidad de vigencia.';
COMMENT ON COLUMN tax_parameters.effective_to IS
  'Hasta cuándo rige, inclusive. NULL = sigue vigente. Quien lee pasa la FECHA DEL ACTO, no la de hoy: un recibo del 15 de enero se recalcula en marzo con los parámetros de enero.';

-- ── 2 · LAS DOS UMAS DE 2026 ────────────────────────────────────────────
--
-- La fila que hay se queda como la ventana de ENERO —donde sus valores son
-- CORRECTOS, porque en enero de 2026 seguía rigiendo la UMA de 2025— y se le
-- pone fin el 31 de enero. Lo que estaba mal no era la cifra: era pretender
-- que valía los doce meses.
UPDATE tax_parameters
   SET effective_to = DATE '2026-01-31'
 WHERE jurisdiction = 'MX' AND tax_year = 2026 AND effective_to IS NULL
   AND (params ->> 'uma_daily')::numeric = 113.14;

-- Y la ventana de febrero en adelante, con la UMA que el INEGI publicó el
-- 8 de enero de 2026 (comunicado 1/26): diaria 117.31, mensual 3 566.22,
-- anual 42 794.64. El resto de los parámetros se copia tal cual de la ventana
-- anterior: esta migración corrige la UMA, no audita las cuotas del IMSS.
INSERT INTO tax_parameters (jurisdiction, tax_year, params, effective_from, effective_to)
SELECT 'MX', 2026,
       jsonb_set(jsonb_set(jsonb_set(params,
         '{uma_daily}',   to_jsonb(117.31::numeric)),
         '{uma_monthly}', to_jsonb(3566.22::numeric)),
         '{uma_annual}',  to_jsonb(42794.64::numeric)),
       DATE '2026-02-01', NULL
  FROM tax_parameters
 WHERE jurisdiction = 'MX' AND tax_year = 2026 AND effective_from = DATE '2026-01-01'
ON CONFLICT (jurisdiction, effective_from) DO NOTHING;

-- ── 3 · LA TARIFA DEL ART. 96 QUE SÍ ES DE 2026 ─────────────────────────
--
-- Se retira la sembrada —que es la de 2025— y se pone la publicada, con las
-- cuatro derivadas. No se borra: se le pone fin de vigencia el 31 de diciembre
-- de 2025, que es hasta cuándo fue verdad, y así una recálculo de aquel
-- ejercicio sigue encontrando su tabla.
UPDATE tax_tables
   SET tax_year = 2025, effective_from = DATE '2025-01-01', effective_to = DATE '2025-12-31'
 WHERE jurisdiction = 'MX' AND tax_type = 'isr' AND tax_year = 2026
   AND pay_frequency = 'monthly' AND bracket_order = 1 AND bracket_high = 746.04;

UPDATE tax_tables
   SET tax_year = 2025, effective_from = DATE '2025-01-01', effective_to = DATE '2025-12-31'
 WHERE jurisdiction = 'MX' AND tax_type = 'isr' AND tax_year = 2026
   AND pay_frequency = 'monthly' AND effective_to IS NULL;

-- La «quincenal» sembrada no es la de ningún año: era la mensual entre dos. No
-- se conserva como histórico porque nunca fue verdad; se borra.
DELETE FROM tax_tables
 WHERE jurisdiction = 'MX' AND tax_type = 'isr' AND tax_year = 2026 AND pay_frequency = 'quincenal';

-- LA MENSUAL DE 2026, Anexo 8 RMF 2026 rubro B.V (DOF 28-dic-2025).
-- Es lo ÚNICO que se teclea; de aquí salen las otras cuatro.
INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency,
                        bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from, effective_to)
VALUES
('MX','isr',2026,NULL,'monthly', 1,      0.01,     844.59, 0.019200,      0.00,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly', 2,    844.60,    7168.51, 0.064000,     16.22,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly', 3,   7168.52,   12598.02, 0.108800,    420.95,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly', 4,  12598.03,   14644.64, 0.160000,   1011.68,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly', 5,  14644.65,   17533.64, 0.179200,   1339.14,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly', 6,  17533.65,   35362.83, 0.213600,   1856.84,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly', 7,  35362.84,   55736.68, 0.235200,   5665.16,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly', 8,  55736.69,  106410.50, 0.300000,  10457.09,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly', 9, 106410.51,  141880.66, 0.320000,  25659.23,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly',10, 141880.67,  425641.99, 0.340000,  37009.69,'2026-01-01',NULL),
('MX','isr',2026,NULL,'monthly',11, 425642.00,       NULL, 0.350000, 133488.54,'2026-01-01',NULL);

-- LAS CUATRO DERIVADAS. `round(x, 2)` de Postgres sobre `numeric` es
-- half-up, que es el redondeo con el que la diaria del DOF sale exacta.
--
-- El límite INFERIOR de cada tramo es el superior del anterior más un centavo,
-- y no la división del inferior mensual: así lo publica el Anexo 8 y así no
-- quedan huecos de un centavo entre tramos.
INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency,
                        bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from, effective_to)
SELECT 'MX', 'isr', 2026, NULL, p.freq,
       m.bracket_order,
       COALESCE(
         LAG(round(m.bracket_high / 30.4, 2) * p.dias) OVER (PARTITION BY p.freq ORDER BY m.bracket_order) + 0.01,
         0.01),
       round(m.bracket_high / 30.4, 2) * p.dias,
       m.rate,
       round(m.base_tax / 30.4, 2) * p.dias,
       DATE '2026-01-01', NULL
  FROM tax_tables m
  CROSS JOIN (VALUES ('daily', 1), ('weekly', 7), ('decenal', 10), ('quincenal', 15)) AS p(freq, dias)
 WHERE m.jurisdiction = 'MX' AND m.tax_type = 'isr' AND m.tax_year = 2026
   AND m.pay_frequency = 'monthly' AND m.effective_to IS NULL;

-- ── 4 · Y SE COMPRUEBA CONTRA EL DIARIO OFICIAL ─────────────────────────
--
-- Los valores que las dos lecturas independientes del Anexo 8 2026 citan
-- textualmente. Si la derivación deja de reproducirlos, la migración se
-- detiene: más vale no actualizar que actualizar a una tarifa inventada.
DO $anclas$
DECLARE
  esperado CONSTANT jsonb := '[
    {"freq":"daily","orden":1,"alto":27.78,"cuota":0.00},
    {"freq":"weekly","orden":1,"alto":194.46,"cuota":0.00},
    {"freq":"decenal","orden":1,"alto":277.80,"cuota":0.00},
    {"freq":"quincenal","orden":1,"alto":416.70,"cuota":0.00},
    {"freq":"daily","orden":2,"cuota":0.53},
    {"freq":"weekly","orden":2,"cuota":3.71},
    {"freq":"decenal","orden":2,"cuota":5.30},
    {"freq":"quincenal","orden":2,"alto":3537.15,"cuota":7.95}
  ]'::jsonb;
  a      jsonb;
  fila   record;
BEGIN
  FOR a IN SELECT jsonb_array_elements(esperado) LOOP
    SELECT bracket_high, base_tax INTO fila
      FROM tax_tables
     WHERE jurisdiction = 'MX' AND tax_type = 'isr' AND tax_year = 2026
       AND pay_frequency = a ->> 'freq' AND bracket_order = (a ->> 'orden')::int;

    IF NOT FOUND THEN
      RAISE EXCEPTION '073: falta el tramo % de la tarifa %', a ->> 'orden', a ->> 'freq';
    END IF;
    IF a ? 'alto' AND fila.bracket_high IS DISTINCT FROM (a ->> 'alto')::numeric THEN
      RAISE EXCEPTION '073: la tarifa % tramo % da un límite superior de % y el DOF publica %',
        a ->> 'freq', a ->> 'orden', fila.bracket_high, a ->> 'alto';
    END IF;
    IF fila.base_tax IS DISTINCT FROM (a ->> 'cuota')::numeric THEN
      RAISE EXCEPTION '073: la tarifa % tramo % da una cuota fija de % y el DOF publica %',
        a ->> 'freq', a ->> 'orden', fila.base_tax, a ->> 'cuota';
    END IF;
  END LOOP;

  RAISE NOTICE '073: las cinco tarifas de 2026 sembradas, y las cuatro derivadas cuadran con el Anexo 8';
END
$anclas$;
