-- ============================================================
-- 064 · LA PÓLIZA Y SU RASTRO DE PAGO (F07d)
--
-- El XML de pólizas del Anexo 24 no se conforma con el asiento: cuando la
-- póliza mueve dinero, exige DENTRO de ella el rastro del pago —cuenta
-- origen, banco origen, cuenta destino, banco destino, número de cheque,
-- fecha, beneficiario y RFC—. Es lo que permite a la autoridad seguir una
-- deducción hasta el banco.
--
-- El estado de partida, verificado:
--
--   · LO QUE F05 SÍ DEJÓ: `bank_accounts.sat_bank_code` (051:99), con un
--     comentario que cita el Anexo 24 palabra por palabra, más la CLABE
--     cifrada y sus últimos cuatro. Eso cubre CtaOri y BancoOriNal.
--   · EL NÚMERO DE CHEQUE ES UNA COLUMNA QUE SE LEE Y NADIE ESCRIBE.
--     `vendor_payments.check_number` y `customer_payments.check_number`
--     existen desde la 002 (:124 y :288) y treasury-posting las LEE en tres
--     sitios, pero el único INSERT del servicio de pagos omite la columna y
--     `payment create` no ofrece bandera para capturarla. Es capacidad
--     huérfana al revés: no es que nadie la lea, es que nadie la escribe.
--     Eso no necesita migración: necesita escritor, y es del tramo.
--   · LA CUENTA DESTINO NO EXISTE. Para una transferencia, el Anexo 24 pide
--     a DÓNDE fue el dinero, y de eso no hay ni columna. Es lo que esta
--     migración añade.
-- ============================================================

-- ── 1. A DÓNDE FUE EL DINERO ────────────────────────────────────────────
--
-- Se guarda en el PAGO y no en el proveedor, aunque el proveedor suela
-- repetir cuenta: el Anexo 24 declara la cuenta de ESE movimiento, y una
-- póliza de hace tres años tiene que seguir diciendo a dónde fue entonces,
-- no a dónde iría hoy. Un dato que se lee del maestro cambia con el maestro.
ALTER TABLE vendor_payments
    ADD COLUMN cuenta_destino VARCHAR(50),
    ADD COLUMN banco_destino_sat VARCHAR(3),
    -- Para el banco extranjero el Anexo 24 pide el nombre, no la clave.
    ADD COLUMN banco_destino_extranjero VARCHAR(150);

ALTER TABLE customer_payments
    ADD COLUMN cuenta_destino VARCHAR(50),
    ADD COLUMN banco_destino_sat VARCHAR(3),
    ADD COLUMN banco_destino_extranjero VARCHAR(150);

COMMENT ON COLUMN vendor_payments.cuenta_destino IS
  'La cuenta que RECIBIÓ el dinero, para el nodo de pago de la póliza (Anexo 24). Vive en el pago y no en el proveedor porque la póliza declara la cuenta de ESE movimiento: leerla del maestro haría que una póliza vieja cambiara de respuesta al cambiar los datos del proveedor.';
COMMENT ON COLUMN vendor_payments.banco_destino_sat IS
  'Clave de banco del catálogo c_Banco para la cuenta destino nacional. Su hermana de ORIGEN vive en bank_accounts.sat_bank_code desde la 051.';
COMMENT ON COLUMN vendor_payments.banco_destino_extranjero IS
  'Nombre del banco extranjero receptor. El Anexo 24 pide clave para el nacional y NOMBRE para el extranjero: son dos campos distintos y no uno con dos usos.';

-- Nacional o extranjero, no los dos: declarar la clave del catálogo y además
-- un nombre de banco extranjero es decir dos cosas incompatibles sobre el
-- mismo movimiento, y el archivo lo lleva tal cual a la autoridad.
ALTER TABLE vendor_payments
    ADD CONSTRAINT banco_destino_nacional_o_extranjero
        CHECK (banco_destino_sat IS NULL OR banco_destino_extranjero IS NULL);
ALTER TABLE customer_payments
    ADD CONSTRAINT banco_destino_nacional_o_extranjero_cobro
        CHECK (banco_destino_sat IS NULL OR banco_destino_extranjero IS NULL);

-- ── 2. EL CATÁLOGO DE BANCOS DEL SAT ────────────────────────────────────
--
-- `sat_bank_code` lleva desde la 051 siendo una cadena de tres caracteres que
-- nadie valida contra nada. El c_Banco es un catálogo publicado, igual que el
-- c_CodAgrup que la 060 trajo, y con el mismo problema: sin la lista, validar
-- es comparar contra la nada. Global por diseño.
CREATE TABLE sat_bancos (
    clave VARCHAR(3) PRIMARY KEY,
    nombre_corto VARCHAR(100) NOT NULL,
    razon_social VARCHAR(255),
    vigente BOOLEAN NOT NULL DEFAULT true
);

COMMENT ON TABLE sat_bancos IS
  'El catálogo c_Banco del Anexo 24. Global: es un hecho publicado por la autoridad. La clave 999 es la que el catálogo reserva para el banco extranjero.';
