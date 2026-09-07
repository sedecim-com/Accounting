-- ============================================================
-- ROL DE AUDITOR — `mnemosine_auditor`  (idempotente)
--
-- El que sólo mira.
--
-- HOY, dar acceso a un auditor externo es darle credenciales de ESCRITURA
-- sobre los libros: los únicos principales que existen son `mnemosine_app`
-- —que hace todo el DML— y `mnemosine_owner`, que además posee el esquema y
-- es el break-glass. Un despacho que quiere revisar la contabilidad de su
-- cliente entra hoy como uno de los dos, o no entra. Eso convierte cada
-- revisión externa en una concesión de escritura, y borra la frase que
-- mnemosine vende: se puede probar quién hizo qué.
--
-- Este guion crea el tercer principal: SELECT sobre todo el esquema, INSERT/
-- UPDATE/DELETE sobre nada, y —la línea que hace que todo lo demás
-- signifique algo— SIN BYPASSRLS.
--
--
-- ── POR QUÉ ESTO NO ES UNA MIGRACIÓN ────────────────────────────────────
--
-- Un rol de Postgres es objeto de CLÚSTER, no de base. La primera versión de
-- la migración 061 lo creaba, y falla:
--
--     permission denied to create role
--
-- El migrador no es superusuario y no tiene CREATEROLE, y eso es deliberado
-- desde S3: el mismo acotamiento que impide que una migración se salte la
-- RLS impide que se conceda privilegios a sí misma. Darle CREATEROLE al
-- migrador para poder crear el rol del que sólo mira sería pagar el agujero
-- exacto que este rol viene a tapar.
--
-- Tampoco se hace tolerante —«si puedo lo creo, si no sigo»—: una garantía
-- que unas veces está y otras no, sin que nadie lo sepa, es peor que no
-- tenerla. Por eso el rol lo crea quien OPERA el clúster, con este archivo, y
-- `mnemosine doctor` comprueba si está puesto y con qué permisos, y lo DICE.
-- Es el patrón que la 058 estrenó con el sello de las garantías: el sistema
-- no asume sus defensas, las mira.
--
--
-- ── CÓMO SE OPERA ───────────────────────────────────────────────────────
--
-- 1. Crear el rol y sus privilegios (una vez, como superusuario):
--
--      psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql
--
--    Corre después de `scripts/provision-roles.sql`, porque necesita que las
--    tablas ya sean de `mnemosine_owner` para poder fijar los privilegios por
--    defecto de lo que venga.
--
-- 2. Volver a correrlo después de cada tanda de migraciones que traiga
--    tablas nuevas. No hace falta si `ALTER DEFAULT PRIVILEGES` ya estaba
--    puesto cuando se crearon —para eso está— pero es idempotente y correrlo
--    de más no cuesta nada.
--
-- 3. Dar acceso a UN auditor concreto. `mnemosine_auditor` es NOLOGIN a
--    propósito: es un paquete de privilegios, no una cuenta. Nadie se conecta
--    «como el auditor»; el operador emite una cuenta NOMINAL por persona y le
--    concede el rol:
--
--      CREATE ROLE auditoria_lopez LOGIN PASSWORD '…' IN ROLE mnemosine_auditor;
--
--    Nominal y no compartida porque el rastro de auditoría se lee por autor:
--    una credencial que usan cuatro personas del despacho responde «alguien
--    del despacho», que es la respuesta que este producto existe para no dar.
--
-- 4. RETIRARLO cuando la revisión termina. Es la mitad que se olvida:
--
--      REVOKE mnemosine_auditor FROM auditoria_lopez;
--      DROP ROLE auditoria_lopez;
--
--
-- ── LO QUE EL AUDITOR VE, Y LO QUE NO ───────────────────────────────────
--
-- Ve las filas del inquilino QUE SU SESIÓN FIJE, y de ninguna tabla que no
-- lleve inquilino (ver «lo que este rol NO garantiza», más abajo).
-- `NOBYPASSRLS` no es una cautela
-- de estilo: las políticas `tenant_isolation` son `FOR ALL USING (tenant_id =
-- app_current_tenant())` sobre tablas con FORCE ROW LEVEL SECURITY, así que
-- un rol sin BYPASSRLS queda sujeto a ellas igual que la aplicación. Un
-- sólo-lectura que atravesara el aislamiento sería un agujero PEOR que el que
-- viene a tapar: hoy el riesgo es que un auditor externo pueda escribir en
-- los libros de su cliente; con BYPASSRLS el riesgo sería que pudiera LEER
-- los libros de todos los demás clientes del despacho, en silencio y sin
-- dejar rastro, porque leer no dispara nada.
--
-- Consecuencia práctica, y hay que decirla porque parece una avería: sin
-- contexto de inquilino, el auditor no ve NINGUNA fila. Las políticas fallan
-- cerradas —`app_current_tenant()` devuelve NULL y el predicado no casa con
-- nada— así que su sesión tiene que fijarlo, igual que lo fija la aplicación:
--
--      SET app.current_tenant = '<uuid del inquilino>';
--
-- Un `SELECT` que devuelve cero filas antes de eso está funcionando, no roto.
--
-- Tampoco ve nada que la aplicación no vea: `users` y `sessions` están fuera
-- de las políticas por el camino de autenticación, y aquí se les niega el
-- SELECT explícitamente (bloque 4, junto con todo lo demás que no lleva
-- aislamiento). Un auditor no necesita los hashes de contraseña de nadie para
-- revisar una contabilidad.
--
--
-- ── LO QUE ESTE ROL **NO** GARANTIZA ────────────────────────────────────
--
-- Que el inquilino lo elige LA SESIÓN, no el rol. `SET app.current_tenant` es
-- un parámetro de sesión y nada ata `mnemosine_auditor` a un inquilino
-- concreto: quien tenga la cuenta puede nombrar el UUID de otro despacho y
-- leer sus libros. Medido en tests/integration/g3-ataque.int.spec.ts.
--
-- No es un defecto de este archivo —un rol de Postgres no sabe de inquilinos—
-- y no se arregla con un REVOKE: pide atar cuenta→inquilino en algún sitio
-- (una tabla de concesiones que la política consulte, o un GRANT por
-- inquilino). Eso es una decisión de producto y está nombrada como candidata
-- al panel; hasta que se tome, la frase honesta es esta:
--
--   el rol impide ESCRIBIR y impide leer lo que no lleva inquilino; que el
--   auditor sólo mire al suyo es hoy una condición del acuerdo con él, no una
--   garantía del esquema.
-- ============================================================

