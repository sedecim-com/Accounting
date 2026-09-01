# Política de seguridad

Este sistema lleva contabilidad real: comprobantes fiscales del SAT, custodia de
e.firma y CSD, y el aislamiento entre los libros de distintos clientes. Un fallo
aquí no rompe una pantalla — corrompe un libro que alguien va a declarar, o deja
ver a un cliente los números de otro.

## Cómo reportar

**No abras un issue público.** Usa el canal privado de GitHub:

> Security → Report a vulnerability
> https://github.com/sedecim-com/Accounting/security/advisories/new

Ese canal es privado entre tú y quien mantiene el repositorio hasta que exista un
arreglo. Un issue público, en cambio, publica el camino de ataque antes que la
corrección.

Respuesta esperada: **72 horas** para acusar recibo. Si en ese plazo no hubo
respuesta, insiste por el mismo canal antes de considerar cualquier divulgación.

## Qué tiene prioridad

En orden, por lo que cuesta reparar el daño una vez hecho:

1. **Fuga entre inquilinos.** Cualquier camino que devuelva filas de un
   `entity_id` o `tenant_id` distinto del solicitado, o que deje inerte el RLS.
2. **Custodia de credenciales fiscales.** Cualquier lectura del material de una
   e.firma o un CSD fuera de `withCredential`, o que no quede en la bitácora de
   accesos.
3. **Escrituras de la IA sin revisión humana.** El agente nunca escribe el libro
   ni sistemas externos: todo queda en `ai_drafts` / `ai_external_ops` y lo
   aprueba una persona. Un camino que postee sin esa aprobación —o que levante
   los límites de `src/ai/floor.ts`, que sólo se combinan con `Math.min`— es una
   vulnerabilidad, no un detalle de diseño.
4. **Integridad contable.** Asientos que descuadren, sellos de periodo que
   declaren cobertura que no tienen, o auditoría que se pueda reescribir.
5. **Autenticación y autorización** del API y del CLI.

## Fuera de alcance

- **Los certificados de `tests/fixtures/certs/` son autofirmados de demostración**
  (`CN=DEMO CORP MX`, RFC `AAA010101AAA`). No son credenciales del SAT y su
  llave privada está en el repositorio a propósito, para que las pruebas corran.
  No hace falta reportarlos.
- Los RFC del código son los genéricos publicados por el SAT (`XAXX010101000`,
  `XEXX010101000`) o de demostración. No hay datos de contribuyentes reales.
- `dev-secret-change-me` es el `JWT_SECRET` de desarrollo y está documentado:
  el arranque **se niega** a correr con él bajo `NODE_ENV=production`
  (`src/config/index.ts`). Si encuentras un camino que lo acepte en producción,
  eso sí es un hallazgo.
- Denegación de servicio por fuerza bruta contra una instancia que tú mismo
  despliegues.

## Divulgación

Preferimos divulgación coordinada: publicamos el aviso cuando existe el arreglo,
y damos crédito a quien reportó salvo que prefiera lo contrario.
