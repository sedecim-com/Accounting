// ============================================================
// EL LÉXICO COMPARTIDO (I1 · issue #143)
//
// UNA SOLA POBLACIÓN Y UN SOLO LÉXICO. El metro (`language:status`, I2) y el
// lint (`house/english-identifiers`, I3) tienen que contar LO MISMO: si cada
// uno trae su propia lista, el número que publica el metro y el que el lint
// pone en rojo divergen, y entonces nadie sabe cuál de los dos miente. Este
// archivo es esa lista, y `tokenize`/`classify` son ese recorrido.
//
// POR QUÉ ESTÁ RECONSTRUIDO Y NO COPIADO. La investigación de 2026-09-06
// documenta una lista curada a mano —1 128 raíces, 226 neutros— en archivos
// `datos/es_sorted.txt` y `datos/neutral_sorted.txt`. Esos archivos NO se
// comprometieron: al fusionarse la investigación entraron los .md y se
// perdieron los datos. El método sí quedó escrito, así que se rehízo con él:
// se extrajeron las declaraciones de `src/`, se tokenizaron, se clasificaron
// contra el diccionario del sistema (web2, 235 976 entradas) y se curaron a
// mano los 2 244 tokens que quedaron fuera. Las cifras son mayores que las de
// la investigación porque el recorrido cubre además miembros de interfaz y
// propiedades, y porque el árbol creció.
//
// LA REGLA QUE GOBIERNA LAS DUDAS, y explica por qué NEUTROS es tan grande:
// un falso positivo manda a una persona a renombrar código que está bien
// escrito, y a la tercera vez esa persona deja de mirar el instrumento; un
// falso negativo deja español sin señalar y lo caza la pasada siguiente. Los
// dos errores no cuestan lo mismo, así que ante la duda: neutro.
// ============================================================

/** Clase de un token, y de ahí la del identificador que lo contiene. */
export type TokenClass = 'es' | 'en' | 'neutral';

/** Clase de un identificador completo. */
export type IdentifierClass = 'es' | 'en' | 'mixed' | 'neutral';

/**
 * RAÍCES ESPAÑOLAS. Un token de aquí, y sin ningún token inglés, hace que el
 * identificador se señale.
 *
 * Incluye las que el diccionario inglés da por buenas —`mayor`, `banco`,
 * `estado`, `asiento`, `cargo`, `folio`, `norma`, `lote`, `clave`, `ruta`—
 * porque ésas son las que se cuelan sin que nadie las mire: la clasificación
 * automática las declara inglesas y el español viaja escondido en ellas.
 */
