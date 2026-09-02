# mnemosine

Un sistema contable mexicano que se opera desde la terminal. Lleva partida doble sobre PostgreSQL —catálogo, pólizas, clientes y proveedores, bancos, periodos, reportes— con el cumplimiento fiscal mexicano dentro del motor y no encima de él: CFDI 4.0, catálogos del SAT, IVA sobre base de flujo.

**Para quién es.** Para un despacho contable mexicano que lleva varios clientes en la misma instalación, y para el contador independiente que lleva los suyos. Da por hecho que quien lo usa sabe contabilidad: mnemosine no explica qué es una póliza, la propone y espera que alguien la juzgue.

**Qué lo distingue.** No que un modelo hable de contabilidad. Que el modelo **no puede escribir**. La IA nunca postea al mayor ni toca un sistema externo por su cuenta: propone en dos tiempos —`ai_drafts` para los asientos, `ai_external_ops` para todo lo que sale al mundo (timbrar, enviar, pagar)— y una persona aprueba. La aprobación es un registro con integridad, no una bandera.

Y los límites de eso no viven en el prompt ni en un archivo de configuración: viven en código, en [`src/ai/floor.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/floor.ts), y se combinan con la configuración usando `Math.min` —nunca `Math.max`—, de modo que ninguna política guardada, bandera de línea de comandos ni regla futura de «aprobar siempre» puede subirlos. Un asiento por encima del tope se queda esperando a un humano aunque el archivo del despacho diga lo contrario.

El repositorio se llama `Accounting` y el paquete `accounting-core` por su origen: un servidor REST/GraphQL. Ese motor sigue vivo y es el que el agente opera, pero el producto es el CLI.

Si lo que buscas es «qué es esto y cómo arranco en cinco minutos», eso está en el [README](https://github.com/sedecim-com/Accounting/blob/main/README.md). Esta wiki responde la otra pregunta: cómo funciona por dentro y por qué se decidió así.

---

## El mapa

### Quiero llevar contabilidad con esto

El **[[Manual-de-usuario]]** está organizado por tareas, no por comandos: entra por lo
que quieres lograr. Dice con exactitud lo que hoy se puede teclear y lo que no —un manual
que promete un paso inexistente es peor que no tener manual—.

- **[[Manual-Primer-cliente]]** — de la nada al primer asiento contabilizado.
- **[[Manual-El-dia-a-dia]]** — recibir CFDI, revisar lo que propuso la IA, capturar, cobrar y pagar.
- **[[Manual-Cobrar-y-pagar]]** — los ciclos de clientes y proveedores, con el REP donde toca.
- **[[Manual-Bancos-y-conciliacion]]** — hasta dónde llega hoy la conciliación, y dónde se acaba.
- **[[Manual-El-cierre-de-mes]]** — la lista de verificación, el cierre suave y el duro.
- **[[Manual-Trabajar-con-el-agente]]** — revisar, corregir, enseñar, y qué cuesta.
- **[[Manual-Reportes-y-entregables]]** — lo que el despacho le entrega a su cliente.

### Quiero usarlo

- **[[Puesta-en-marcha]]** — la instalación completa y cuidadosa: requisitos reales, el `.env` variable por variable, los dos roles de base, migraciones, siembra y el primer ciclo de trabajo.
- **[[Catalogo-de-comandos]]** — qué se puede teclear hoy, contra la superficie de comandos a la que se aspira. Las dos cifras salen del propio binario, nunca de la memoria de nadie.
- **[[Proveedores-de-modelo]]** — cómo elegir el motor del agente, incluidos los locales sin llave de API, y por qué los secretos jamás viven en el archivo de configuración.
- **[[Solucion-de-problemas]]** — los fallos que de verdad ocurren, y qué comprobación de `doctor` los nombra.

### Quiero entender cómo funciona

- **[[Arquitectura]]** — las capas de fuera hacia dentro, y por qué toda escritura física al mayor pasa por un único módulo.
- **[[El-agente-y-sus-limites]]** — el maker-checker, las dos bandejas de propuesta, el suelo inamovible y qué hace un trabajo desatendido cuando no hay nadie mirando.
- **[[Aislamiento-multi-inquilino]]** — *row-level security* de PostgreSQL, no un `WHERE` en TypeScript. Por qué la frontera de entidad devuelve 404 y nunca 403.
- **[[Fiscal-mexicano]]** — CFDI 4.0, IVA sobre base de flujo (PUE contra PPD, y el REP que las reconcilia), e.firma y CSD, timbrado.
- **[[Base-de-datos-y-migraciones]]** — la cadena de migraciones, los cuatro duplicados históricos que no se pueden renumerar, y por qué las políticas de RLS se reaplican después de cada corrida.
- **[[Seguridad-y-credenciales]]** — la bóveda cifrada, la bitácora de accesos, y por qué el proceso se niega a arrancar en producción con los secretos del repositorio.
- **[[Glosario]]** — RFC, CFDI, PUE, PPD, REP, CSD, inquilino, entidad. En ese orden de necesidad.

### Hacia dónde va

Investigación con ligas verificadas (2026-09-02) y la dirección que tomaría cada frente. Son
mapas de conexión y diseño, no capacidades: el lector no sale de aquí creyendo que ya puede
conectar WhatsApp.

- **[[Conectores-PAC]]** — los proveedores de timbrado investigados, la regla de custodia y el plan de precarga.
- **[[Onboarding-de-contabilidad]]** — traer una contabilidad existente: el XML del SAT como formato universal.
- **[[El-tablero-grafico]]** — la interfaz gráfica como gateway sobre la misma API, jamás un tercer motor.
- **[[Canales-de-mensajeria]]** — WhatsApp, Telegram y correo como adaptadores con humano en la salida.
- **[[La-contabilidad-como-centro]]** — experimental: cuentas públicas atestadas, subcuentas privadas.

### Quiero saber en qué estado está

- **[[El-tablero-y-los-criterios]]** — el estado no se escribe: se pregunta. Cómo funcionan los criterios ejecutables y por qué un paquete con nueve verdes y un rojo está abierto, no «casi cerrado».
- **[[Auditorias]]** — los lentes que se han pasado sobre el árbol y lo que encontraron, incluidos los falsos verdes del propio instrumento.
- **[[Hoja-de-ruta]]** — qué falta, en qué orden, y qué se declaró deliberadamente fuera del compromiso.

### Quiero contribuir

- **[[Como-contribuir]]** — un PR por idea, los invariantes de la casa y por qué los mensajes de commit explican el porqué y no el diff.
- **[[Pruebas-y-CI]]** — las puertas que hay que pasar, por qué la suite de integración crea y destruye una base por corrida, y por qué el job de aislamiento conecta a propósito como un rol sin privilegios.

---

## Cuánto de esto existe

Dos medidores, cero copias a mano. Los números de esta wiki que no vengan de uno de ellos hay que sospecharlos.

```bash
npm run plan:status
```

Evalúa criterios ejecutables ([`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts)) contra el árbol y decide el estado de cada paquete de trabajo; para los que no cierran, imprime la razón exacta del rojo. Hoy hay 70 criterios y 9 de 15 paquetes en verde. La CI corre `plan:status --exigir=...` sobre los ya cerrados: es un trinquete contra el retroceso, no un informe.

