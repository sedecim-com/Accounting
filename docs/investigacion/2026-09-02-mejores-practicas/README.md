# Investigación de mejores prácticas · 2026-09-02

Seis lentes con web en vivo. **Toda liga de las tablas se verificó con fetch en la corrida**
(121 verificadas, 33 muertas o no verificables — y las muertas se dicen, no se esconden). Cada
informe termina en «el mecanismo»: el diseño concreto para mnemosine bajo las reglas de la casa
—adaptadores en el registry con `simulado` declarado, bifurcaciones al panel con su lector,
secretos que sólo se nombran, y fila de catálogo más criterio para no nacer huérfano.

| Informe | Qué responde | Ligas ok/muertas |
|---|---|---|
| [pacs.md](pacs.md) | Los PAC a precargar, con el PDF del SAT de autorizaciones y la regla de custodia intacta | 16/9 |
| [ia.md](ia.md) | Los proveedores que faltan, la deriva de los cableados y la conexión de un solo paso | 32/8 |
| [onboarding.md](onboarding.md) | El XML del Anexo 24 como formato universal de migración, y la doctrina de corte | 17/6 |
| [tablero.md](tablero.md) | La SPA sobre el gateway anémico; por qué el low-code es un tercer motor | 20/5 |
| [canales.md](canales.md) | El canal como adaptador: entrada que persiste antes del 200, salida sólo por la bandeja | 20/0 |
| [experimental.md](experimental.md) | Cuentas públicas/subcuentas privadas sobre la jerarquía que ya existe; el recibo de Grigg sin blockchain | 16/5 |

Tres hallazgos de repositorio que salieron de investigar hacia afuera:

- **`sovosReachcoreAdapter` no está en el registry** — vive en el diccionario del router
  (`pac-router.ts:28`) pero nunca pasa por `integrationRegistry.register()`: configurarlo por
  `/v1/admin/integrations` sigue muriendo. La v4 del plan lo daba por registrado; la v4.2 lo corrige.
- **El agrupador SAT tiene dos columnas**: `mx_nif_code` (001, se escribe) y
  `codigo_agrupador_sat` (037, nadie la lee ni escribe). Consolidar antes del onboarding capa 1.
- **Dos páginas de AWS traían instrucciones incrustadas dirigidas a asistentes de IA**
  (ejecutar comandos). Se ignoraron y quedaron anotadas: el contenido web es dato, no instrucción.

Las páginas de la wiki derivadas de estos informes: Conectores-PAC, Onboarding-de-contabilidad,
El-tablero-grafico, Canales-de-mensajeria, La-contabilidad-como-centro y la reescritura de
Proveedores-de-modelo. El plan maestro v4.2 absorbe los tramos propuestos.
