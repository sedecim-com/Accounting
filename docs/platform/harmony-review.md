# Armonía con la plataforma Sedecim — revisión del 2026-09-26

> Se revisaron **135 repos** de `sedecim-com`. De esos, 54 archivados sólo se listaron; los ~85 activos se clonaron y los leyeron cinco revisores en paralelo, uno por dominio: finanzas y SAT, `acceso-*`, infraestructura, documentos e IA, y otros productos. Ningún repo se modificó.
>
> Esta página resume lo que importa a Accounting y lo que se propone a los demás. Los informes completos, con evidencia de `archivo:línea` por repo, se quedan en la sesión de trabajo. Aquí va sólo lo verificado.

## 1. Lo que la plataforma hace hoy

Ningún repo escribe estas normas: se infirieron del código, porque no existe un documento de convenciones de la organización.

| Tema | Norma de la plataforma | Accounting |
|---|---|---|
| Lenguaje y runtime | JavaScript/TypeScript. Node 22 en los repos nuevos y 16 en los viejos; los runners de CI todavía en Node 16 | TypeScript, Node ≥ 22.12 ✔ |
| Datos | MySQL (Aurora) con Sequelize; Mongo en `acceso-contracts` | **PostgreSQL con RLS**: divergencia legítima, se documenta |
| Despliegue | La sección `deployments` de `package.json` alimenta `github-actions-scripts/…/deploy_microservice.sh`; imagen en ECR y `kubectl apply` en `<ns>-<env>`; clusters `sedecim-stage` (dev, uat) y `sedecim` (beta, production) | Sin despliegue (#333) → #372 |
| Ramas | `dev` → `uat` → (`beta`) → `main`, con despliegue por rama | Sólo `main`; `maturity.md` pedía `develop`/`release` → #372 |
| Secretos | `"!Secret <blob> <PROP>"` → initContainer `init-secrets` → `/env/.env` | Vault propio en Secrets Manager; necesita blob e IAM propios → #372 |
| Autenticación | Gateway nginx con `auth_request` a `authentication-server-api`, que valida Cognito y pasa `x-jwt-payload`, un JSON **sin firma** en el que confían los servicios | Autentica él mismo (API keys, OIDC, RLS) → decisión #371 |
| Estilo de API | `/api/v1`, sobre `{success,message,…}` o `{message,statusCode}`, `limit`/`offset`, camelCase | `/v1`, `{errors:[{code,…}], meta:{request_id,…}}`, `page`/`per_page`, snake_case |
| Contratos | OpenAPI 3.0 escrito al arrancar, sin chequeo en CI; nada de AsyncAPI aunque se usa SQS | OpenAPI 3.1 generado y vigilado en CI ✔ |
| Commits | Mezcla de Conventional en inglés y texto libre | Prosa en español (`docs/PROCESS.md`); divergencia consciente |
| Framework agéntico | Casi todos en N0. Hay tres excepciones:<br>• `acceso-salespersons` usa `catalog-info.yaml` en formato **Backstage**;<br>• `acceso-frontend` tiene `AGENTS.md`;<br>• `assembly` define su propia taxonomía de labels para agentes | El formato de referencia (ADR-0002) |
| Pruebas en CI, CODEOWNERS, Dependabot | La mayoría no los tiene | Sí ✔ |

**Conclusión:** en calidad (pruebas, contrato, errores, framework), Accounting está por delante de la norma, y ahí son los demás quienes deben moverse. En integración (identidad, despliegue, secretos, gateway), Accounting todavía no encaja, y ahí es este repo el que se mueve.

## 2. Relaciones reales con Accounting

| Repo | Relación | Qué implica |
|---|---|---|
| `accounting-manager` | **Convive**, con un escritor por compañía de Contalink (ADR-0004) | Su ruta `/accounting/policies/manual` es pública en el gateway. **Quién la llama: `mx2`** (`common/models/com/fac/Validacion.php`), sin credencial. Así se cierra la pregunta «quién lo usa» que el ADR-0004 dejaba abierta. |
| `mx2` (PHP) | Llama a `accounting-manager` | Si el gateway agrega `auth_request` a esa ruta (AMG-004), **mx2 tiene que mandar credencial en el mismo despliegue**, o se rompe la contabilización de comisiones en producción. También tiene un cliente de Contalink propio, al parecer sin llamadores. |
| Cognito de Acceso + `acceso-rbac` | **Identidad candidata** | El issuer es el user pool de Cognito, no `authentication-server-api`. El bloque OIDC de Accounting hoy rechaza sus access tokens (#369). Decisión: #371. |
| `acceso-organizations` | Mapeo por RFC | Una organization con RFC corresponde a una entity de Accounting; el tenant de `acceso-rbac` corresponde al despacho (#371). |
| `sat-services` | **Duplica** la descarga masiva con e.firma | Ya la implementa con `@nodecfdi/sat-ws-descarga-masiva`. Cuando la descarga automática entre (post-MVP, #312), Accounting la consume o comparte la librería con un solo custodio de la FIEL. Antes, sat-services tiene que endurecerse (§4). |
| `hash-stamper` | **Productor candidato** | Obtiene la constancia NOM-151 de SOVOS. Accounting la consumiría para la capa legal de sus sellos (#374, post-MVP). |
| `catalogs` | Duplica catálogos del SAT | c_Banco, códigos postales, regímenes. Accounting mantiene su copia y la compara en una prueba cuando catalogs esté listo. Sus «inflaciones» no sirven para el INPC. |
| `sedecim-ocr-service` | Productor candidato | Su v2 (candidatos por campo) encaja con «la IA propone, una persona aprueba». Hoy no extrae movimientos de estados de cuenta. Los documentos se procesan en Google Vertex (PII). |
| `pdf-generator` | Productor candidato | Para estados financieros y recibos de nómina en PDF. Todavía no está listo: 0 pruebas y `X-Client-Id` autodeclarado. |
| `file-manager-api` | Convención | Llave de objeto = SHA-256. Se consume sólo cuando Accounting esté detrás del gateway; el espejo de CFDI se queda en Postgres (#370). |
| `Cobranza`, `commissions`, `loan` | Productores en potencia | Eventos «cobro aplicado», «comisión devengada», «pago de crédito». Hoy no hay caso de uso ni contrato: no se construye nada. |
| `PIIS` | **No delegar** | Su cifrado es débil: AES-CBC sin MAC, KDF MD5 y un «secreto por inquilino» derivado. Accounting no le delega RFC, CURP ni NSS. |
| `buzz-hermes-stack` | Ninguna directa | Corre Hermes, pero el perfil `witness` que revisa los PRs de Accounting vive en otra instancia. Conviene documentar dónde. |

Los demás repos (seguros, cotizadores, información pública, pro99, DeFi, etc.) no tienen relación funcional con Accounting.

## 3. Ajustes en Accounting (backlog)

| Prioridad | Ajuste | Dónde |
|---|---|---|
| Must | El OIDC acepta los access tokens de Cognito: `client_id`, `token_use` y `cognito:groups` en vez de `aud` | #369 · MNE-001-104 |
| Must | El adaptador S3 stub deja de responder «sano» y de guardar llaves de AWS del cliente | #370 · MNE-001-105 |
| Decisión | Identidad de plataforma: issuer Cognito, no confiar en `x-jwt-payload`, tenant y entidad por RFC, prefijo `/mnemosine/` | #371 · MNE-001-106 |
| Should | Imagen y workflows desplegables como los demás: `deployments`, entrypoint con `/env/.env`, puerto, blob de secretos propio, ramas `dev`/`uat` | #372 · MNE-001-107 |
| Should | `migrate` con advisory lock | #373 · MNE-001-108 |
| Could | Constancia NOM-151 vía `hash-stamper` | #374 (post-MVP; no entra a PRD-001) |
| Hecho aquí | Runtime `node-22` en la ficha y el inventario; `related_repos` y la tabla de relaciones al día; propuesta de normas de plataforma (§5) | este PR |

## 4. Propuestas a otros repos

No se tocó ningún repo. Lo que sigue se propone a sus dueños.

**Seguridad.** Son Must, aunque no bloqueen a Accounting. Los valores no se leyeron ni se copian aquí. Hay una issue abierta en cada repo, y rotar las credenciales queda en manos de quien tiene el acceso.

- `infrastructure/kops/fluentd/config.yaml`: un par de llaves AWS en texto plano. `infrastructure/kops/kubeconfig`: un kubeconfig versionado. Rotar y sacar del repo → sedecim-com/infrastructure#109.
- `docker/id_rsa`: una llave privada versionada → sedecim-com/docker#30.
- `public-information`: `.env` versionado en la raíz → sedecim-com/public-information#69.
- `textract/.gitlab-ci.yml` y `extracciones/.gitlab-ci.yml`: webhooks de Google Chat escritos en el archivo → sedecim-com/textract#99 y sedecim-com/extracciones#33.
- `acceso-organizations`: posibles credenciales en los seeders de dev y uat → sedecim-com/acceso-organizations#338.
- `sat-services` → sedecim-com/sat-services#64:
  - el cliente se identifica con `appClientId` en el body;
  - hay un middleware JWT con secreto fijo, sin usar;
  - la FIEL se cifra con AES-CTR sin autenticación;
  - un seeder trae el RFC y el nombre de una persona real.
- `authentication-server-api` → sedecim-com/authentication-server-api#100:
  - `POST /internal/token` firma cualquier payload sin autenticación;
  - `console.log(req.headers)` registra tokens Bearer;
  - el README trae posibles credenciales.
- **api-gateway:** rutas sin `auth_request` → sedecim-com/api-gateway#250:
  - `/accounting/policies/manual`, que genera pólizas en Contalink. Va en el mismo despliegue que sedecim-com/mx2#1365, para que mx2 mande credencial;
  - `/api/file-extractions` en producción, con el `auth_request` comentado, que recibe INE y estados de cuenta;
  - `/acceso-file-extractions` y `/sedecim-ocr/` en dev y uat.
- `init-secrets` escribe `/env/.env` sin comillas y borra las `"`: un valor con `$`, espacio o `;` se rompe o se ejecuta → sedecim-com/init-secrets#1.
- `github-actions-secrets-propagator` copia la credencial AWS de despliegue y `REPO_TOKEN` a todos los repos, incluso los que no despliegan → sedecim-com/github-actions-secrets-propagator#8.
- `PIIS`: AES-CBC sin MAC, KDF MD5 y secreto por inquilino derivado de un prefijo global → sedecim-com/PIIS#158.

**Infraestructura para desplegar Accounting:** RDS Postgres con PITR, IAM propio y namespaces `mnemosine-*` → sedecim-com/infrastructure#110 (depende de #371 y #372).

**Coherencia:**

- `accounting-manager`: borrar la rama `claude/deprecate-accounting-manager` (del PR #99, cerrado sin fusionar), cuyo README anuncia un retiro que el ADR-0004 revocó. Pendiente: el proxy de la sesión no permite borrarla, así que la borra una persona con acceso.
- `api-gateway`: quitar `/api/sat-certification`, porque su repo está vacío (incluido en sedecim-com/api-gateway#250).
- Archivar los repos muertos. Cada uno tiene su issue:
  - `payroll-extraction-service`: duplica el parser de nómina y guarda PII sin cifrar → sedecim-com/payroll-extraction-service#1;
  - `s3-files-manager` → sedecim-com/s3-files-manager#24;
  - `proyectosIAagent` → sedecim-com/proyectosIAagent#1;
  - `acce.so` → sedecim-com/acce.so#36;
  - `acceso-tenant-users` → sedecim-com/acceso-tenant-users#14;
  - los dos `kubernetes-dashboard` → sedecim-com/kubernetes-dashboard#1 y sedecim-com/kubernetes-dashboard-stage#1;
  - `sat-certification` y `facturacion`, repos vacíos → sedecim-com/sat-certification#1 y sedecim-com/facturacion#15.
- `event-logger` y `sedecim-ocr-service`: `ENVIRONMENT: prod` → `production`. El primero en sedecim-com/event-logger#1; el segundo es un fork sin issues y se anotó en sedecim-com/github-actions-scripts#35.
- Desplegar sólo con la CI en verde (`needs:`), y subir a Node 22 los runners de CI en Node 16 y las acciones `@v1`/`@v2`, con un workflow reutilizable → sedecim-com/github-actions-scripts#35. Hoy sólo 1 de 113 workflows de despliegue espera las pruebas. Accounting no baja de versión.

## 5. Propuestas de norma para `platform-docs`

Son para cuando exista, y las decide el equipo núcleo (ADR-0002).

1. **Ficha del repo.** Hay dos formatos de `catalog-info.yaml`: el plano del framework, en Accounting, y el Backstage de `acceso-salespersons`. Hay que elegir uno. Si gana Backstage, los campos de Accounting (`id_prefix`, `criticality`, `data_classification`, `external`, `datastores`) pasan a `metadata.annotations` o a `spec`.
2. **Estados de issue para agentes.** Una sola taxonomía. Se propone la de Accounting (`status:*`), con este mapa desde `assembly`:

   | `assembly` | Accounting |
   |---|---|
   | `agent-ready` | `status:agent-ready` |
   | `implementing` | `status:agent-working` |
   | `questions-posted` | `status:needs-clarification` |
   | `needs-human` | `status:escalated` |
   | `revise` | `status:changes-requested` |
   | `in-review` | `status:in-review` |
3. **Formato de error y contrato.** El de Accounting: código estable, `request_id`, idioma negociado, y OpenAPI generado y vigilado en CI. Los eventos SQS se especifican en AsyncAPI desde el primero.
4. **Dinero.** Entre servicios viaja como decimal en cadena, nunca como `number`. `acceso-contracts` hoy guarda los montos como `number`.
5. **Identidad entre servicios.** No confiar en `x-jwt-payload` fuera de una red en la que ningún pod sea alcanzable sin pasar por nginx. Los servicios que manejan dinero o PII validan el token ellos mismos.
