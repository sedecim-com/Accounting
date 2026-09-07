-- ============================================================
-- 065 · EL ÍNDICE QUE ACTUALIZA (INPC)
--
-- El INPC —Índice Nacional de Precios al Consumidor— es el prerrequisito
-- declarado de la deducción de inversiones actualizada (LISR art. 31) y de
-- cualquier ajuste anual por inflación. En el árbol hay CERO ocurrencias
-- fuera de la prosa: ni tabla, ni columna de factor, ni cálculo. El catálogo
-- de comandos ya reserva el sustantivo (`inpc import --file`) y lo marca
-- como no hecho.
--
-- LA FORMA LA COPIA DE R4, que resolvió el problema gemelo. El tipo de
-- cambio y el INPC son el mismo tipo de dato: una serie publicada por una
-- autoridad, con fecha de vigencia, que el sistema NO calcula sino consulta,
-- y cuya FUENTE es una decisión (el DOF publica el INPC igual que publica el
-- tipo de cambio). Por eso:
--
--   · Es GLOBAL, sin tenant_id: el índice de un mes es un hecho del país.
--   · La llave incluye el periodo, no la fecha de captura.
--   · Se guarda la BASE del índice. El INEGI ha rebasado la serie varias
--     veces (base 2010=100, base segunda quincena de julio de 2018=100), y
--     un factor calculado con índices de bases distintas es un número sin
--     significado. Es el error clásico de esta cuenta y por eso la base es
--     parte de la fila y no una suposición.
-- ============================================================

CREATE TABLE inpc_serie (
    anio SMALLINT NOT NULL,
    mes SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
    valor DECIMAL(12,6) NOT NULL CHECK (valor > 0),
    -- La base a la que está referido el índice. Dos valores de bases
    -- distintas NO se dividen entre sí.
    base VARCHAR(40) NOT NULL,
    fuente VARCHAR(20) NOT NULL DEFAULT 'dof'
        CHECK (fuente IN ('dof', 'inegi', 'manual')),
    publicado_el DATE,
    capturado_el TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    capturado_por UUID,
    PRIMARY KEY (anio, mes, base)
);

CREATE INDEX idx_inpc_periodo ON inpc_serie(anio, mes);

COMMENT ON TABLE inpc_serie IS
  'La serie mensual del INPC. Global por diseño, como exchange_rates: el índice de un mes es un hecho del país, no del inquilino. Lo que se acota es la escritura.';
COMMENT ON COLUMN inpc_serie.base IS
  'La base del índice (por ejemplo «2018-Jul2=100»). Forma parte de la llave porque el INEGI ha rebasado la serie varias veces, y un factor calculado dividiendo índices de bases distintas es un número sin significado — el error clásico de esta cuenta.';
COMMENT ON COLUMN inpc_serie.fuente IS
  'dof = Diario Oficial (el que rige para efectos fiscales), inegi = la publicación original, manual = capturado a mano. Mismo criterio que exchange_rates.source desde R4.';