export const SPANISH_ROOTS: ReadonlySet<string> = new Set([
  'abierta', 'abiertas', 'abierto', 'abiertos', 'abono', 'abonos', 'abr', 'abrir',
  'absoluto', 'accion', 'acciones', 'acentos', 'aceptado', 'aceptara', 'aciertos',
  'acotada', 'acotadas', 'acotado', 'acotar', 'acreditable', 'acreditado', 'acreditar',
  'activa', 'activo', 'activos', 'acto', 'actores', 'actos', 'actuales', 'actualizacion',
  'actualizada', 'acuerdo', 'acuerdos', 'acum', 'acumulacion', 'acumulada', 'acumulado',
  'acumular', 'acuse', 'adaptador', 'admite', 'admitidas', 'admitidos', 'admitir',
  'adoptado', 'adoptados', 'adquisicion', 'advertencia', 'advertencias', 'afirmado',
  'afirmativa', 'afirmativas', 'agente', 'agota', 'agotado', 'agregado', 'agregar',
  'agrupadas', 'agrupador', 'agrupadores', 'aguinaldo', 'aguja', 'ahora', 'ajena', 'ajeno',
  'ajenos', 'ajustado', 'ajustados', 'ajuste', 'ajustes', 'al', 'alcance', 'alcances',
  'alcanza', 'alcanzado', 'alcanzados', 'aleatorio', 'algun', 'alimentan', 'almacenada',
  'alta', 'alternativa', 'alto', 'amarre', 'ambiguos', 'amortizacion', 'anadir',
  'analizador', 'analizar', 'ancho', 'anclaje', 'anidado', 'anio', 'anios', 'aniversario',
  'anota', 'anotar', 'anterior', 'anteriores', 'antes', 'anticipado', 'anticipados',
  // LAS CUATRO ACENTUADAS. Nunca estuvieron en esta lista, y no por olvido:
  // `tokenize` tiraba las letras no ASCII, así que estos tokens no se
  // producían jamás y añadirlos no habría cambiado nada. Con el tokenizador
  // arreglado sí se producen, y son las únicas cuatro que el árbol declara —
  // medido sobre las 28 342 declaraciones de src/, tests/ y scripts/.
  'acompañantes', 'año', 'años', 'señalados',
  'anticipo', 'anticipos', 'antiguedad', 'antiguo', 'anual', 'anuales', 'apagada',
  'apagado', 'apagados', 'aparcado', 'aparcados', 'aparece', 'apariciones', 'apertura',
  'aplastan', 'aplazada', 'aplicable', 'aplicables', 'aplicacion', 'aplicaciones',
  'aplicada', 'aplicadas', 'aplicado', 'aplicados', 'aplicar', 'aplicarse', 'aporte',
  'aprobacion', 'aprobada', 'aprobado', 'aprobador', 'aprobados', 'aprobar', 'apunta',
  'apuntar', 'aqui', 'archivado', 'archivar', 'archivo', 'archivos', 'aritmetica', 'arma',
  'armado', 'armar', 'arnes', 'arranque', 'arrastradas', 'arrastrado', 'arrastre',
  'arreglo', 'arriendo', 'artefacto', 'asiento', 'asientos', 'asignacion', 'asignaciones',
  'asignados', 'asignar', 'asumida', 'atestaciones', 'atestar', 'atributo', 'atributos',
  'audita', 'auditada', 'auditar', 'auditoria', 'ausencia', 'ausente', 'autenticacion',
  'autenticado', 'automatica', 'automaticos', 'autoriza', 'autorizacion', 'autorizado',
  'autorizar', 'auxiliar', 'avisado', 'avisar', 'aviso', 'avisos', 'ayuda', 'baja',
  'bajaron', 'bajo', 'balanza', 'bancaria', 'bancarias', 'banco', 'bancos', 'bandeja',
  'bandera', 'barre', 'barrer', 'barrido', 'barridos', 'barrio', 'bimestral', 'bimestre',
  'bisagra', 'bisiesto', 'blindados', 'blindar', 'bloque', 'bloquea', 'bloqueada',
  'bloqueado', 'bloquean', 'bloqueante', 'bloqueantes', 'bloquear', 'bloques', 'borrado',
  'borrador', 'borradores', 'bruto', 'brutos', 'bucle', 'buscado', 'buscar', 'cabecera',
  'caben', 'cabeza', 'cableado', 'cadena', 'cadenas', 'calculada', 'calculado', 'calcular',
  'calculo', 'calendario', 'calibracion', 'calificada', 'camb', 'cambia', 'cambiados',
  'cambiaria', 'cambiario', 'cambio', 'cambios', 'caminar', 'camino', 'caminos', 'campo',
  'campos', 'cancela', 'cancelacion', 'cancelados', 'candado', 'candidata', 'candidatas',
  'candidato', 'candidatos', 'canonica', 'canonico', 'cantidad', 'capa', 'capacidad',
  'captura', 'capturada', 'capturadas', 'capturado', 'capturados', 'capturo', 'caracter',
  'carga', 'cargada', 'cargadas', 'cargar', 'cargo', 'cargos', 'carpeta', 'casa', 'casada',
  'casilla', 'casillas', 'caso', 'casos', 'catalogo', 'categoria', 'categorias', 'causa',
  'causacion', 'causaciones', 'causado', 'celda', 'celdas', 'censable', 'censada',
  'censadas', 'censar', 'censo', 'centro', 'cerca', 'cero', 'cero1', 'ceros', 'cerrada',
  'cerrado', 'cerrados', 'cerrar', 'certificado', 'cesantia', 'cheque', 'cheques',
  'choques', 'cierre', 'cierres', 'cifra', 'cifrado', 'cifras', 'circulacion', 'claro',
  'clase', 'clases', 'clasificacion', 'clasificado', 'clasificar', 'clausura', 'clave',
  'claves', 'cliente', 'clientes', 'cobertura', 'cobrables', 'cobrado', 'cobrar', 'cobro',
  'cobros', 'codificacion', 'codigo', 'codigos', 'coherente', 'cola', 'colector',
  'colocadas', 'columna', 'columnas', 'coma', 'comando', 'comandos', 'combinar',
  'comentarios', 'comillas', 'comision', 'comisiones', 'como', 'comodin', 'compacta',
  'compactacion', 'comparador', 'comparadores', 'comparar', 'compilar', 'complementos',
  'completa', 'completos', 'componentes', 'compras', 'comprobacion', 'comprobada',
  'comprobados', 'comprobante', 'comprobantes', 'comprobar', 'compuerta', 'comun', 'con',
  'conceder', 'concedidos', 'concepto', 'conceptos', 'conciliacion', 'conciliado',
  'conciliar', 'conciliatoria', 'concordancia', 'condicion', 'condiciones', 'condonacion',
  'condonado', 'conducta', 'conexion', 'confiable', 'confianza', 'confianzas',
  'confirmacion', 'confirmar', 'conflicto', 'conflictos', 'congelada', 'congeladas',
  'congelado', 'congelados', 'congelar', 'conjeturada', 'conocidas', 'conocido',
  'conocidos', 'consecuencia', 'consentimiento', 'consistencia', 'constante', 'constantes',
  'construida', 'construido', 'construir', 'consulta', 'consultada', 'consultado',
  'consultados', 'consultas', 'consumidor', 'consumidores', 'consumidos', 'consumo',
  'consumos', 'contabilidad', 'contabilizable', 'contabilizacion', 'contabilizada',
  'contabilizadas', 'contabilizado', 'contabilizados', 'contabilizar', 'contable',
  'contadas', 'contado', 'contador', 'contadores', 'contar', 'contenido', 'conteo',
  'contestada', 'contexto', 'continuidad', 'contraparte', 'contrapartes', 'contrapartida',
  'contraste', 'contrato', 'contribuyente', 'convencion', 'convenciones', 'convertir',
  'copias', 'correo', 'correr', 'corrida', 'corridas', 'corridos', 'corrieron', 'cortado',
  'corte', 'costo', 'cota', 'cotejable', 'cotejada', 'cotejado', 'cotejar', 'cotejo',
  'cotejos', 'creacion', 'creada', 'creadas', 'creado', 'creador', 'crear', 'crecida',
  'credencial', 'credito', 'creditos', 'criterio', 'criterios', 'cruces', 'cruda',
  'crudas', 'crudo', 'crudos', 'cta', 'ctas', 'cuadra', 'cuadrar', 'cuadre', 'cuales',
  'cuantas', 'cuantos', 'cuatro', 'cubeta', 'cubierto', 'cubiertos', 'cubo', 'cubos',
  'cubre', 'cuenta', 'cuentas', 'cuerpo', 'cuerpos', 'culpables', 'cumplidos', 'cuota',
  'curso', 'cxc', 'cxp', 'dame', 'datos', 'de', 'debe', 'deben', 'debita', 'debito',
  'debitos', 'decidido', 'decididos', 'decidir', 'decimales', 'decisiones', 'declara',
  'declarable', 'declaracion', 'declaraciones', 'declarada', 'declaradas', 'declarado',
  'declarados', 'declaran', 'declarar', 'decodificado', 'decodificar', 'decrecientes',
  'deducciones', 'deducible', 'deducir', 'defecto', 'definen', 'definida', 'definido',
  'del', 'delimitador', 'dentro', 'depositado', 'depositos', 'depreciacion', 'derecho',
  'deriva', 'derivada', 'derivado', 'derivados', 'derivar', 'derivas', 'desactivado',
  'desajuste', 'desaparecidos', 'desaplicacion', 'desaplicado', 'desaplicar',
  'desatendida', 'descarga', 'descargas', 'descendente', 'desconocidas', 'desconocido',
  'desconocidos', 'descontar', 'describir', 'descripcion', 'descuadrada', 'descuadre',
  'descuadres', 'descuento', 'descuentos', 'desde', 'desempate', 'desenlace', 'desglosar',
  'desglose', 'desgloses', 'desnudo', 'despacho', 'desplazamiento', 'desprotegidas',
  'despues', 'destino', 'desviados', 'detallada', 'detalle', 'detalles', 'detectado',
  'detectar', 'detener', 'detenida', 'detras', 'devengado', 'devengar', 'devengo',
  'devolucion', 'dia', 'dia17', 'diagnostico', 'diario', 'dias', 'diccionario', 'dicha',
  'dicho', 'dichos', 'diciembre', 'diez', 'diferencia', 'diferencias', 'digito', 'digitos',
  'dimensiones', 'dinero', 'direccion', 'direcciones', 'directas', 'directo', 'directorio',
  'disco', 'discrepantes', 'disponible', 'disponibles', 'distancia', 'distintas', 'doble',
  'docto', 'documento', 'documentos', 'domicilio', 'dominio', 'donde', 'dos', 'dueno',
  'duplicadas', 'duplicados', 'dura', 'duracion', 'edad', 'edicion', 'editar', 'efectivo',
  'efectivos', 'efecto', 'efectos', 'efimera', 'efimero', 'ejecutar', 'ejecutor',
  'ejemplos', 'ejercicio', 'el', 'elegibles', 'elegida', 'elegido', 'elegidos', 'elegir',
  'elemento', 'elementos', 'eligio', 'emision', 'emisiones', 'emisor', 'emitido',
  'emitidos', 'emitir', 'empaquetar', 'empatadas', 'empatan', 'empleado', 'empleo',
  'encabezado', 'encadenamiento', 'encendido', 'encontrado', 'encontrados', 'ene',
  'enfermedades', 'enlace', 'enmascara', 'enmascarar', 'ensayable', 'ensayar', 'ensayo',
  'entender', 'entendi', 'entero', 'enterradas', 'entidad', 'entidades', 'entorno',
  'entra', 'entrada', 'entradas', 'entran', 'entre', 'entrega', 'entregable', 'entregada',
  'entregadas', 'entregado', 'entregarse', 'entregas', 'enunciado', 'envio', 'envolver',
  'envueltos', 'equivalencia', 'errores', 'escala', 'escalamiento', 'escalamientos',
  'escalar', 'escalon', 'escapar', 'escribe', 'escribible', 'escribir', 'escrito',
  'escritor', 'escritores', 'escritos', 'escritura', 'especie', 'espejo', 'espejos',
  'espera', 'esperada', 'esperadas', 'esperado', 'esperados', 'esquema', 'esquemas',
  'esta', 'estaban', 'estadisticas', 'estado', 'estados', 'estan', 'estandar', 'estatus',
  'este', 'estimado', 'estrategia', 'estrato', 'etiqueta', 'evaluables', 'evaluacion',
  'evaluaciones', 'evaluados', 'evaluar', 'evento', 'eventos', 'exactas', 'exacto',
  'excedente', 'excedente3uma', 'excepto', 'excluidas', 'excluidos', 'exencion', 'exenta',
  'exentas', 'exento', 'exige', 'exigibles', 'exigida', 'exigidos', 'exigir', 'existe',
  'existente', 'existentes', 'existia', 'existian', 'exito', 'explicacion', 'explicado',
  'explicados', 'explicar', 'explicita', 'exploratoria', 'exportacion', 'exportaciones',
  'exportada', 'exportadas', 'exportar', 'expresion', 'extingue', 'extracto', 'extractos',
  'extranjera', 'extranjero', 'fabrica', 'factura', 'facturados', 'facturas', 'falla',
  'fallan', 'fallas', 'fallidos', 'fallo', 'fallos', 'falta', 'faltan', 'faltante',
  'faltantes', 'faltar', 'familia', 'familias', 'fantasmas', 'fecha', 'fechar', 'fechas',
  'ficha', 'fichas', 'fija', 'fijado', 'fijar', 'fijo', 'fila', 'filas', 'filtrar',
  'filtro', 'filtros', 'fin', 'finales', 'financiamiento', 'financiero', 'finiquito',
  'firma', 'firmada', 'firmado', 'firmar', 'firme', 'fiscales', 'fisco', 'flojas',
  'flojos', 'flujo', 'forma', 'formada', 'formateado', 'formatear', 'formato', 'formatos',
  'forzado', 'forzar', 'fraccion', 'frase', 'frecuencia', 'fresca', 'fuente', 'fuentes',
  'fuera', 'fuerte', 'fuga', 'fugas', 'funcion', 'funcional', 'fundamentado', 'fundamento',
  'ganadora', 'garantia', 'garantias', 'gasto', 'gastos', 'generacion', 'generada',
  'generadas', 'generado', 'generar', 'generico', 'graba', 'grabada', 'grande', 'graves',
  'grupo', 'grupos', 'guarda', 'guardado', 'guardas', 'guarderias', 'guardia', 'guardias',
  'guiada', 'guion', 'haber', 'habilidad', 'habria', 'halladas', 'hallado', 'hallazgo',
  'hallazgos', 'hasta', 'hay', 'hecha', 'hecho', 'hechos', 'heredada', 'heredadas',
  'heredado', 'herramientas', 'hija', 'hijas', 'hijo', 'hijos', 'historia', 'historica',
  'historico', 'historicos', 'hoja', 'hojas', 'hoy', 'hueco', 'huecos', 'huella',
  'huerfana', 'huerfanas', 'huerfano', 'huerfanos', 'humana', 'humano', 'icono', 'idas',
  'idempotencia', 'idempotente', 'identidad', 'identifica', 'identificacion',
  'identificador', 'ignora', 'ignorado', 'impar', 'impiden', 'implementada',
  'implementadas', 'implementados', 'importacion', 'importada', 'importadas', 'importado',
  'importar', 'importe', 'importes', 'imprimir', 'impuesto', 'impuestos', 'incluir',
  'incluye', 'incompletas', 'incompleto', 'incomprendida', 'incumplidos', 'indice',
  'indirecto', 'inexistentes', 'inferido', 'inferir', 'infinito', 'informe', 'informes',
  'ingesta', 'ingreso', 'ingresos', 'inicial', 'iniciales', 'inicio', 'inicios', 'inq',
  'inquilino', 'inquilinos', 'insercion', 'insertadas', 'insertados', 'insertar',
  'insistido', 'insoluto', 'instantanea', 'intactos', 'integracion', 'integridad',
  'integro', 'intento', 'intentos', 'interes', 'intereses', 'interno', 'internos',
  'intervencion', 'intrusas', 'intrusos', 'invalidas', 'invalidez', 'invalido',
  'invariante', 'inventario', 'inverso', 'invertida', 'invertir', 'invocacion', 'invocar',
  'jornada', 'jurisdiccion', 'juzgada', 'juzgadas', 'juzgar', 'la', 'lado', 'lados',
  'lanza', 'lanzan', 'largo', 'las', 'lector', 'lectores', 'lectura', 'lecturas', 'lee',
  'leer', 'legibles', 'leible', 'leibles', 'leida', 'leidas', 'leido', 'levantada',
  'levantadas', 'liberable', 'liberadas', 'liberado', 'liberados', 'liberar', 'libre',
  'libro', 'libros', 'ligados', 'ligar', 'limitar', 'limite', 'limites', 'limpia',
  'limpiar', 'limpiar86', 'limpieza', 'limpio', 'linea', 'lineas', 'liquidacion', 'lista',
  'listado', 'listar', 'literales', 'llamada', 'llamadas', 'llamador', 'llamar', 'llano',
  'llave', 'lleva', 'lo', 'longitud', 'lote', 'lotes', 'magnitud', 'mal', 'malos',
  'manejador', 'manejadores', 'manifiesto', 'mano', 'manuales', 'mapa', 'mapeados',
  'mapear', 'mapeo', 'maquina', 'marca', 'marcada', 'marcado', 'marcador', 'marcadores',
  'marcar', 'marcha', 'marco', 'margen', 'mas', 'mascara', 'maternidad', 'maxima',
  'maximo', 'mayor', 'medianoche', 'medias', 'medicos', 'medida', 'medidas', 'medidos',
  'medio', 'medir', 'mejor', 'mejores', 'memoria', 'mencionada', 'mensaje', 'mensajes',
  'mensual', 'mensuales', 'mes', 'meses', 'metadatos', 'metodo', 'metodos', 'metrica',
  'metricas', 'mexicana', 'mexicanas', 'mide', 'miembro', 'miembros', 'mienten',
  'migracion', 'migraciones', 'minimo', 'minimos', 'minusculas', 'mirar', 'misma', 'mismo',
  'mitad', 'modo', 'modos', 'modulos', 'moneda', 'monedas', 'monetario', 'montada',
  'montajes', 'montar', 'monto', 'montos', 'moriria', 'mostrar', 'motivo', 'motivos',
  'movimiento', 'movimientos', 'movs', 'mudo', 'muerden', 'muerta', 'muertas', 'muerte',
  'muerto', 'muestra', 'muestreo', 'mueve', 'murio', 'mutada', 'mutan', 'mutante',
  'mutantes', 'nace', 'nacimiento', 'nacio', 'nacional', 'nacionalidad', 'naturaleza',
  'necesarias', 'necesita', 'negaciones', 'negar', 'negativa', 'negativas', 'negativo',
  'neto', 'neutralizar', 'neutro', 'neutros', 'ninguna', 'nivel', 'niveles', 'nodo',
  'nombra', 'nombradas', 'nombrados', 'nombrar', 'nombre', 'nombres', 'nomina', 'norma',
  'normaliza', 'normalizables', 'normalizado', 'normalizados', 'normalizar', 'nota',
  'notas', 'nuestra', 'nuestro', 'nueva', 'nuevas', 'nuevo', 'nuevos', 'nulo',
  'numeracion', 'numerica', 'numericas', 'numerico', 'numero', 'numeros', 'objetivo',
  'objeto', 'obligatorias', 'obligatorios', 'observada', 'observado', 'obsoletas',
  'obtener', 'obtenido', 'ocultas', 'oculto', 'ocupado', 'ofensor', 'oficial', 'ofrecidas',
  'ofrecidos', 'olfatear', 'olvidar', 'omision', 'omitida', 'omitidas', 'omitido',
  'omitidos', 'omitir', 'opcion', 'opcional', 'opciones', 'operacion', 'operaciones',
  'operador', 'orden', 'ordenadas', 'ordenar', 'origen', 'origenes', 'otra', 'otras',
  'otro', 'otros', 'padre', 'padres', 'pagables', 'pagada', 'pagado', 'pagados', 'pagar',
  'pagina', 'paginar', 'pago', 'pagos', 'pais', 'palabra', 'palabras', 'papel', 'paq',
  'paquete', 'paquetes', 'para', 'parametros', 'parche', 'parcial', 'parciales',
  'parcialidad', 'parentesis', 'pares', 'parseado', 'parsear', 'parseo', 'parte', 'partes',
  'partida', 'partidas', 'partir', 'pasivo', 'pasivos', 'paso', 'pasos', 'patron',
  'patronal', 'pedida', 'pedidas', 'pedido', 'pedidos', 'pendiente', 'pendientes',
  'pensionados', 'peor', 'percepciones', 'perdida', 'perdidas', 'perfil', 'perfiles',
  'periodo', 'periodos', 'permiso', 'permisos', 'permitida', 'permitidas', 'permitido',
  'permitidos', 'permitir', 'persiste', 'persistir', 'peso', 'pesos', 'peticion',
  'pintadas', 'piso', 'planear', 'planes', 'plano', 'poblacion', 'polimorfica', 'politica',
  'politicas', 'poliza', 'polizas', 'ponderado', 'por', 'porcentaje', 'porcion', 'porque',
  'posicion', 'positivo', 'positivos', 'postea', 'posteable', 'posteadas', 'posteado',
  'posteados', 'postear', 'posteo', 'posteriores', 'postura', 'preambulo', 'precedente',
  'precios', 'precondicion', 'predicado', 'preferida', 'prefijo', 'prefijos', 'pregunta',
  'preguntan', 'preguntar', 'preparador', 'preparar', 'presentables', 'presentada',
  'presentar', 'presentes', 'prestaciones', 'prever', 'previa', 'previas', 'previo',
  'previos', 'previsiones', 'previstas', 'previsto', 'previstos', 'previsualizacion',
  'previsualizar', 'prima', 'primarias', 'primer', 'primera', 'primeras', 'primero',
  'privada', 'problemas', 'procede', 'procedencia', 'procesadas', 'proceso', 'produccion',
  'producto', 'productor', 'prohibido', 'prohibidos', 'promedio', 'promesa', 'promovibles',
  'propia', 'propiedades', 'propio', 'propios', 'proponer', 'proporcion', 'proporcional',
  'propuesta', 'propuestas', 'prorrateado', 'prosa', 'protege', 'proteger', 'protegidas',
  'proveedor', 'proveedores', 'provisiones', 'proximo', 'proyeccion', 'proyecta',
  'proyectadas', 'prueba', 'pruebas', 'publica', 'publicado', 'publicados', 'publico',
  'puede', 'puente', 'puerta', 'puertas', 'puesto', 'punto', 'puntos', 'puntuacion',
  'puntuaciones', 'puntuar', 'purga', 'que', 'quedaron', 'quien', 'quinquenios', 'quitar',
  'raices', 'raiz', 'ramas', 'rango', 'rastro', 'razon', 'reabiertas', 'reabiertos',
  'reabrir', 'reaccion', 'reales', 'realizada', 'reanudar', 'recalculo', 'receptor',
  'rechaza', 'rechazadas', 'rechazados', 'rechazar', 'recibido', 'recibidos', 'recibo',
  'recibos', 'reciente', 'recierre', 'reclama', 'reclamadas', 'reclamar',
  'reclasificacion', 'reclasificado', 'reclasificados', 'reclasificar', 'reconocidas',
  'recorrer', 'recortar', 'recorte', 'recta', 'recurso', 'redactado', 'redactar',
  'redondeado', 'redondeo', 'reemplazo', 'referencia', 'referencias', 'refrescar',
  'regimen', 'regimenes', 'registrada', 'registrado', 'registrados', 'registrar',
  'registro', 'registros', 'regla', 'reglas', 'regresados', 'reingreso', 'reiniciar',
  'reintentables', 'reintento', 'relacion', 'relacionado', 'relacionados', 'releida',
  'rellenar', 'relleno', 'remanente', 'remapear', 'remedio', 'remedios', 'remitida',
  'renglon', 'renglones', 'reparacion', 'reparo', 'reparos', 'repartido', 'repartir',
  'reparto', 'repetidas', 'repetido', 'repetidos', 'reporte', 'repositorio',
  'reprocesados', 'reprocesar', 'reproceso', 'reproducibilidad', 'requeridas',
  'requeridos', 'requiere', 'reservados', 'residencia', 'residuo', 'residuos',
  'resolucion', 'resolutor', 'resolutores', 'respaldar', 'respaldo', 'respaldos',
  'responsable', 'respuesta', 'respuestas', 'resta', 'restante', 'restantes',
  'restaurable', 'restauracion', 'restaurada', 'restaurante', 'restaurar', 'restauro',
  'resto', 'restricciones', 'resuelta', 'resueltas', 'resuelto', 'resueltos', 'resultado',
  'resultados', 'resumen', 'resumido', 'resumir', 'retencion', 'retenciones', 'retenido',
  'retenidos', 'retiro', 'reubicados', 'reusada', 'revalidacion', 'reversa', 'reversada',
  'reversadas', 'reversados', 'reversas', 'reverso', 'reversos', 'revisadas', 'revisados',
  'revisor', 'rezagados', 'riesgo', 'riesgos', 'rige', 'rojo', 'rol', 'rota', 'rotas',
  'roto', 'rotulo', 'rubro', 'ruido', 'ruta', 'rutas', 'salario', 'saldo', 'saldos',
  'sale4', 'salida', 'salidas', 'salido', 'saltadas', 'salto', 'salvamento', 'saneado',
  'saneador', 'sanear', 'se', 'seca', 'seccion', 'secreto', 'secuencia', 'segregacion',
  'seguimiento', 'segun', 'segunda', 'segundo', 'segundos', 'seguro', 'seis', 'seleccion',
  'selectores', 'sellada', 'selladas', 'sellado', 'sellar', 'sello', 'sellos', 'sembrada',
  'sembradas', 'sembrado', 'sembrados', 'sembrar', 'senal', 'senaladas', 'senales',
  'sensibles', 'sentido', 'separador', 'separadores', 'sera', 'serializacion',
  'serializador', 'serializar', 'serie', 'servicio', 'servida', 'servidores', 'sesion',
  'sesiones', 'severidad', 'si', 'siembra', 'siete', 'siglo', 'signo', 'siguen',
  'siguiente', 'similitud', 'simulacion', 'simulada', 'simuladas', 'simulado', 'simulados',
  'sin', 'sitio', 'situacion', 'sobran', 'sobrantes', 'sobre', 'sobreescrituras', 'solapa',
  'solicitud', 'solo', 'soltar', 'sombra', 'sombreadas', 'sonda', 'sondas', 'soportado',
  'soporte', 'sospecha', 'sospechas', 'sospechosas', 'sospechoso', 'sospechosos', 'su',
  'subdiario', 'subsidio', 'subtipos', 'sueldos', 'suelo', 'suelos', 'sueltas', 'suelto',
  'sueltos', 'sufijo', 'sugerencia', 'sujeto', 'suma', 'sumar', 'sumas', 'superficie',
  'suplantacion', 'sustitucion', 'sustituir', 'sustituto', 'tabla', 'tablas', 'tamano',
  'tapones', 'tasa', 'tasa0', 'tasa16', 'tasa8', 'tasas', 'techo', 'tecla', 'tenia',
  'teorico', 'tercero', 'terceros', 'terminado', 'termino', 'terminos', 'terna',
  'tesoreria', 'texto', 'tiene', 'timbrado', 'timbrar', 'timbre', 'tipo', 'tipos',
  'titular', 'titulo', 'toca', 'tocados', 'tocan', 'todas', 'todos', 'tokenizar',
  'tolerancia', 'topado', 'tope', 'topes', 'totales', 'trabajador', 'trabajadores',
  'trabajados', 'trabajo', 'trabajos', 'traducible', 'traducir', 'trae', 'tramite',
  'tramo', 'transaccion', 'transaccional', 'transacciones', 'transferencia', 'transito',
  'transporte', 'tras', 'trasladado', 'trasladado16', 'trasladado8', 'trasladados',
  'traslado', 'traslados', 'traslape', 'traslapes', 'tratamiento', 'trato', 'traza',
  'tres', 'trocear', 'trozos', 'truncado', 'ubicacion', 'ubicar', 'ultima', 'ultimo',
  'ultimos4', 'umbral', 'umbrales', 'una', 'unica', 'unicas', 'unico', 'unidad',
  'unidades', 'unitaria', 'unitario', 'uno', 'usada', 'usado', 'usados', 'usarlo', 'uso',
  'usos', 'usuario', 'usuarios', 'utiles', 'utilidad', 'utilidades', 'vacacional',
  'vacaciones', 'vacia', 'vacio', 'vacios', 'valida', 'validacion', 'validado',
  'validador', 'validar', 'validas', 'valido', 'validos', 'valor', 'valores', 'valvula',
  'varados', 'variacion', 'veces', 'vecino', 'vecinos', 'vejez', 'vencidas', 'vencido',
  'vencidos', 'venia', 'ventana', 'ventanas', 'ventas', 'verbo', 'verbos', 'verdes',
  'veredicto', 'veredictos', 'verificable', 'verificacion', 'verificaciones', 'verificado',
  'verificador', 'verificar', 'vida', 'vieja', 'viejo', 'viejos', 'vigencia', 'vigencias',
  'vigente', 'vigentes', 'vigiladas', 'vigilado', 'vio', 'violacion', 'violaciones',
  'visibles', 'vista', 'vistas', 'vistos', 'viva', 'vivas', 'vivo', 'vivos', 'vocabulario',
  'vocabularios', 'volcado', 'volcar', 'volteado', 'ya',
  'natur',
  'folio',
]);

