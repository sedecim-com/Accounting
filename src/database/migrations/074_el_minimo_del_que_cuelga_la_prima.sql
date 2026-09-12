-- ============================================================
-- 074 · EL MÍNIMO DEL QUE CUELGA LA PRIMA (T4b · #91)
--
-- La 009 siembra como parámetros de 2026 el salario mínimo de 2025:
-- `salario_minimo_general_diario: 278.80` y `salario_minimo_frontera_diario:
-- 419.88` (009:42-43). Los de 2026, fijados por la CONASAMI y publicados en el
-- DOF del 9 de diciembre de 2025, son **315.04** y **440.87**.
--
-- ── POR QUÉ ESTA CIFRA IMPORTA MÁS DE LO QUE PARECE ─────────────────────
--
-- De ella cuelga el TOPE de la prima de antigüedad. El art. 162 fr. II LFT no
-- define el salario: remite a los arts. 485 y 486, y el 486 dice que si el
-- salario «excede del doble del salario mínimo … se considerará esa cantidad
-- como salario máximo». O sea la base es
--
--     min( max(salario_diario, SM), 2 × SM )
--
-- y se topa el SALARIO, no el resultado. Para un trabajador con 15 años y
-- salario diario de 1 000, la prima son 12 × 15 = 180 días de esa base:
--
--     con el 278.80 sembrado ..... 180 × 557.60 = 100 368.00
--     con el 315.04 de 2026 ...... 180 × 630.08 = 113 414.40
--
-- Trece mil cuarenta y seis pesos con cuarenta centavos de diferencia POR
-- TRABAJADOR, en una prestación que se paga una sola vez y no se rectifica.
--
-- ── EL MÍNIMO CAMBIA EL 1 DE ENERO, NO EL 1 DE FEBRERO ──────────────────
--
-- La UMA entra en vigor el 1 de febrero y por eso la 073 dejó dos ventanas en
-- 2026; el salario mínimo, en cambio, rige desde el 1 de enero. Así que la
-- corrección va a LAS DOS ventanas: la de enero (que hoy lleva la UMA de 2025,
-- correctamente) y la de febrero en adelante.
--
-- ── LO QUE ESTA MIGRACIÓN NO RESUELVE, Y HAY QUE DECIRLO ────────────────
--
-- 1. LA ZONA. El 486 mide el tope con el mínimo «del área geográfica … que
--    corresponda al lugar de prestación del trabajo». Este esquema NO tiene
--    dónde guardar esa zona: no hay columna en `employees` ni en
--    `legal_entities`, y `salario_minimo_frontera_diario` lleva sembrado desde
--    la 009 SIN UN SOLO LECTOR en todo `src/`. Para el mismo trabajador de
--    arriba, la Zona Libre de la Frontera Norte da 180 × 881.74 = 158 713.20,
--    o sea 45 298.80 más. Este archivo siembra el dato correcto para que exista
--    cuando la zona exista; quien calcula tiene que DECIR con cuál calculó.
--
-- 2. LOS MÍNIMOS PROFESIONALES. La misma resolución fija 61 salarios mínimos
--    profesionales para 2026 (de 316.85 a 705.46). Si el tope del 486 se mide
--    con el profesional del oficio y no con el general, un reportero con 15
--    años y 1 000 diarios cobraría 180 000.00 en vez de 113 414.40 — 66 585.60
--    de diferencia. Qué lectura rige NO se pudo verificar. No se siembra
--    ninguno: es pregunta para el contador, y va con su issue.
-- ============================================================

DO $minimos$
DECLARE
  tocadas integer;
BEGIN
  UPDATE tax_parameters
     SET params = jsonb_set(jsonb_set(params,
           '{salario_minimo_general_diario}',  to_jsonb(315.04::numeric)),
           '{salario_minimo_frontera_diario}', to_jsonb(440.87::numeric))
   WHERE jurisdiction = 'MX'
     AND effective_from >= DATE '2026-01-01'
     AND (params ->> 'salario_minimo_general_diario')::numeric = 278.80;
  GET DIAGNOSTICS tocadas = ROW_COUNT;

  -- Una corrección de dato que no alcanza ninguna fila no puede pasar callada:
  -- es la lección de la 070. Si no había filas de 2026 con el valor viejo, o ya
  -- se corrigió o la siembra tiene otra forma, y en los dos casos conviene que
  -- alguien lo lea.
  IF tocadas = 0 THEN
    RAISE WARNING '074: ninguna ventana de 2026 traía el salario minimo de 2025; no habia nada que corregir';
  ELSE
    RAISE NOTICE '074: salario minimo de 2026 (315.04 general / 440.87 frontera) corregido en % ventana(s)', tocadas;
  END IF;

  -- Y no se deja a medias: si alguna ventana de 2026 sigue con el de 2025, se
  -- detiene la actualización en vez de registrarla como aplicada.
  IF EXISTS (
    SELECT 1 FROM tax_parameters
     WHERE jurisdiction = 'MX'
       AND effective_from >= DATE '2026-01-01'
       AND (params ->> 'salario_minimo_general_diario')::numeric = 278.80
  ) THEN
    RAISE EXCEPTION '074: quedan ventanas de 2026 con el salario minimo de 2025, del que cuelga el tope de la prima de antiguedad';
  END IF;
END
$minimos$;
