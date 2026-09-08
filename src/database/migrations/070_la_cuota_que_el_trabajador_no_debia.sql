-- ============================================================
-- 070 · LA CUOTA QUE EL TRABAJADOR NO DEBÍA (T20, punto 6 · #127)
--
-- `imss_employee.enfermedades_maternidad` se sembró en 0.00625 y la ley dice
-- 0.004. No es una diferencia de criterio ni una tasa que dependa del ejercicio:
-- es la cuota OBRERA adicional del art. 106 fracción II de la Ley del Seguro
-- Social, que es 0.40 % del excedente de tres UMA. Lleva ahí desde la 009.
--
-- ── CÓMO SE SABE QUE 0.00625 ESTÁ MAL, sin fiarse de una sola fuente ─────
--
-- 1. LA PAREJA DEL MISMO ARTÍCULO YA ESTÁ BIEN. El art. 106-II fija DOS cuotas
--    sobre el mismo excedente: patrón 1.10 % y trabajador 0.40 %. En el mismo
--    JSON de la 009, `imss_employer.enfermedades_maternidad_excedente` vale
--    0.011 — correcto. Sólo la mitad obrera de la pareja está mal.
--
-- 2. EL CÓDIGO CONFIRMA QUE ES ESE ARTÍCULO. `imss-calculator.ts:72` aplica la
--    cuota obrera sobre `excedente3uma`, y `:121` aplica la patronal sobre el
--    MISMO excedente. Las dos son la cuota adicional; no hay ambigüedad sobre
--    qué concepto se está cobrando.
--
-- 3. LAS OTRAS CUATRO CUOTAS OBRERAS DEL MISMO JSON SON EXACTAS: prestaciones
--    en dinero 0.25 % (art. 107), gastos médicos de pensionados 0.375 %
--    (art. 25), invalidez y vida 0.625 % (art. 147), cesantía y vejez 1.125 %.
--    El error está aislado, y su valor —0.00625— es exactamente el de
--    `invalidez_vida`: se copió la casilla de al lado.
--
-- ── LO QUE COSTABA ──────────────────────────────────────────────────────
--
-- 0.00625 / 0.004 = 1.5625: un sobrecobro del 56.25 % en ese ramo a TODO
-- trabajador con salario base de cotización superior a tres UMA. No se queda en
-- un informe interno: sale en el recibo de nómina, viaja en el CFDI de nómina
-- con el que el SAT precarga la declaración anual del trabajador, y se paga en
-- la línea de captura del IMSS. Es dinero retenido de más a una persona, cada
-- periodo, desde que el módulo existe.
--
-- ── POR QUÉ MIGRACIÓN NUEVA Y NO EDITAR LA 009 ──────────────────────────
--
-- La tabla `migrations` lleva la cuenta por NOMBRE DE ARCHIVO y sin checksum:
-- editar la 009 no la re-ejecuta, así que arreglaría a quien instale mañana y
-- dejaría intacto a todo despacho que ya la aplicó — que son justamente los que
-- están cobrando de más. La corrección de un DATO ya sembrado sólo llega por una
-- migración nueva. La 009 se deja como está: es el registro de lo que se hizo.
--
-- ── POR QUÉ AQUÍ NO HAY BUCLE POR INQUILINO ─────────────────────────────
--
-- Dicho porque tras T1 (#88) el reflejo correcto es preguntarlo:
-- `tax_parameters` (008_payroll.sql:375-382) no tiene `tenant_id` ni
-- `entity_id`, así que `rls-policies.sql` no la acota y este UPDATE no puede
-- afectar cero filas por filtrado silencioso. Es una tabla de referencia
-- compartida: la ley es la misma para todos los inquilinos.
-- ============================================================

DO $cuota$
DECLARE
    corregidas integer;
    tercas     integer;
    r          record;
BEGIN
    -- Se compara NUMÉRICAMENTE y no como texto: jsonb normaliza los números y
    -- '0.00625' no tiene por qué volver escrito igual que como entró.
    UPDATE tax_parameters
       SET params = jsonb_set(params, '{imss_employee,enfermedades_maternidad}', to_jsonb(0.004::numeric))
     WHERE params #> '{imss_employee}' IS NOT NULL
       AND (params #>> '{imss_employee,enfermedades_maternidad}')::numeric = 0.00625;
    GET DIAGNOSTICS corregidas = ROW_COUNT;

    -- UN RELLENO QUE NO RELLENA NADA NO PUEDE PASAR CALLADO. Si queda alguna
    -- fila con el valor equivocado conocido, el UPDATE no hizo su trabajo y
    -- seguir sería registrar la migración como aplicada sobre datos que siguen
    -- mal.
    SELECT count(*) INTO tercas
      FROM tax_parameters
     WHERE (params #>> '{imss_employee,enfermedades_maternidad}')::numeric = 0.00625;
    IF tercas > 0 THEN
        RAISE EXCEPTION 'La cuota obrera de enfermedades y maternidad sigue en 0.00625 en % fila(s)', tercas
          USING HINT = 'El UPDATE de esta migración no las alcanzó: revísese antes de dar la actualización por buena.';
    END IF;

    -- Un valor DISTINTO de los dos conocidos no se toca ni aborta la
    -- actualización: puede ser una corrección local deliberada. Pero se nombra,
    -- porque un parámetro fiscal que nadie sabe de dónde salió es su propio
    -- problema.
    FOR r IN
        SELECT jurisdiction, tax_year, params #>> '{imss_employee,enfermedades_maternidad}' AS v
          FROM tax_parameters
         WHERE params #> '{imss_employee}' IS NOT NULL
           AND (params #>> '{imss_employee,enfermedades_maternidad}')::numeric <> 0.004
    LOOP
        RAISE WARNING 'tax_parameters %/% tiene la cuota obrera de enfermedades y maternidad en % (la ley dice 0.004): no se toca, pero conviene explicarlo',
            r.jurisdiction, r.tax_year, r.v;
    END LOOP;

    RAISE NOTICE 'Cuota obrera de enfermedades y maternidad corregida a 0.004 en % ejercicio(s)', corregidas;
END
$cuota$;