\set ON_ERROR_STOP on

-- ── 0. Requisito previo, dicho a la cara ──
--
-- El bloque 3 fija privilegios por defecto FOR ROLE mnemosine_owner, y
-- Postgres exige que ese rol exista. Sin esta guarda el guion muere con
-- «role "mnemosine_owner" does not exist» a mitad de camino: el rol de
-- auditor queda creado y con GRANT sobre lo de hoy, pero SIN privilegios por
-- defecto, de modo que la siguiente migración le esconde sus tablas nuevas y
-- nadie se entera hasta que un auditor a media revisión choca con un
-- «permission denied» sobre justo la tabla que le importaba.
--
-- Se para ANTES de crear nada, y se dice qué correr.
DO $requisito$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mnemosine_owner') THEN
    RAISE EXCEPTION
      'mnemosine_owner no existe: corre antes scripts/provision-roles.sql. '
      'Sin él no se pueden fijar los privilegios POR DEFECTO del auditor, y un '
      'auditor que ve las tablas de hoy pero no las de mañana es peor que ninguno.';
  END IF;
END
$requisito$;

-- ── 1. El rol ──
DO $auditor$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mnemosine_auditor') THEN
    -- NOLOGIN: paquete de privilegios, no cuenta. NOBYPASSRLS: ver arriba.
    -- NOCREATEROLE y NOCREATEDB por la misma disciplina que los otros tres.
    CREATE ROLE mnemosine_auditor NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
    RAISE NOTICE 'creado rol mnemosine_auditor';
  END IF;
END
$auditor$;

-- Reafirmado FUERA del IF: un rol preexistente —creado a mano, o por una
-- versión anterior de este guion— tiene que converger a estos atributos.
-- Sobre todo NOBYPASSRLS: si alguien se lo concedió «para depurar», este
-- guion es el que lo quita, y `doctor` es el que lo delata mientras tanto.
ALTER ROLE mnemosine_auditor
  NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;

COMMENT ON ROLE mnemosine_auditor IS
  'Sólo lectura, sujeto a RLS. Se concede a cuentas NOMINALES por auditor; ver scripts/rol-auditor.sql.';

