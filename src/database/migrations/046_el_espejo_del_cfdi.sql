-- ============================================================
-- 046: EL ESPEJO DEL CFDI — la unicidad fiscal es POR ENTIDAD
--
-- xml_documents.cfdi_uuid nació UNIQUE GLOBAL (005:20) — ni siquiera por
-- inquilino. Eso rompe el caso más normal de un despacho: las DOS partes
-- de la operación son clientes del despacho, y el MISMO XML debe entrar
-- dos veces — el emisor lo registra como 'emitido' (su ingreso) y el
-- receptor como 'recibido' (su gasto). Hoy, dentro del mismo tenant la
-- segunda entidad recibe DuplicateError; entre tenants, RLS esconde la
-- fila al SELECT del dedupe y el INSERT revienta con un 23505 crudo.
-- iva-cash-basis.ts:316 documenta el problema desde hace meses y su
-- lookup ya filtra por entidad; ésta es la única brecha de ESQUEMA
-- POBLADO que cada mes de datos encarece — por eso F02 arranca aquí.
--
-- El cambio solo AFLOJA: toda fila válida bajo el constraint global es
-- válida bajo (entity_id, cfdi_uuid). NO hay backfill de datos — esta
-- migración es inmune al modo de fallo de la 043 (siembra bajo RLS
-- forzada que leyó cero filas); aquí no se lee nada, solo DDL.
--
-- xml_hash recibe el mismo trato y con respaldo de esquema: su unicidad
-- era SOLO de código (el OR del dedupe) y por tanto una carrera. El par
-- (entity_id, xml_hash) la vuelve verdad de base.
-- ============================================================

ALTER TABLE xml_documents DROP CONSTRAINT xml_documents_cfdi_uuid_key;

CREATE UNIQUE INDEX uq_xml_documents_entity_cfdi
    ON xml_documents(entity_id, cfdi_uuid);

CREATE UNIQUE INDEX uq_xml_documents_entity_hash
    ON xml_documents(entity_id, xml_hash);