/**
 * NEUTROS. No distinguen idioma, así que NUNCA señalan.
 *
 * Cuatro familias: acrónimos de dominio y de ley (cfdi, rfc, iva, imss, sat,
 * diot, nif, fica, futa), abreviaturas técnicas (id, uuid, ctx, json, sql,
 * deps, opts), marcas y nombres propios (redis, stripe, postgres, sovos), y
 * las palabras que se escriben igual en los dos idiomas —sea porque lo son
 * (`error`, `base`, `total`, `fiscal`, `control`, `final`) o porque coinciden
 * al quitar el acento (`decision`, `version`, `region`, `provision`)—.
 *
 * También caen aquí los TROZOS que la tokenización produce y que no son
 * palabras de ningún idioma (`emis`, `undep`, `ots`): señalar un fragmento es
 * señalar un accidente del recorrido, no una decisión de quien escribió.
 */
export const NEUTRAL_TOKENS: ReadonlySet<string> = new Set([
  '12a', '401k', '5a', '5c', '5d', 'a', 'aba', 'acc', 'acct', 'ach', 'addr', 'adj', 'agg',
  'ago', 'agrup', 'alg', 'algo', 'alloc', 'amt', 'anexo24', 'ant', 'anthropic', 'ap',
  'api', 'aplic', 'apollo', 'app', 'apps', 'ar', 'arap', 'arg', 'args', 'argv', 'art',
  'asn1', 'async', 'auth', 'aux', 'avg', 'aws', 'bal', 'ban', 'banorte', 'banxico', 'base',
  'base64', 'base64url', 'bases', 'bbva', 'bcc', 'bcrypt', 'belvo', 'benef', 'bf',
  'bitcoin', 'blockchain', 'bom', 'box1', 'box12a', 'box14', 'box16', 'box3', 'bs', 'btc',
  'buf', 'bytes', 'ca', 'calc', 'camt053', 'camt53', 'canon', 'cap', 'capital', 'cc',
  'ccpa', 'ccy', 'cdn', 'ce', 'cer', 'cert', 'certif', 'cf', 'cfd', 'cfdi', 'cfdis', 'cfg',
  'ch', 'ci', 'clabe', 'clas', 'cli', 'cloudsql', 'cm', 'cmd', 'cnt', 'coa', 'cod',
  'codagrup', 'code3', 'coincide', 'col', 'color', 'cols', 'combustible', 'compactable',
  'compat', 'cond', 'conekta', 'conf', 'config', 'configs', 'cons', 'cont', 'contalink',
  'contra', 'control', 'conv', 'conversion', 'copilot', 'cov', 'cp', 'cr', 'cred', 'creds',
  'cron', 'cru', 'crunchy', 'crypto', 'cs', 'csp', 'csv', 'ctrl', 'ctx', 'curp', 'cust',
  'cwd', 'cx', 'd1a', 'dashscope', 'db', 'dd', 'ddmmyyyy', 'dec', 'decision', 'decl',
  'def', 'defs', 'deps', 'des', 'desc', 'dest', 'det', 'diag', 'diagonal', 'dic', 'dif',
  'diff', 'dim', 'diot', 'dir', 'dirs', 'disc', 'doctor', 'dof', 'dow', 'dr', 'drs', 'du',
  'ecb', 'edicom', 'editable', 'ee', 'efirma', 'efos', 'efw2', 'ein', 'elasticsearch',
  'emis', 'emp', 'en', 'enc', 'ent', 'enum', 'env', 'eq', 'er', 'error', 'es', 'esc',
  'est', 'etag', 'evaluable', 'evm', 'evs', 'exfil', 'exp', 'expr', 'ext', 'f01', 'f02',
  'f03', 'f04', 'f05a', 'f05b', 'f05c', 'f05d', 'f06a', 'f06b', 'f06c', 'f07a', 'f07b',
  'f07c', 'f08a', 'factor', 'favor', 'feb', 'federal', 'fica', 'final', 'finkok', 'fintoc',
  'fiscal', 'fk', 'fm', 'fmt', 'fmw', 'fn', 'fns', 'form940', 'form941', 'formula', 'frac',
  'freq', 'futa', 'fv', 'fx', 'fy', 'g0', 'g1a', 'g1b', 'g4a', 'g4b', 'gaap', 'gas',
  'gemini', 'general', 'gl', 'graphql', 'grave', 'grok', 'gwei', 'hermes', 'hhmm', 'hs',
  'hsa', 'html', 'http', 'ia', 'iat', 'iban', 'iden', 'idp', 'idse', 'idx', 'ieps',
  'iface', 'ifrs', 'imp', 'impl', 'imss', 'inf', 'info', 'infonavit', 'ing', 'ini', 'init',
  'inpc', 'int', 'inv', 'inversion', 'ip', 'is1099', 'isn', 'iso', 'iso2', 'isr', 'iv',
  // `iva0`, `iva8` e `iva16` estaban aquí como parche del corte letra↔dígito
  // que `tokenize` prometía y no hacía. Con el corte puesto, ese token no se
  // puede producir: `iva16` da ['iva','16']. Se retiran para que la lista no
  // guarde entradas inalcanzables — que es como una lista deja de leerse.
  'iva', 'jaccard', 'je', 'jel', 'json', 'jul', 'jun', 'juris',
  'jwks', 'jwt', 'kase', 'kms', 'ku', 'lang', 'lateral', 'lc', 'lcs', 'legal', 'legible',
  'len', 'lev', 'levenshtein', 'lisr', 'llm', 'loc', 'local', 'locales', 'macrs', 'manual',
  'mar', 'mate', 'material', 'may', 'mb', 'med', 'media', 'medicare', 'mem', 'menu',
  'merkle', 'met', 'mexico', 'mig', 'migs', 'miles', 'millis', 'minimax', 'mm',
  'mnemosine', 'mod', 'motor', 'mov', 'msg', 'mt940', 'multi', 'mv', 'mx', 'mxn', 'nacha',
  'nal', 'natural', 'nb', 'ndjson', 'neon', 'nif', 'no', 'norm', 'norm1', 'norm2',
  'normal', 'nous', 'nov', 'ns', 'nss', 'num', 'o', 'oa', 'obj', 'oct', 'odfi', 'oidc',
  'ollama', 'op', 'openai', 'openapi', 'openclaw', 'openrouter', 'ops', 'org', 'ori',
  'original', 'ots', 'p95', 'pac', 'padded', 'panel', 'par', 'pas', 'pc', 'pct', 'pdf',
  'pedersen', 'pem', 'personal', 'pg', 'pkce', 'plaid', 'plan', 'po', 'pol', 'posterior',
  'ppd', 'ppy', 'pr', 'pre', 'pref', 'prefs', 'prev', 'prevision', 'principal', 'priv',
  'prod', 'prov', 'provision', 'pue', 'q1', 'q2', 'q3', 'q4', 'ql', 'qs', 'qty', 'qwen',
  'r2', 'r4', 'ra', 'rc', 'rds', 'reachcore', 'real', 'rec', 'red', 'redis', 'reg',
  'regex', 'regexp', 'region', 'regs', 'rels', 'rep', 'req', 'res', 'residual', 'resolver',
  'resp', 'ret', 'revision', 'rf', 'rfc', 'ri', 'rl', 'rls', 'rolbypassrls', 'rolcanlogin',
  'rolcreaterole', 'rolsuper', 'round2', 'rp', 'rpc', 'rt', 'rw', 's3', 'sale',
  'santander', 'sapien', 'sat', 'satoshis', 'sbc', 'sc', 'sched', 'sdi', 'sel', 'sensible',
  'sep', 'seq', 'serial', 'serv', 'sha256', 'sim', 'sit', 'smg', 'soap', 'social', 'sod',
  'son', 'sovos', 'spei', 'sql', 'src', 'srv', 'ss', 'ssh', 'ssl', 'sslmode', 'ssn',
  'stat', 'stats', 'stderr', 'stdin', 'stdio', 'stdout', 'str', 'stripe', 'sua',
  'supabase', 'supp', 'suta', 'sv', 'svc', 'sw', 'swift', 'tb', 'tc', 'tfd', 'tip', 'todo',
  'tok', 'total', 'tp', 'ttl', 'tty', 'tx', 'txid', 'txt', 'uat', 'uma', 'un', 'undep',
  'unicode', 'union', 'upd', 'url', 'urls', 'usa', 'usd', 'utc', 'utf8', 'util', 'uuid',
  'uuids', 'v1', 'val', 'var', 'vars', 'vat', 'vb', 'ver', 'version', 'w2', 'w2s', 'w3',
  'w4', 'wh', 'whoami', 'xai', 'xml', 'xml10', 'xmlns', 'xmls', 'xsd', 'xsi', 'y', 'ytd',
  'yy', 'yymmdd', 'zk', 'zkverify', 'zod', 'zsh',
  'alias', 'balance', 'cache', 'decimal', 'decimales', 'express', 'props', 'roles',
  'max', 'min',
]);

