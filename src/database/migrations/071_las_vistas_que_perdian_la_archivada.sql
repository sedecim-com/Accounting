-- ============================================================
-- 071 · LAS VISTAS QUE PERDÍAN LA CUENTA ARCHIVADA (T13 · #100)
--
-- Las dos vistas materializadas del área de informes filtran
-- `a.is_active = true`, así que una cuenta ARCHIVADA con movimiento posteado
-- desaparece de ellas. Eso las pone en contra de la regla que T13 instaura en
-- el servicio de informes: un informe enseña la cuenta que lleva algo EN EL
-- PERIODO DEL INFORME, y el estado de la cuenta HOY no borra el dinero de ayer.
--
-- ── POR QUÉ NO BASTABA ARREGLAR SÓLO EL SERVICIO ────────────────────────
--
-- `getReportingViewStatus` (materialized-view-service.ts) coteja el MAYOR
-- contra estas vistas para decir si están frescas. Ensanchar el mayor y dejar
-- las vistas filtrando deja los dos lados con criterios distintos: la deriva
-- sale permanente y `mnemosine report view show` pide para siempre un
-- «rebuild» que no arregla nada, porque no hay nada roto que arreglar.
-- Medido antes de esta migración, con una cuenta archivada con movimiento:
-- `drift = -10000.0000`, `stale = true`, y refrescar no lo mueve.
--
-- Las tres salidas posibles eran: filtrar también el mayor (que dejaría al
-- cotejo ciego JUSTO para la cuenta que este tramo viene a rescatar), dejar
-- los dos lados desalineados (el defecto), o alinear las vistas con la regla.
-- Es la tercera.
--
-- ── QUÉ NO CAMBIA ───────────────────────────────────────────────────────
--
-- Ni las columnas, ni los nombres, ni los índices, ni el régimen de refresco:
-- se conservan los cuatro índices —incluidos los ÚNICOS, que son lo que
-- permite `REFRESH ... CONCURRENTLY`— con sus mismos nombres. Lo único que se
-- retira es el predicado de catálogo.
--
-- Las vistas ganan filas: las de las cuentas archivadas. Para una cuenta
-- archivada que nunca recibió una línea, sus columnas son ceros —igual que
-- las de cualquier cuenta activa sin movimiento, que ya estaban ahí—.
--
-- ── POR QUÉ ESTA MIGRACIÓN LLEVA UN CAMBIO DE ROL ───────────────────────
--
-- Recrear una materializada NO es lo mismo que crearla la primera vez:
-- `CREATE MATERIALIZED VIEW` LA PUEBLA en el acto, corriendo su consulta
-- definitoria como quien la crea. Y quien corre las migraciones es
-- mnemosine_owner, que es NOBYPASSRLS y por tanto está SUJETO a
-- `FORCE ROW LEVEL SECURITY`. El corredor abre la sesión con
-- `SET row_security = off`, que no apaga la RLS: hace que Postgres LANCE en
-- cuanto una política fuera a aplicarse. Medido en una base actualizada
-- (políticas ya puestas), con la versión anterior de este archivo:
--
--   ERROR:  query would be affected by row-level security policy
--           for table "accounts"                                    (42501)
--   HINT:   To disable the policy for the table's owner,
--           use ALTER TABLE NO FORCE ROW LEVEL SECURITY.
--
-- Esa pista de Postgres es la peor salida posible: apagar el FORCE de las
-- cuatro tablas que la definición toca —accounts, fiscal_periods,
-- journal_entries, journal_entry_lines— es desarmar el aislamiento por
-- inquilino para arreglar un informe. Medido: quitarle el FORCE sólo a
-- `accounts` mueve el error a `fiscal_periods`, una por una.
--
-- La otra salida falsa es el `SET LOCAL row_security = on` que usan las
-- migraciones de DATOS. Con él la orden NO falla: TERMINA EN VERDE Y DEJA LA
-- VISTA VACÍA, porque sin GUC de inquilino las políticas evalúan a falso.
-- Medido sobre un banco con dos despachos y seis cuentas:
--   · `row_security = on` sin inquilino ............ 0 filas
--   · `row_security = on` con UN inquilino ......... 3 filas, 1 entidad
--   · `SET LOCAL ROLE mnemosine_refresher` ......... 6 filas, 2 entidades
-- Una materializada tiene por contrato que ver el CLÚSTER ENTERO —lo aísla el
-- GRANT y el `entity_id` de cada consulta, no la política; una 'm' ni siquiera
-- admite CREATE POLICY—, y para eso existe ya `mnemosine_refresher`
-- (NOLOGIN, BYPASSRLS, scripts/provision-roles.sql:52), que es a quien
-- rls-policies.sql le entrega estas vistas al final de CADA corrida. Crear la
-- vista con el traje de su dueño de régimen es la única de las tres que
-- reconstruye el dato COMPLETO.
-- ============================================================

-- ── LOS PERMISOS SE GUARDAN ANTES DE TIRARLAS ───────────────────────────
--
-- `DROP` se lleva la ACL, y NADA la repone: el bucle de privilegios de
-- rls-policies.sql sólo recorre `relkind IN ('r','p','S')` —tablas, particiones
-- y secuencias—, así que las vistas materializadas (relkind 'm') quedan fuera.
-- En una base actualizada esas vistas llevan hoy `mnemosine_app=arwd` y
-- `mnemosine_owner=r`; sin este bloque, recrearlas dejaría a la aplicación sin
-- lectura y el fallo aparecería mucho después, lejos de esta migración.
--
-- Y ahora hace falta MÁS que antes: la vista nueva ya no la crea
-- mnemosine_owner, así que tampoco la alcanzan sus privilegios por defecto
-- (`ALTER DEFAULT PRIVILEGES FOR ROLE mnemosine_owner`, que sólo cubren lo que
-- crea ESE rol). Este censo es lo único que le devuelve la lectura a la app.
--
-- La tabla temporal la crea el rol del corredor y la lee el rol del corredor:
-- entre medias se asume el refrescador, y el refrescador NO puede leerla
-- —medido: `ERROR: permission denied for table _probe_acl`—, por eso el censo
-- va ANTES del cambio de traje y la devolución DESPUÉS de deshacerlo.
--
-- Se guardan los GRANTs vigentes y se replican tal cual sobre las vistas
-- nuevas. En una instalación que no tuviera ninguno, no se inventa ninguno.
CREATE TEMP TABLE _acl_vistas_071 ON COMMIT DROP AS
SELECT c.relname::text AS vista,
       pg_get_userbyid(x.grantee)::text AS beneficiario,
       x.privilege_type::text AS privilegio
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
  CROSS JOIN LATERAL aclexplode(c.relacl) AS x
 WHERE c.relname IN ('mv_trial_balance', 'mv_account_balance_summary')
   AND c.relacl IS NOT NULL
   AND pg_get_userbyid(x.grantee) <> pg_get_userbyid(c.relowner);

-- ── PRIMERO SE SUELTAN, Y SE SUELTAN CON EL ROL DEL CORREDOR ────────────
--
-- Las dos van juntas y van ANTES del cambio de traje, no intercaladas con sus
-- CREATE. El motivo es de propiedad, y se mide en los dos sentidos:
--   · en una ACTUALIZACIÓN las vistas ya son de mnemosine_refresher, y
--     mnemosine_owner puede soltarlas porque ES MIEMBRO de ese rol
--     (provision-roles.sql:55) — probado: `DROP MATERIALIZED VIEW`;
--   · en una INSTALACIÓN NUEVA todavía son de mnemosine_owner, y el
--     refrescador NO puede soltarlas: la membresía va en un solo sentido.
--     Probado: `ERROR: must be owner of materialized view mv_trial_balance`.
-- El rol del corredor es el único que sirve para las dos poblaciones.
--
-- El CASCADE se conserva del original. Medido en una base al día: hoy no
-- cuelga de estas vistas ninguna otra vista ni regla (0 dependientes).
DROP MATERIALIZED VIEW IF EXISTS mv_trial_balance CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_account_balance_summary CASCADE;

-- ── EL TRAJE DEL REFRESCADOR, Y SÓLO CUANDO HACE FALTA ──────────────────
--
-- Tres guardas, en este orden, porque cada una descarta una población:
--
--  1. Quien ya ignora la RLS (superusuario o BYPASSRLS) no cambia de traje.
--     Esto NO es cortesía: en una máquina de desarrollo el corredor entra como
--     superusuario, y `SET ROLE` lo BAJARÍA a un rol que puede no tener CREATE
--     en el esquema de ESA base. Cambiar de traje ahí sería introducir un
--     fallo donde hoy no lo hay.
--  2. Si no hay políticas sobre las cuatro tablas de la definición, tampoco
--     hace falta: es la INSTALACIÓN NUEVA, donde este archivo corre antes de
--     que rls-policies.sql se haya aplicado nunca sobre la base. Se crea como
--     siempre, y los privilegios por defecto del operador siguen alcanzándola.
--  3. Sólo queda la ACTUALIZACIÓN. Ahí el traje es obligatorio, y si no se
--     puede vestir se PARA con un mensaje que dice qué correr. Seguir sería
--     chocar contra el 42501 de arriba, cuya pista invita a desarmar la RLS.
--
-- `SET LOCAL` y no `SET`: el corredor mete el .sql y el INSERT en
-- public.migrations en la MISMA transacción, y un `SET ROLE` sin LOCAL
-- sobreviviría al COMMIT y contaminaría todas las migraciones posteriores de
-- la corrida. Con LOCAL muere en el COMMIT (y en el ROLLBACK).
--
-- Y sí, el cambio SOBREVIVE a la salida del bloque DO: plpgsql no restaura el
-- rol al terminar un DO suelto. Medido: `despues_del_do = mnemosine_refresher`.
-- Eso es justo lo que este bloque necesita, y también lo que obliga al
-- RESET ROLE de más abajo.
DO $rol$
DECLARE
  ya_ve_todo boolean;
BEGIN
  SELECT rolsuper OR rolbypassrls INTO ya_ve_todo
    FROM pg_roles WHERE rolname = current_user;

  IF COALESCE(ya_ve_todo, false) THEN
    RAISE NOTICE '071: % ya ve el clúster entero; las vistas se crean sin cambiar de rol', current_user;
    RETURN;
  END IF;

  IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN ('accounts', 'fiscal_periods',
                             'journal_entries', 'journal_entry_lines'))
  THEN
    RAISE NOTICE '071: aún no hay políticas sobre las tablas base; las vistas se crean como %', current_user;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_refresher') THEN
    RAISE EXCEPTION
      '071 recrea dos vistas materializadas leyendo tablas con política de inquilino, y el rol mnemosine_refresher no existe en este clúster'
      USING HINT = 'corre scripts/provision-roles.sql como superusuario y vuelve a lanzar la migración; NO quites FORCE ROW LEVEL SECURITY';
  END IF;

  IF NOT pg_has_role(current_user, 'mnemosine_refresher', 'USAGE') THEN
    RAISE EXCEPTION
      '071 necesita crear las vistas como mnemosine_refresher y % no es miembro de ese rol', current_user
      USING HINT = 'GRANT mnemosine_refresher TO <el rol que corre las migraciones> (scripts/provision-roles.sql:55)';
  END IF;

  -- Lo que el refrescador necesita para poder CORRER la consulta definitoria y
  -- para poder CREAR el objeto. En una actualización rls-policies.sql ya se lo
  -- dio en la corrida anterior (líneas 244 y 250) y esto es un eco inofensivo;
  -- se repite aquí para que este archivo no dependa de ese efecto lateral.
  -- BYPASSRLS salta políticas, no GRANTs. Cada uno en su propia subtransacción,
  -- como en rls-policies.sql: que falte privilegio para otorgar uno no debe
  -- deshacer el que sí se pudo otorgar.
  BEGIN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO mnemosine_refresher';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '071: sin privilegio para dar lectura al refrescador; se intenta con la que ya tenga';
  END;
  BEGIN
    EXECUTE 'GRANT USAGE, CREATE ON SCHEMA public TO mnemosine_refresher';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '071: sin privilegio para dar CREATE en el esquema al refrescador';
  END;

  EXECUTE 'SET LOCAL ROLE mnemosine_refresher';
  RAISE NOTICE '071: las vistas se crean como % (BYPASSRLS), que es su dueño de régimen', current_user;
