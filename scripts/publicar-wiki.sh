#!/usr/bin/env bash
#
# Publica docs/wiki/ en la wiki de GitHub.
#
# La wiki de GitHub es OTRO repositorio (Accounting.wiki.git). Si se edita desde
# el navegador, la copia del repositorio y la publicada divergen sin que nada lo
# diga — que es exactamente el modo de fallo que esta casa persigue en todas
# partes. Por eso la fuente de verdad es docs/wiki/ y esto sincroniza en una
# sola dirección: del repositorio a la wiki, nunca al revés.
#
# ANTES DE LA PRIMERA CORRIDA: GitHub no crea el repositorio de la wiki hasta
# que existe una página. Entra a
#   https://github.com/sedecim-com/Accounting/wiki
# y guarda cualquier página (el contenido da igual: este script la sobrescribe).
# Sin ese paso el clon falla con «Repository not found», y no es un error de
# permisos.
#
#   bash scripts/publicar-wiki.sh              # publica
#   bash scripts/publicar-wiki.sh --simulacro  # enseña el diff y no empuja
#
set -euo pipefail

REPO="${WIKI_REPO:-https://github.com/sedecim-com/Accounting.wiki.git}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUENTE="$RAIZ/docs/wiki"
SIMULACRO=0
[ "${1:-}" = "--simulacro" ] && SIMULACRO=1

[ -d "$FUENTE" ] || { echo "no existe $FUENTE" >&2; exit 1; }

CLON="$(mktemp -d)"
trap 'rm -rf "$CLON"' EXIT

if ! git clone --quiet --depth 1 "$REPO" "$CLON/wiki" 2>/dev/null; then
  echo "No se pudo clonar $REPO." >&2
  echo "Si dice «Repository not found», la wiki todavía no tiene su primera" >&2
  echo "página: créala una vez en el navegador y vuelve a correr esto." >&2
  exit 1
fi

# Borrar y volver a copiar, en vez de copiar encima: así una página que se
# retira del repositorio también desaparece de la wiki. Copiar encima deja
# huérfanas que nadie recuerda haber escrito.
find "$CLON/wiki" -maxdepth 1 -name '*.md' -delete
cp "$FUENTE"/*.md "$CLON/wiki/"

cd "$CLON/wiki"
if git diff --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "La wiki ya está al día."
  exit 0
fi

git add -A
echo "── cambios ──"
git --no-pager diff --cached --stat

if [ "$SIMULACRO" = "1" ]; then
  echo
  echo "Simulacro: no se empuja nada."
  exit 0
fi

ORIGEN="$(git -C "$RAIZ" rev-parse --short HEAD)"
git -c user.name="$(git -C "$RAIZ" config user.name)" \
    -c user.email="$(git -C "$RAIZ" config user.email)" \
    commit --quiet -m "Sincronizar la wiki desde docs/wiki (repositorio en $ORIGEN)"
git push --quiet origin HEAD
echo
echo "Publicado. https://github.com/sedecim-com/Accounting/wiki"
