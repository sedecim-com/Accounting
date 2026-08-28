-- ============================================================
-- PROVISIÓN DE ROLES DE BASE  (idempotente)
--
-- Tres principales, dos roles de Postgres:
--   · mnemosine_app    → la API. Solo DML, no posee nada, sujeta a RLS.
--   · mnemosine_owner  → el operador. Posee el esquema, corre migraciones,
--                       entra por túnel. Es también el break-glass.
--   · el cron de ingesta NO necesita rol: entra por la API.
--
-- Esto NO es una migración: crea objetos de nivel clúster y necesita
-- superusuario, así que vive aparte de la cadena de migraciones.
--
-- Ejecutar una vez:
--   psql "$SUPERUSER_URL" \
--     -v app_pw="$MNEMOSINE_APP_PASSWORD" \
--     -v owner_pw="$MNEMOSINE_OWNER_PASSWORD" \
--     -f scripts/provision-roles.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ── 1. Los roles ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_owner') THEN
    CREATE ROLE mnemosine_owner LOGIN;
    RAISE NOTICE 'creado rol mnemosine_owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_app') THEN
    CREATE ROLE mnemosine_app LOGIN;
    RAISE NOTICE 'creado rol mnemosine_app';
  END IF;
END $$;

-- NOBYPASSRLS es la línea que hace que las políticas signifiquen algo.
ALTER ROLE mnemosine_owner
  PASSWORD :'owner_pw' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
ALTER ROLE mnemosine_app
  PASSWORD :'app_pw'   NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;

-- ── 2. Privilegios sobre el esquema ──
GRANT USAGE  ON SCHEMA public TO mnemosine_owner, mnemosine_app;
GRANT CREATE ON SCHEMA public TO mnemosine_owner;
REVOKE CREATE ON SCHEMA public FROM mnemosine_app;

-- La app hace DML y nada más: sin DDL, sin TRUNCATE, sin REFERENCES.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO mnemosine_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO mnemosine_app;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA public TO mnemosine_app;

-- Menos las bitácoras de sólo agregar. El GRANT de arriba dice ALL TABLES
-- y lo dice en serio: reprovisionar sobre una base ya migrada le devolvía
-- a la app UPDATE y DELETE sobre audit_log y sobre la bitácora que prueba
-- quién descifró la e.firma, deshaciendo en silencio lo que las
-- migraciones 033 y 035 habían revocado. El disparador seguía deteniendo
-- el acto, pero la barrera barata quedaba muerta sin que nada lo dijera.
--
-- Va guardado por la existencia de cada tabla porque este guion también
-- se corre sobre un clúster recién creado, antes de la primera migración.
-- La lista se declara con la misma forma que en src/database/rls-policies.sql
-- a propósito: son dos sitios que tienen que decir lo mismo, y el criterio
-- E0.3 de src/plan/criterios.ts las lee a las dos con el mismo patrón y falla
-- si divergen o si nombran una tabla sin disparador que la respalde.
DO $append_only$
DECLARE
  append_only text[] := ARRAY['audit_log', 'fiscal_credential_access_log'];
  t text;
BEGIN
  FOREACH t IN ARRAY append_only LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM mnemosine_app', t);
    END IF;
  END LOOP;
END
$append_only$;

-- ── 3. Privilegios por defecto ──
-- Sin esto, cada tabla que cree una migración futura sería invisible
-- para la app hasta que alguien recordara concederla a mano.
ALTER DEFAULT PRIVILEGES FOR ROLE mnemosine_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mnemosine_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mnemosine_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mnemosine_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mnemosine_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO mnemosine_app;

-- ── 4. Traspaso de propiedad al operador ──
-- Necesario para que FORCE ROW LEVEL SECURITY tenga a quién forzar: si las
-- tablas siguen siendo de postgres (superusuario), RLS nunca se evalúa.
DO $$
DECLARE
  r       record;
  moved   int := 0;
  skipped int := 0;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      AND NOT c.relispartition
      AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'mnemosine_owner')
    ORDER BY CASE c.relkind WHEN 'r' THEN 0 WHEN 'p' THEN 0 ELSE 1 END
  LOOP
    BEGIN
      EXECUTE format('ALTER %s public.%I OWNER TO mnemosine_owner',
        CASE r.relkind
          WHEN 'S' THEN 'SEQUENCE'
          WHEN 'v' THEN 'VIEW'
          WHEN 'm' THEN 'MATERIALIZED VIEW'
          ELSE 'TABLE'
        END, r.relname);
      moved := moved + 1;
    EXCEPTION WHEN others THEN
      -- Las secuencias de columnas serial/identity cambian de dueño junto
      -- con su tabla; al llegar aquí ya están y la orden falla sin daño.
      skipped := skipped + 1;
    END;
  END LOOP;
  RAISE NOTICE 'objetos reasignados a mnemosine_owner: % (omitidos: %)', moved, skipped;
END $$;

-- ── 5. Verificación ──
SELECT rolname,
       rolsuper    AS es_superusuario,
       rolbypassrls AS ignora_rls,
       rolcanlogin AS puede_entrar
FROM pg_roles
WHERE rolname IN ('mnemosine_app', 'mnemosine_owner')
ORDER BY rolname;