/**
 * INGLESAS QUE EL DICCIONARIO NO TRAE. web2 es de 1913 y le faltan
 * participios regulares y vocabulario técnico moderno, así que sin esta lista
 * `parsed`, `mapped`, `webhook` o `payload` se señalarían como españolas.
 */
export const ENGLISH_EXTRA: ReadonlySet<string> = new Set([
  'accum', 'accumulated', 'addl', 'aggregated', 'allocated', 'allowlist', 'amortized',
  'approved', 'approx', 'attributed', 'backend', 'backoff', 'banned', 'box', 'box12',
  'box18', 'box5', 'builtin', 'byline', 'cached', 'callbacks', 'cancelled', 'capitalized',
  'cashflow', 'catalog', 'catalogs', 'categorized', 'charged', 'checklist', 'classify',
  'closing', 'collapsed', 'committed', 'competing', 'completed', 'computed', 'configured',
  'cooldown', 'cooldowns', 'counterparty', 'database', 'declining', 'decrypt', 'decrypted',
  'dedupe', 'deleted', 'denied', 'deserialize', 'download', 'dropped', 'dunning',
  'duplicated', 'email', 'emails', 'enabled', 'encoding', 'endpoint', 'enqueue',
  'escalation', 'escaped', 'estimated', 'evaluated', 'executing', 'failover', 'filename',
  'financing', 'flagged', 'formatted', 'frontmatter', 'generated', 'globs', 'group1',
  'group2', 'having', 'idempotency', 'inbox', 'inferred', 'inline', 'issued', 'keychain',
  'keywords', 'keywords1', 'keywords2', 'last4', 'limits2026', 'line1', 'line2',
  'livemode', 'logout', 'loopback', 'mapped', 'mapping', 'mappings', 'merged', 'messaging',
  'metadata', 'middleware', 'modified', 'negated', 'neutralized', 'nonqualified',
  'normalized', 'numeric', 'oldest', 'omitted', 'onboard', 'onboarding', 'over7k', 'paid',
  'parsed', 'paycheck', 'paychecks', 'payload', 'payloads', 'prepaid', 'pretax',
  'proposed', 'quarantined', 'queryable', 'queued', 'reclassified', 'recognized',
  'reconciled', 'released', 'required', 'restaurant', 'result2', 'retried', 'retrofit',
  'retryable', 'revoked', 'sanitized', 'scanned', 'scheduled', 'scoped', 'serialized',
  'simulated', 'skipped', 'soonest', 'stored', 'stringify', 'subcommands', 'subdomain',
  'subledger', 'superseded', 'tagline', 'terminated', 'timeout', 'timeouts', 'timestamp',
  'transmitted', 'trimmed', 'unapplication', 'unapply', 'uncached', 'unrecon', 'updatable',
  'updated', 'upsert', 'username', 'validated', 'verified', 'webhook', 'webhooks',
  'website', 'wordmark',
]);

