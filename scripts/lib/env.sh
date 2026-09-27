# Sourced by scripts/setup.sh and scripts/verify.sh; not executed on its own.
#
# The Node processes load ./.env through dotenv (src/config/index.ts, the
# integration global setup, the plan's scenarios). A shell script deciding
# whether they can reach a database has to see the same values, or it reports
# SKIP for a suite that would have run. Same precedence as dotenv without
# `override`: the environment wins, then the last KEY= line of ./.env.
# Nothing is exported here; the caller decides.

dotenv_value() {
  local key="$1" line
  if [ -n "${!key:-}" ]; then
    printf '%s' "${!key}"
    return 0
  fi
  [ -f .env ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" .env | tail -n 1) || return 0
  line=${line#*=}
  case "$line" in
    \"*\"*) line=${line#\"}; line=${line%%\"*} ;;
    \'*\'*) line=${line#\'}; line=${line%%\'*} ;;
    *) line=${line%%[[:space:]]#*}; line=${line%"${line##*[![:space:]]}"} ;;
  esac
  printf '%s' "$line"
}
