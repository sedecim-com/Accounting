-- ============================================================
-- 035: LA BITÁCORA DE LA e.firma TAMPOCO SE REESCRIBE
--
-- fiscal_credential_access_log prueba QUIÉN DESCIFRÓ la e.firma del
-- contribuyente, cuándo y para qué. De todas las bitácoras del sistema
-- es la que más importa que sea cierta: la llave que custodia es la que
-- firma ante el SAT en nombre de una persona, y el único modo de
-- distinguir un uso legítimo de un abuso es este rastro.
--
-- La migración 014 creyó haberla cerrado. Su comentario lo afirma con
-- todas las letras:
--
--     «The app only has INSERT and SELECT: neither the code nor an
--      attacker holding the app's connection can erase the history.»
--
-- Era falso desde el primer día, por dos razones independientes:
--
--   1. Su único REVOKE es FROM PUBLIC (014:91). Quitarle un privilegio a
--      PUBLIC no toca el GRANT explícito que rls-policies.sql le hace a
--      mnemosine_app: nunca detuvo al rol con el que corre la aplicación,
--      que es exactamente el actor del que habla ese comentario.
--   2. rls-policies.sql se aplica DESPUÉS de todas las migraciones
--      (migrate.ts) y su array `append_only` sólo contenía 'audit_log'.
--      El GRANT general le devolvía UPDATE y DELETE en la misma corrida
--      de `npm run migrate` que acababa de revocarlos.
--
-- Es el mismo cierre de dos capas de la migración 033 —privilegios y
-- disparador—, y aquí las dos estaban muertas. Peor que en audit_log:
-- allí, cuando los privilegios fallan, queda el disparador. Esta tabla
-- no tenía ninguno, así que la capa que fallaba era la única capa.
--
-- Deliberadamente NO hay puerta de escape, por la misma razón que en la
-- 033: un registro de acceso equivocado se corrige con otro registro que
-- lo diga, no reescribiendo el historial.
--
-- ADVERTENCIA que la 033 ya merecía y no lleva: scripts/provision-roles.sql
-- concede SELECT, INSERT, UPDATE, DELETE sobre TODAS las tablas, así que
-- reprovisionar deshace la capa de privilegios de las DOS bitácoras. Esa
-- concesión queda ahora exceptuada allí, pero la capa que aguanta pase lo
-- que pase —y la que alcanza al dueño del esquema, a quien los privilegios
-- de tabla no detienen— es el disparador.
-- ============================================================

-- Función propia y no la de la 033: aquélla nombra 'audit_log' en su
-- mensaje (033:36) y sólo interpola TG_OP, de modo que reutilizarla haría
-- que un DELETE aquí se rechazara acusando a la tabla equivocada. Un
-- mensaje que miente sobre qué protegió es justo lo que esta migración
-- existe para no tener.
CREATE OR REPLACE FUNCTION public.fiscal_credential_access_log_solo_agrega() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'fiscal_credential_access_log es de sólo escritura: % rechazado. Es la prueba de quién descifró la e.firma; corrige con un renglón nuevo.',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;

COMMENT ON FUNCTION public.fiscal_credential_access_log_solo_agrega() IS
  'Rechaza UPDATE y DELETE sobre fiscal_credential_access_log. Alcanza también al dueño del esquema, que los privilegios de tabla no detienen.';

DROP TRIGGER IF EXISTS fiscal_credential_access_log_append_only ON public.fiscal_credential_access_log;

CREATE TRIGGER fiscal_credential_access_log_append_only
  BEFORE UPDATE OR DELETE ON public.fiscal_credential_access_log
  FOR EACH ROW
  EXECUTE FUNCTION public.fiscal_credential_access_log_solo_agrega();

-- Un TRUNCATE no dispara triggers FOR EACH ROW: necesita el suyo.
DROP TRIGGER IF EXISTS fiscal_credential_access_log_no_truncate ON public.fiscal_credential_access_log;

CREATE TRIGGER fiscal_credential_access_log_no_truncate
  BEFORE TRUNCATE ON public.fiscal_credential_access_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.fiscal_credential_access_log_solo_agrega();

-- Primera capa: privilegios. El bloque va guardado por la existencia del
-- rol para que la migración corra igual en una base sin provisionar
-- (desarrollo, la base efímera de las pruebas de integración).
REVOKE UPDATE, DELETE, TRUNCATE ON public.fiscal_credential_access_log FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON public.fiscal_credential_access_log FROM mnemosine_app;
    GRANT INSERT, SELECT ON public.fiscal_credential_access_log TO mnemosine_app;
  END IF;
END $$;

COMMENT ON TABLE public.fiscal_credential_access_log IS
  'Bitácora de acceso a credenciales fiscales: SÓLO INSERT. UPDATE, DELETE y TRUNCATE los rechaza el disparador fiscal_credential_access_log_append_only (migración 035). Prueba quién descifró la e.firma: un renglón erróneo se corrige con otro renglón, nunca reescribiendo.';