END
$rol$;

CREATE MATERIALIZED VIEW mv_trial_balance AS
SELECT a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.normal_balance,
    a.entity_id,
    fp.id AS fiscal_period_id,
    fp.period_name,
    fp.start_date AS period_start,
    fp.end_date AS period_end,
    COALESCE(sum(jel.debit_amount), 0::numeric) AS total_debits,
    COALESCE(sum(jel.credit_amount), 0::numeric) AS total_credits,
    (COALESCE(sum(COALESCE(jel.debit_amount, 0::numeric)), 0::numeric)
      - COALESCE(sum(COALESCE(jel.credit_amount, 0::numeric)), 0::numeric)) AS net_balance
   FROM ((accounts a
     CROSS JOIN fiscal_periods fp)
     LEFT JOIN (journal_entry_lines jel
     JOIN journal_entries je ON ((je.id = jel.journal_entry_id) AND (je.status::text = 'posted'::text)))
       ON ((jel.account_id = a.id) AND (je.fiscal_period_id = fp.id)))
  WHERE (a.entity_id = fp.entity_id)
  GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance, a.entity_id,
           fp.id, fp.period_name, fp.start_date, fp.end_date;

CREATE UNIQUE INDEX idx_mv_trial_balance ON public.mv_trial_balance USING btree (account_id, fiscal_period_id);
CREATE INDEX idx_mv_trial_balance_entity ON public.mv_trial_balance USING btree (entity_id);