/**
 * TÉRMINOS DE DOMINIO QUE SE QUEDAN EN ESPAÑOL. Nace VACÍA, y esto no es un
 * descuido: es la puerta por la que se escapa un plan de traducción.
 *
 * La tentación, cuando un renombrado cuesta, es declarar la palabra «término
 * de dominio» y seguir. Por eso la lista empieza vacía y **cada entrada
 * futura tiene que traer su razón escrita al lado** —no «es de dominio», sino
 * qué se rompe si se traduce: un catálogo externo que casa por nombre, un
 * contrato publicado, una columna que un tercero lee—. Un término aquí sin
 * esa frase es una excepción sin dueño.
 */
export const DOMAIN_TERMS: ReadonlyMap<string, string> = new Map([]);

/**
 * Parte un identificador en tokens: camelCase, PascalCase, snake_case,
 * SCREAMING_CASE, kebab-case y las fronteras con dígitos. Todo a minúsculas.
 *
 * `RFCValido` da ['rfc', 'valido'] y no ['rfcvalido']: la regla de la sigla
 * seguida de palabra —`([A-Z]+)([A-Z][a-z])`— es la que hace que un acrónimo
 * pegado a una palabra española no esconda a la española.
 */
export function tokenize(identifier: string): string[] {
  const conEspacios = identifier
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1 $2')
    // LA FRONTERA LETRA↔DÍGITO, que este docstring prometía y el código no
    // hacía. `tasa8` daba un solo token que no está en ninguna lista, y un
    // token desconocido de más de dos letras se clasifica INGLÉS: el nombre
    // más español posible salía inglés. Se ve en el léxico mismo, donde
    // alguien tuvo que añadir `iva0`, `iva8` e `iva16` como neutros — parches
    // del corte que faltaba.
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2');
  return conEspacios
    // `\p{L}` y no `A-Za-z`: partir por «todo lo que no sea ASCII» tiraba los
    // acentos y la eñe, y el residuo no casaba con ninguna raíz. `diseño` daba
    // ['dise','o'] y se clasificaba INGLÉS; `añoFiscal` daba ['a','o','fiscal']
    // y salía neutro. El sesgo caía justo sobre los nombres MÁS españoles del
    // árbol, y siempre en la dirección que halaga: menos español del que hay.
    .split(/[^\p{L}\p{N}]+|\s+/u)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

/**
 * La clase de UN token, con precedencia estricta: español gana a neutro, y
 * neutro gana a inglés. El orden importa —`estado` está en el diccionario
 * inglés y aun así es español aquí— y por eso la lista española se consulta
 * primero.
 */
export function classifyToken(token: string): TokenClass {
  if (SPANISH_ROOTS.has(token)) return 'es';
  if (NEUTRAL_TOKENS.has(token)) return 'neutral';
  if (ENGLISH_EXTRA.has(token)) return 'en';
  if (/^[0-9]+$/.test(token)) return 'neutral';
  // EXENCIÓN ESCRITA: dos letras o menos no dicen de qué idioma son. `id`,
  // `ok`, `db`, `mx`, `js` — señalarlas sería ruido puro.
  if (token.length <= 2) return 'neutral';
  return 'en';
}

/**
 * La clase de un IDENTIFICADOR a partir de sus tokens:
 *   ≥1 español y 0 inglés → es · ≥1 inglés y 0 español → en
 *   los dos → mixed · sólo neutros → neutral
 *
 * `mixed` no es un estado intermedio benigno: `calcularBalance` está a medio
 * traducir, que suele ser peor que estar entero en un idioma, porque el
 * siguiente que lo lea no sabrá cuál de las dos mitades es la convención.
 */
export function classify(identifier: string): IdentifierClass {
  const tokens = tokenize(identifier);
  if (tokens.length === 0) return 'neutral';
  let es = false;
  let en = false;
  for (const t of tokens) {
    if (DOMAIN_TERMS.has(t)) continue;
    const c = classifyToken(t);
    if (c === 'es') es = true;
    else if (c === 'en') en = true;
  }
  if (es && en) return 'mixed';
  if (es) return 'es';
  if (en) return 'en';
  return 'neutral';
}

/**
 * LO QUE ESTE LÉXICO NO PUEDE VER, medido y no supuesto.
 *
 * Sobre las 200 declaraciones etiquetadas a mano (tests/language/muestra200.tsv)
 * acierta 198. Los dos fallos no son tokens que falten: son las dos cosas que
 * una lista de palabras no alcanza, y conviene que estén escritas para que
 * nadie las persiga con más entradas.
 *
 *   · LA ABREVIATURA SE JUZGA POR SÍ MISMA, no por la palabra que abrevia.
 *     `infEr` es inglés —`inf` de INFONAVIT más `er` de employer— y aquí sale
 *     neutro, porque ninguno de sus dos trozos dice idioma. Juzgar por la
 *     palabra abreviada exigiría un diccionario de abreviaturas del proyecto,
 *     y ése es un instrumento distinto.
 *
 *   · LA POSICIÓN NO SE MIRA. `resolverRouting` es mixto —`resolver` es el
 *     verbo español— y `makeEntityResolver` es inglés puro, con el MISMO
 *     token: en uno es verbo español y en otro sustantivo inglés. Para
 *     distinguirlos hace falta la posición en el nombre, no la lista.
 *
 * Y una tercera que la muestra enseñó sin llegar a fallar: el ORDEN DE LAS
 * PALABRAS delata el idioma cuando los tokens no. `final_balance` convive con
 * `beginning_balance` y es inglés; `jsonOriginal` se lee «el json original» y
 * es español. Los dos salen neutros, que es lo correcto para un instrumento
 * que mide tokens: si algún día alguien quiere esa señal, es sintaxis y va en
 * otra capa.
 */
/** ¿Este identificador se señala? Español entero o a medias, las dos cosas. */
export function isFlagged(identifier: string): boolean {
  const c = classify(identifier);
  return c === 'es' || c === 'mixed';
}