-- ── 2. Privilegios sobre lo que ya existe ──
GRANT USAGE ON SCHEMA public TO mnemosine_auditor;

-- SE REVOCA TODO Y SE CONCEDE SÓLO LECTURA, en ese orden.
--
-- El REVOKE no es ceremonia: sin él, este guion no CONVERGE. Un `GRANT INSERT
-- ON journal_entries TO mnemosine_auditor` que alguien concedió a mano —«un
-- momento, para migrar unos datos»— sobrevive a cuantas veces se corra un
-- guion que sólo añade GRANT de SELECT, y el rol se queda con escritura para
-- siempre. Medido: `doctor` lo marcaba en 'fail' y una segunda corrida del
-- guion no lo arreglaba, mientras su propio mensaje de arreglo prometía que
-- sí. Un guion de reparación que no repara es peor que ninguno, porque
-- convierte un fallo visible en un fallo que alguien cree haber atendido.
--
-- Va sobre las tres clases de objeto. Las FUNCIONES importan aparte: EXECUTE
-- sobre una SECURITY DEFINER del operador es escritura con otro nombre, y en
-- este esquema las hay (024, y refresh_reporting_views de R3). La única que
-- el auditor necesita para que las políticas se evalúen es
-- `app_current_tenant()`, que es STABLE, no SECURITY DEFINER, y ya es
-- ejecutable por PUBLIC — un GRANT a PUBLIC no lo toca un REVOKE al rol.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM mnemosine_auditor;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mnemosine_auditor;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM mnemosine_auditor;

-- Y ahora la única concesión del archivo. No hay GRANT de INSERT/UPDATE/
-- DELETE aquí, y no es un olvido que alguien deba «completar»: es el archivo
-- entero.
GRANT SELECT ON ALL TABLES     IN SCHEMA public TO mnemosine_auditor;
GRANT SELECT ON ALL SEQUENCES  IN SCHEMA public TO mnemosine_auditor;

-- ── 3. Privilegios por defecto: lo que venga ──
-- Sin esto, cada tabla que cree una migración futura sería invisible para el
-- auditor hasta que alguien recordara concederla a mano — y el modo en que
-- eso se descubre es un auditor a media revisión con un «permission denied»
-- sobre la única tabla que le importaba.
--
-- FOR ROLE mnemosine_owner porque es quien crea las tablas (provision-roles
-- le traspasa la propiedad del esquema): los privilegios por defecto se
-- aplican a lo que crea el rol NOMBRADO, no a lo que crea cualquiera.
ALTER DEFAULT PRIVILEGES FOR ROLE mnemosine_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO mnemosine_auditor;
ALTER DEFAULT PRIVILEGES FOR ROLE mnemosine_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO mnemosine_auditor;