CREATE MATERIALIZED VIEW mv_account_balance_summary AS
SELECT a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.entity_id,
    COALESCE(sum(COALESCE(jel.debit_amount, 0::numeric)), 0::numeric) AS total_debits,
    COALESCE(sum(COALESCE(jel.credit_amount, 0::numeric)), 0::numeric) AS total_credits,
    COALESCE(sum((COALESCE(jel.debit_amount, 0::numeric) - COALESCE(jel.credit_amount, 0::numeric))), 0::numeric) AS current_balance,
    count(DISTINCT je.id) AS transaction_count,
    max(je.entry_date) AS last_transaction_date
   FROM (accounts a
     LEFT JOIN (journal_entry_lines jel
     JOIN journal_entries je ON ((je.id = jel.journal_entry_id) AND (je.status::text = 'posted'::text)))
       ON (jel.account_id = a.id))
  GROUP BY a.id, a.code, a.name, a.account_type, a.entity_id;

CREATE UNIQUE INDEX idx_mv_account_balance ON public.mv_account_balance_summary USING btree (account_id);
CREATE INDEX idx_mv_account_balance_entity ON public.mv_account_balance_summary USING btree (entity_id);

-- ── SE DEVUELVE EL TRAJE, Y NO ES OPCIONAL ──────────────────────────────
--
-- El corredor anota la migración en `public.migrations` DENTRO de esta misma
-- transacción, y el refrescador no tiene INSERT sobre esa tabla. Sin esta
-- línea la migración corre entera y muere en la anotación:
--   `error: permission denied for table migrations`
-- ROLLBACK, nada aplicado, y el mensaje no menciona ni las vistas ni el rol.
-- Va aquí y no al final del archivo porque la devolución de permisos de abajo
-- también tiene que ser el operador (y tiene que leer la tabla temporal).
-- Es idempotente: si ninguna de las tres guardas asumió el rol, no hace nada.
RESET ROLE;

-- Y se devuelven, uno a uno, exactamente los que había.
DO $permisos$
DECLARE g record; devueltos integer := 0;
BEGIN
  FOR g IN SELECT * FROM _acl_vistas_071 LOOP
    EXECUTE format('GRANT %s ON public.%I TO %I', g.privilegio, g.vista, g.beneficiario);
    devueltos := devueltos + 1;
  END LOOP;
  RAISE NOTICE 'Permisos devueltos a las dos vistas: %', devueltos;
END
$permisos$;

COMMENT ON MATERIALIZED VIEW mv_trial_balance IS
  'Balanza materializada por cuenta y periodo. SIN filtro de is_active desde la 071 (T13): una cuenta archivada con movimiento posteado sigue llevando su dinero, y el cotejo de frescura compara el mayor contra esto con el MISMO criterio.';
COMMENT ON MATERIALIZED VIEW mv_account_balance_summary IS
  'Saldo acumulado por cuenta. SIN filtro de is_active desde la 071 (T13), por la misma razón que mv_trial_balance.';