```bash
npm run catalogo:estado
```

Recorre el árbol del binario y escribe el bloque de estado de [`docs/cli-command-catalog.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/cli-command-catalog.md); la CI verifica con `--check` que no esté desfasado. Hoy: 134 comandos en 45 familias de primer nivel, que cubren 119 de las 1624 filas del catálogo (7,3 %) y 108 de las 379 filas de fase 1 —las que hacen falta para llevar una contabilidad completa desde el CLI—.

Ambos existen porque la versión anterior de cada cifra estaba escrita a mano y se desincronizó justo cuando el trabajo avanzaba, que es cuando más se le consulta.

---

## Lo que todavía no es lo que parece

Se dice aquí, en la portada, porque descubrirlo leyendo el código sería peor.

- **La atestación en blockchain está simulada.** Todos los adaptadores de cadena declaran `simulado = true` ([`chain-adapters.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/blockchain/chain-adapters.ts), [`zkverify-client.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/blockchain/zkverify-client.ts)): no hay transacción en ninguna red. Por eso la verificación pública está apagada por omisión —se enciende con `PUBLIC_VERIFICATION_ENABLED=true`— y, aun encendida, cada endpoint se niega a servir una fila simulada. Un anclaje simulado no se presenta como prueba de nada.
- **La descarga masiva del SAT no existe.** Ni cliente SOAP (`SolicitaDescarga` / `VerificaSolicitud`), ni lector de paquetes ZIP, ni comando `sat download`. La familia `sat` de hoy administra credenciales (`cred add`, `status`, `audit`, `revoke`) y nada más. Consecuencia directa: **un despacho no puede afirmar completitud de CFDI recibidos desde aquí**. El criterio E3.2 de `plan:status` está en rojo por esto, y lo está a propósito: su versión anterior pasaba en verde porque una expresión regular casaba con dos cadenas de prosa en un archivo de políticas.
- **La nómina de EE. UU. reporta ceros al IRS.** Los generadores de las formas 940 y 941 suman `employer_tax_liabilities`, y ningún camino del repositorio escribe esa tabla; lo mismo con `paycheck_taxes` y `garnishments`. Una tabla vacía no rompe nada visible: hace que la forma declare cero impuesto patronal, que es un dato falso en una declaración presentada. `doctor` lo marca como `fail` —no como advertencia— cuando la entidad tiene empleados activos en Estados Unidos.
- **El timbrado con PAC es real en un solo proveedor.** De los cuatro adaptadores, tres se declaran simulados y un cerrojo les impide timbrar fuera de sandbox. Los detalles, en [[Fiscal-mexicano]].
- **GraphQL está desmontado por omisión.** Sus mutaciones ya piden el mismo permiso que su equivalente REST, con el mismo código, por un único punto de paso; y la compuerta que lo sostiene lee el esquema al cargar, de modo que una mutación nueva sin permiso declarado impide que los resolutores se carguen. Lo que queda para volver a encenderlo: vive fuera del prefijo auditado `/v1`, así que no deja la fila de PETICIÓN en `audit_log` —el rastro del hecho contable sí lo escriben los servicios dentro de su transacción— y diez de sus quince mutaciones están declaradas en el esquema y no existen.
- **De los 151 manejadores REST, 11 están retirados** y lanzan `NotImplementedError` en lugar de fingir que hicieron algo. Un 501 explícito es información; un 200 vacío es una mentira que alguien va a conciliar.

Ninguno de estos huecos es un descuido pendiente de documentar: cada uno tiene su rojo en `plan:status` o su bandera de apagado en el código. La lista viva —con la razón de cada uno— está en [[Hoja-de-ruta]] y en [[Auditorias]].
