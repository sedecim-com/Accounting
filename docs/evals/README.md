# Evals del clasificador

`clasificador.jsonl` lo escribe `scripts/eval-clasificador.ts`: una línea por
corrida (fecha, proveedor, modelo, exactitud por clase). El arnés compara cada
corrida contra la anterior del mismo proveedor+modelo — el archivo ES la
memoria del «mejoró/empeoró». No se edita a mano.

Correr el eval (necesita TEST_ADMIN_DATABASE_URL y la credencial del proveedor):

    npx tsx scripts/eval-clasificador.ts --provider anthropic
    npx tsx scripts/eval-clasificador.ts --provider anthropic --umbral 0.8   # exit 1 si no da la talla
