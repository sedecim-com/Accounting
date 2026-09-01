-- ============================================================
-- 033: LA BITÁCORA DE AUDITORÍA NO SE REESCRIBE
--
-- audit_log es lo que prueba quién hizo qué. Hasta ahora se podía
-- modificar con un UPDATE y borrar con un DELETE, lo que la deja
-- exactamente igual de valiosa que no tenerla: un rastro reescribible no
-- demuestra nada, porque quien pudo hacer el acto pudo maquillarlo
-- después.
--
-- El cierre es de DOS capas, y hacen falta las dos:
--
--   1. PRIVILEGIOS. Se revoca UPDATE, DELETE y TRUNCATE a mnemosine_app
--      y a PUBLIC. Es la barrera barata: Postgres la aplica antes de
--      ejecutar nada.
--   2. DISPARADOR. El dueño del esquema y el superusuario ignoran los
--      privilegios de tabla, así que la primera capa no los detiene. El
--      disparador sí: se dispara para todos por igual, incluido
--      mnemosine_owner corriendo migraciones.
--
-- Deliberadamente NO hay puerta de escape. Un renglón escrito por error
-- se corrige con otro renglón que lo diga —igual que un asiento
-- equivocado se corrige por reversión y no por edición (NIF B-1)—, no
-- reescribiendo el historial. Si algún día hiciera falta purgar por
-- retención legal, será una migración explícita que deje constancia de
-- sí misma, no un permiso permanente.
--
-- Nota sobre INSERT: sigue permitido, obviamente, y es lo único.
-- ============================================================

CREATE OR REPLACE FUNCTION public.audit_log_solo_agrega() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'audit_log es de sólo escritura: % rechazado. Un rastro que se puede reescribir no prueba nada; corrige con un renglón nuevo.',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;

COMMENT ON FUNCTION public.audit_log_solo_agrega() IS
  'Rechaza UPDATE y DELETE sobre audit_log. Alcanza también al dueño del esquema, que los privilegios de tabla no detienen.';

DROP TRIGGER IF EXISTS audit_log_append_only ON public.audit_log;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_log_solo_agrega();

-- Un TRUNCATE no dispara triggers FOR EACH ROW: necesita el suyo.
DROP TRIGGER IF EXISTS audit_log_no_truncate ON public.audit_log;

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_log_solo_agrega();

-- Primera capa: privilegios. El bloque va guardado por la existencia del
-- rol para que la migración corra igual en una base sin provisionar
-- (desarrollo, la base efímera de las pruebas de integración).
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM mnemosine_app;
    GRANT INSERT, SELECT ON public.audit_log TO mnemosine_app;
  END IF;
END $$;

-- Y que los privilegios por defecto no la vuelvan a conceder cuando una
-- migración futura recree la tabla o alguien reaplique el provisionado.
COMMENT ON TABLE public.audit_log IS
  'Bitácora de auditoría: SÓLO INSERT. UPDATE, DELETE y TRUNCATE los rechaza el disparador audit_log_append_only (migración 033). Un renglón erróneo se corrige con otro renglón, nunca reescribiendo.';
