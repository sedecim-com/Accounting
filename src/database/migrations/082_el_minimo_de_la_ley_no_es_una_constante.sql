-- ============================================================
-- 082 · LOS DOS MÍNIMOS DE LA LFT QUE EL PANEL NO PUEDE OFRECER BAJAR
--
-- T6 (#93). El panel aceptaba `dias_aguinaldo = 5` y el finiquito pagaba con
-- cinco días, bajo el mínimo de quince del art. 87 LFT. Un piso legal no es
-- criterio del despacho: es la ley, y por eso no se escribe como constante en
-- el catálogo del panel sino aquí, donde la 080 le puso fecha de entrada y
-- fuente obligatoria.
--
-- POR QUÉ UNA MIGRACIÓN Y NO SÓLO EL SEMBRADOR. `legal_parameters` nace VACÍA
-- en toda instalación: su único escritor es `seedLegalParameters`, al que sólo
-- llama `src/database/seed.ts` —el sembrador de demostración—, y el arranque
-- de la suite de integración ejecuta únicamente el migrador. Leer el piso
-- desde el finiquito sin esta migración sería un apagón de POST /finiquito y
-- de la corrida mensual de provisiones en toda base migrada y no sembrada,
-- más la suite entera, por `never_loaded`. La analogía con `tax_parameters`
-- ya está en el árbol: ésas SÍ las siembran las migraciones 009 y 073.
--
-- LA FECHA ES LA DE LA LEY. Las dos fracciones vienen del texto original de la
-- LFT, en vigor el 1 de mayo de 1970. Fecharlas hoy haría que todo finiquito
-- con baja anterior se topara con `not_yet_in_force` y dejara de calcularse.
--
-- Idempotente por el único de la 080 (jurisdiction, key, effective_from).
-- ============================================================

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'aguinaldo.minimum_days', '1970-05-01', '15.0000', 'days',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf',
   'LFT art. 87: aguinaldo anual equivalente a quince días de salario, POR LO MENOS. El mínimo es de la ley; cuántos días paga el despacho por encima es criterio suyo y vive en el panel (dias_aguinaldo).'),
  ('MX', 'vacation_premium.minimum_rate', '1970-05-01', '0.2500', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf',
   'LFT art. 80: prima NO MENOR de veinticinco por ciento sobre los salarios del periodo de vacaciones. Es un mínimo, y el artículo no fija techo: pagar más es una prestación, y va en el panel (prima_vacacional_pct).')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
