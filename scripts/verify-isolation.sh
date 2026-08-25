#!/usr/bin/env bash
# Prueba que el aislamiento por tenant funciona de verdad: crea un segundo
# tenant, comprueba las tres fronteras y limpia lo que creó.
#
#   SUPERUSER_URL=postgresql://usuario@localhost:5432/accounting_core \
#   MNEMOSINE_APP_PASSWORD=... ./scripts/verify-isolation.sh
set -euo pipefail

: "${SUPERUSER_URL:?falta SUPERUSER_URL}"
: "${MNEMOSINE_APP_PASSWORD:?falta MNEMOSINE_APP_PASSWORD}"

APP_URL="postgresql://mnemosine_app@$(echo "$SUPERUSER_URL" | sed -E 's#.*@##')"
T2='22222222-2222-2222-2222-222222222222'
fallos=0

check() { # descripción, obtenido, esperado
  if [ "$2" = "$3" ]; then
    printf '  ✔ %s\n' "$1"
  else
    printf '  ✘ %s — obtenido "%s", esperado "%s"\n' "$1" "$2" "$3"; fallos=$((fallos+1))
  fi
}

cleanup() {
  psql "$SUPERUSER_URL" -q -c "DELETE FROM legal_entities WHERE tenant_id='$T2'" \
    -c "DELETE FROM organizations WHERE tenant_id='$T2'" \
    -c "DELETE FROM tenants WHERE id='$T2'" 2>/dev/null || true
}
trap cleanup EXIT

psql "$SUPERUSER_URL" -q <<SQL
INSERT INTO tenants (id,name,subdomain,schema_name,plan)
  VALUES ('$T2','Aislamiento','aislamiento-test','tenant_aislamiento','professional')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO organizations (id,tenant_id,name,type)
  VALUES ('2a222222-2222-2222-2222-222222222222','$T2','Org Test','operating')
  ON CONFLICT DO NOTHING;
INSERT INTO legal_entities (id,organization_id,tenant_id,name,entity_type,tax_id,tax_id_type,incorporation_country,functional_currency,accounting_standard)
  VALUES ('2e222222-2222-2222-2222-222222222222','2a222222-2222-2222-2222-222222222222','$T2','Entidad Test','sapi','BBB020202BB2','rfc','MX','MXN','mx_nif')
  ON CONFLICT DO NOTHING;
SQL

T1=$(psql "$SUPERUSER_URL" -tAc "SELECT tenant_id FROM legal_entities WHERE tenant_id <> '$T2' LIMIT 1")
export PGPASSWORD="$MNEMOSINE_APP_PASSWORD"

echo "Aislamiento por tenant, como mnemosine_app:"

sin_ctx=$(psql "$APP_URL" -tAc "SELECT count(*) FROM legal_entities")
check "sin contexto no ve ninguna entidad" "$sin_ctx" "0"

# El bloque emite BEGIN / el uuid del set_config / el conteo / COMMIT:
# se filtra la única línea puramente numérica.
propias=$(psql "$APP_URL" -tA <<SQL | grep -E '^[0-9]+$' | tail -1
BEGIN; SELECT set_config('app.current_tenant','$T2',true);
SELECT count(*) FROM legal_entities WHERE tenant_id <> '$T2'; COMMIT;
SQL
)
check "con contexto no ve entidades de otro tenant" "$propias" "0"

escritura=$(psql "$APP_URL" -tA 2>&1 <<SQL | grep -c "row-level security" || true
BEGIN; SELECT set_config('app.current_tenant','$T2',true);
INSERT INTO ai_questions (tenant_id,entity_id,question)
  VALUES ('$T1',(SELECT id FROM legal_entities LIMIT 1),'fuga'); COMMIT;
SQL
)
check "la escritura hacia otro tenant se rechaza" "$escritura" "1"

# Cobertura: una tabla con alcance y sin política es una fuga silenciosa.
# Pasó de verdad — una migración de otra sesión creó ai_external_ops después
# del endurecimiento inicial.
sin_politica=$(psql "$SUPERUSER_URL" -tAc "
  SELECT coalesce(string_agg(c.relname, ', '), '')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
    AND a.attname IN ('tenant_id','entity_id')
    AND c.relname <> ALL (ARRAY['users','sessions','tenants','migrations'])
    AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
         OR NOT EXISTS (SELECT 1 FROM pg_policy p
                        WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'))")
check "todas las tablas con alcance tienen política" "$sin_politica" ""

# Las vistas corren con los permisos de su dueño: una vista de un superusuario
# sobre una tabla protegida se salta RLS.
vistas_ajenas=$(psql "$SUPERUSER_URL" -tAc "
  SELECT coalesce(string_agg(c.relname, ', '), '')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('v','m')
    AND pg_get_userbyid(c.relowner) <> 'mnemosine_owner'")
check "ninguna vista pertenece a un rol que ignore RLS" "$vistas_ajenas" ""

# Una tabla sin permisos para la app rompe el comando que la toque, semanas
# después y lejos de la migración que la creó. Pasó con siete.
sin_permisos=$(psql "$SUPERUSER_URL" -tAc "
  SELECT coalesce(string_agg(c.relname, ', '), '')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
    AND NOT has_table_privilege('mnemosine_app', c.oid, 'SELECT')")
check "la app tiene permisos sobre todas las tablas" "$sin_permisos" ""

if [ "$fallos" -eq 0 ]; then echo "Aislamiento verificado."; else echo "FALLOS: $fallos"; exit 1; fi
