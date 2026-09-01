-- ============================================================
-- 049: la nómina deja de cargarse a «Devoluciones sobre Compras»
--
-- Cuatro semillas escriben en el catálogo de la misma entidad y las que corren
-- después se guardan de pisar a la anterior COMPARANDO CÓDIGOS. El catálogo de
-- nómina pedía seis números que otra semilla ya había declarado con otro
-- significado, así que no creaba sus cuentas: heredaba las ajenas.
--
-- En toda entidad sembrada antes de este arreglo:
--   wages_expense       → 5200 «Devoluciones y Descuentos sobre Compras»
--   imss_payable        → 2150 «Anticipos de Clientes»
--   infonavit_payable   → 2160 «Sueldos por Pagar»
--   garnishment_payable → 2170 «IMSS por Pagar»
--   benefits_payable    → 2180 «IEPS por Pagar»
-- y lo mismo, con los nombres en inglés, en las entidades de EE. UU., porque
-- `ensureEntityAccounting` siembra el catálogo base mexicano sin mirar el país.
--
-- ESTA MIGRACIÓN REPARA EL MAPEO, NO LA HISTORIA. Es una decisión, no un
-- olvido: reclasificar lo ya posteado es un acto contable con fecha, importe y
-- quién lo aprueba, y sobre un periodo que puede estar cerrado y sellado. Una
-- migración no tiene ninguna de esas tres cosas, y el mayor de esta casa es
-- inviolable a propósito (041). Así que a partir de aquí las corridas de
-- nómina postean a la cuenta correcta, y lo ya posteado se queda donde está,
-- visible, para que alguien lo reclasifique con una póliza.
--
-- Para saber si a una entidad le tocó, esta consulta lista lo contaminado:
--
--   SELECT a.entity_id, a.code, a.name, COUNT(*) AS renglones
--     FROM journal_entry_lines jel
--     JOIN accounts a ON a.id = jel.account_id
--    WHERE a.code IN ('5200','2150','2160','2170','2180')
--    GROUP BY a.entity_id, a.code, a.name;
--
-- LA SIEMBRA POR INQUILINO NO ES ADORNO. `accounts` y
-- `payroll_account_mapping` están bajo FORCE ROW LEVEL SECURITY, y esta
-- migración corre como dueño del esquema y SIN contexto de inquilino: un
-- UPDATE aquí afuera del bucle lee CERO filas y repara CERO entidades sin
-- decir nada. Es exactamente lo que le pasó a la 025 y por lo que existió la
-- 026. El bucle sobre `tenants` —excluida de RLS— es lo que da el contexto.
-- ============================================================

-- El opt-in: migrate.ts corre la sesión con row_security=off, que convierte el
-- filtrado silencioso en un 42501 en vez de en una reparación de cero filas.
-- Este bucle SÍ maneja la RLS a propósito —fija el GUC por inquilino—, así que
-- lo declara. Sin esta línea, contra el piso, la migración muere en el primer
-- catch-up de una base rezagada. SET LOCAL muere con la transacción que
-- migrate.ts abre alrededor de este archivo.
SET LOCAL row_security = on;