-- ── 4. Lo que se le quita al auditor ──
--
-- EL GRANT DE ARRIBA ES MASIVO Y LA RLS NO LLEGA A TODAS PARTES. Este bloque
-- es el que hace verdadera la frase «ve las filas de su inquilino»: sin él, el
-- rol de sólo lectura lee sin filtro de inquilino por DOS vías que nadie
-- concedió a mano.
--
-- (a) LAS TABLAS SIN POLÍTICA. `rls-policies.sql` genera las políticas desde
--     el catálogo, y sólo alcanza a las tablas que tienen `tenant_id` o
--     `entity_id`. Una tabla sin ninguna de las dos NO lleva aislamiento, y
--     `GRANT SELECT ON ALL TABLES` se la entrega entera.
--
--     Se invierte la lista: en vez de nombrar las prohibidas —que fue como se
--     escapó `identities`, la tabla que ata el `sub` del proveedor a un
--     usuario y que por no llevar `tenant_id` entregaba el correo y el
--     identificador de proveedor de TODO el personal de TODOS los despachos—
--     se nombran las PERMITIDAS. Lo que no esté clasificado se niega, así que
--     la próxima tabla sin inquilino nace invisible para el auditor y la
--     conversación ocurre ANTES de la fuga, no después.
--
--     `users` y `sessions` siguen fuera por lo de siempre (el camino de
--     autenticación tiene que leerlas antes de saber de quién es quien llama)
--     y `tenants` porque es la lista de clientes del despacho. El nombre de
--     quien firmó un asiento NO se pierde: `audit_log.user_id` está en la
--     bitácora, que sí es del inquilino y sí se lee.
--
-- (b) LAS VISTAS MATERIALIZADAS. Son la vía cara. `ALL TABLES` las incluye —
--     medido: el ACL de `mv_trial_balance` queda en
--     `mnemosine_auditor=r/mnemosine_refresher` sólo por correr este guion— y
--     una vista materializada NO está sujeta a RLS al leerse: sus filas ya
--     están escritas. Peor: las refresca `mnemosine_refresher`, que tiene
--     BYPASSRLS a propósito (R3), de modo que su contenido es el de TODOS los
--     inquilinos a la vez. Un `SELECT * FROM mv_trial_balance` le da al
--     auditor externo la balanza de comprobación de la instalación entera sin
--     fijar un solo contexto y sin tocar una tabla protegida — exactamente lo
--     que la cabecera de este archivo llama el agujero PEOR que el que viene
--     a tapar.
--
--     No se revocan una por una: se revocan por `relkind = 'm'`, que es la
--     propiedad que las hace inseguras, y así la vista número tres nace
--     negada.
DO $revocar$
DECLARE
  -- REFERENCIA GLOBAL: no llevan inquilino porque no son de ningún inquilino
  -- —tipos de cambio publicados por Banxico, catálogos del SAT, tarifas de
  -- ISR— más `migrations`, que dice qué versión de esquema se está auditando.
  -- El auditor las necesita para rehacer un cálculo, y no dicen nada de nadie.
  -- Es la única lista a mano de este archivo, y añadir aquí una tabla es
  -- afirmar que sus filas no son de ningún cliente.
  referencia_global text[] := ARRAY[
    'migrations', 'exchange_rates', 'tax_parameters', 'tax_tables',
    'sat_codigos_agrupadores'
  ];
  r record;
  negadas int := 0;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND NOT c.relispartition
       AND (
             -- (b) toda vista materializada, sin excepción
             c.relkind = 'm'
             -- (a) tabla ordinaria o particionada sin política y sin clasificar
             OR (c.relkind IN ('r', 'p')
                 AND NOT c.relrowsecurity
                 AND c.relname <> ALL (referencia_global))
           )
     ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM mnemosine_auditor', r.relname);
    negadas := negadas + 1;
    RAISE NOTICE 'negada al auditor: %  (%)', r.relname,
      CASE r.relkind WHEN 'm' THEN 'vista materializada: no la filtra la RLS'
                     ELSE 'sin política de aislamiento' END;
  END LOOP;
  RAISE NOTICE '% relación(es) sin aislamiento negadas a mnemosine_auditor', negadas;
END
$revocar$;

-- Y lo mismo para lo que venga: los privilegios por defecto del bloque 3 se
-- aplican a TODA tabla que cree `mnemosine_owner`, incluida una futura sin
-- `tenant_id`. No hay forma de condicionarlos, así que la garantía es que este
-- guion se vuelve a correr tras cada tanda de migraciones (paso 2 de «cómo se
-- opera») y `mnemosine doctor` delata mientras tanto lo que el auditor lee de
-- más.

-- ── 5. Verificación ──
-- Lo mismo que mira `doctor`, para quien corre el guion a mano.
SELECT rolname,
       rolsuper     AS es_superusuario,
       rolbypassrls AS ignora_rls,
       rolcanlogin  AS puede_entrar,
       rolcreaterole AS puede_crear_roles
FROM pg_roles
WHERE rolname = 'mnemosine_auditor';

-- Cobertura, contada sobre lo que de verdad tiene que poder leer: las tablas
-- CON política de aislamiento. Contarlas todas obligaba a restar a mano las
-- que se niegan («menos tres»), y ese tres se quedó corto en cuanto apareció
-- la cuarta. Si los dos números no coinciden, nacieron tablas después del
-- último GRANT: corre este guion otra vez.
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND c.relrowsecurity
      AND has_table_privilege('mnemosine_auditor', c.oid, 'SELECT'))  AS aisladas_legibles,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND c.relrowsecurity)                                           AS aisladas_totales,
  -- Y lo que lee SIN aislamiento: debe ser exactamente la referencia global.
  (SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '(ninguna)')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','m') AND NOT c.relispartition
      AND NOT c.relrowsecurity
      AND has_table_privilege('mnemosine_auditor', c.oid, 'SELECT')) AS sin_aislamiento_legibles;