DO $reparacion$
DECLARE
  t       record;
  e       record;
  nueva   record;
  arreglo record;
  autor   uuid;
  destino uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    -- Sólo entidades con mapeo de nómina: una entidad que nunca lo sembró no
    -- tiene nada que reparar y no se le inventa catálogo.
    FOR e IN
      SELECT le.id,
             CASE WHEN le.incorporation_country = 'USA' THEN 'USA' ELSE 'MX' END AS pais
        FROM legal_entities le
       WHERE EXISTS (SELECT 1 FROM payroll_account_mapping m WHERE m.entity_id = le.id)
    LOOP
      -- accounts.created_by es NOT NULL y esta migración no tiene un usuario
      -- propio: hereda el de una cuenta que la entidad ya tiene, que es quien
      -- sembró el catálogo. Sin cuentas no hay a quién atribuirlo ni qué
      -- reparar.
      SELECT created_by INTO autor FROM accounts WHERE entity_id = e.id LIMIT 1;
      CONTINUE WHEN autor IS NULL;

      -- ── 1. La cuenta de cuotas patronales sólo cambia de número ──
      -- 5210 se creó bien (ningún otro catálogo lo reclamaba) y su nombre es
      -- el correcto; lo que cambió es que la nómina se muda a la banda 6xxx de
      -- gastos. Se renumera EN SU SITIO, no se crea otra: el account_id no se
      -- toca, así que los asientos ya posteados siguen colgando de su cuenta.
      -- Se exige que el nombre calce y que el número destino esté libre; si un
      -- despacho ya tenía algo en 6115/6155, no se le pisa y el mapeo se queda
      -- en 5210, que sigue siendo la cuenta correcta aunque con el número viejo.
      UPDATE accounts a
         SET code = CASE WHEN e.pais = 'USA' THEN '6155' ELSE '6115' END,
             updated_at = NOW(),
             updated_by = autor
       WHERE a.entity_id = e.id
         AND a.code = '5210'
         AND a.name = CASE WHEN e.pais = 'USA'
                           THEN 'Employer Payroll Taxes'
                           ELSE 'Cuotas Patronales IMSS e INFONAVIT' END
         AND NOT EXISTS (
               SELECT 1 FROM accounts libre
                WHERE libre.entity_id = e.id
                  AND libre.code = CASE WHEN e.pais = 'USA' THEN '6155' ELSE '6115' END);

      -- ── 2. Las cuentas que la colisión impidió crear ──
      FOR nueva IN
        SELECT * FROM (VALUES
          ('MX',  '2165', 'Otras Retenciones de Nómina',        'liability', 'credit', 'current_liabilities',
                  'Pensiones alimenticias, préstamos y descuentos posteriores al impuesto.'),
          ('MX',  '2175', 'INFONAVIT por Pagar',                'liability', 'credit', 'current_liabilities',
                  'Aportaciones y amortizaciones de crédito, bimestrales.'),
          ('MX',  '2185', 'Prestaciones por Pagar',             'liability', 'credit', 'current_liabilities',
                  'Deducciones anteriores al impuesto retenidas a favor de un tercero.'),
          ('MX',  '6110', 'Sueldos y Salarios',                 'expense',   'debit',  'operating_expenses',
                  'Percepciones brutas del personal, antes de retenciones.'),
          ('MX',  '6115', 'Cuotas Patronales IMSS e INFONAVIT', 'expense',   'debit',  'operating_expenses',
                  'Aportaciones que paga el patrón, separadas del sueldo.'),
          ('USA', '2155', 'Federal Income Tax Withheld',        'liability', 'credit', 'current_liabilities',
                  'FIT withheld from employees, until deposited.'),
          ('USA', '2156', 'Garnishments Payable',               'liability', 'credit', 'current_liabilities',
                  'Post-tax deductions owed to a third party.'),
          ('USA', '2157', 'Benefits Payable',                   'liability', 'credit', 'current_liabilities',
                  'Pre-tax deductions owed to a benefits provider.'),
          ('USA', '6150', 'Salaries and Wages',                 'expense',   'debit',  'operating_expenses',
                  'Gross compensation before withholding.'),
          ('USA', '6155', 'Employer Payroll Taxes',             'expense',   'debit',  'operating_expenses',
                  'Employer FICA, FUTA and SUTA.')
        ) AS v(pais, code, name, tipo, saldo, fs, descr)
        WHERE v.pais = e.pais
      LOOP
        -- ON CONFLICT: la 6110 mexicana suele existir ya (viene del catálogo
        -- base), y la 6115/6155 puede haberla dejado el paso 1.
        INSERT INTO accounts (code, name, account_type, normal_balance,
                              fs_category, description, entity_id, created_by)
        VALUES (nueva.code, nueva.name, nueva.tipo, nueva.saldo,
                nueva.fs, nueva.descr, e.id, autor)
        ON CONFLICT (code, entity_id) DO NOTHING;
      END LOOP;

      -- ── 3. Los buckets que apuntan a la cuenta ajena ──
      -- Se re-apunta SÓLO si la cuenta actual es exactamente la víctima de la
      -- colisión: mismo código Y mismo nombre. Un despacho que ya lo hubiera
      -- corregido a mano, o que hubiera elegido su propia cuenta, no se toca —
      -- es la misma promesa que las semillas ya hacen de no pisar una decisión
      -- humana.
      FOR arreglo IN
        SELECT * FROM (VALUES
          ('MX',  'wages_expense',       '5200', 'Devoluciones y Descuentos sobre Compras', '6110'),
          ('MX',  'imss_payable',        '2150', 'Anticipos de Clientes',                   '2170'),
          ('MX',  'infonavit_payable',   '2160', 'Sueldos por Pagar',                       '2175'),
          ('MX',  'garnishment_payable', '2170', 'IMSS por Pagar',                          '2165'),
          ('MX',  'benefits_payable',    '2180', 'IEPS por Pagar',                          '2185'),
          ('USA', 'wages_expense',       '5200', 'Devoluciones y Descuentos sobre Compras', '6150'),
          ('USA', 'fit_payable',         '2150', 'Anticipos de Clientes',                   '2155'),
          ('USA', 'garnishment_payable', '2170', 'IMSS por Pagar',                          '2156'),
          ('USA', 'benefits_payable',    '2180', 'IEPS por Pagar',                          '2157')
        ) AS v(pais, bucket, code_malo, name_malo, code_bueno)
        WHERE v.pais = e.pais
      LOOP
        SELECT id INTO destino
          FROM accounts
         WHERE entity_id = e.id AND code = arreglo.code_bueno;
        CONTINUE WHEN destino IS NULL;

        UPDATE payroll_account_mapping m
           SET account_id = destino
          FROM accounts mala
         WHERE m.entity_id = e.id
           AND m.bucket = arreglo.bucket
           AND mala.id = m.account_id
           AND mala.code = arreglo.code_malo
           AND mala.name = arreglo.name_malo;
      END LOOP;
    END LOOP;
  END LOOP;

  PERFORM set_config('app.current_tenant', '', true);
END
$reparacion$;
