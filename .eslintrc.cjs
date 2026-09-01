// CONFIGURACIÓN ÚNICA DE ESLINT.
// CommonJS (.cjs) a propósito: el paquete no declara "type": "module", y el
// código se compila con module NodeNext. La extensión .cjs deja explícito el
// formato y evita que el cargador de ESLint tenga que adivinarlo.
//
// OJO al extender: "plugin:@typescript-eslint/recommended" arrastra el config
// "eslint-recommended", cuyo bloque overrides declara files ["*.ts", "*.tsx",
// "*.mts", "*.cts"]. De ahí ESLint 8 deduce qué extensiones expandir cuando el
// patrón es un DIRECTORIO. Sin ese extends, `eslint src/` vuelve a buscar solo
// .js, no encuentra nada y falla con "No files matching the pattern src/",
// que es exactamente el síntoma que este archivo viene a corregir.
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],

  // Artefactos y dependencias: nunca son código fuente de este repo.
  ignorePatterns: ['dist/', 'coverage/', 'node_modules/', 'files/'],

  rules: {
    // La regla base no entiende tipos ni enums de TS; manda la de @typescript-eslint.
    'no-unused-vars': 'off',
    // El repo YA marca con guion bajo lo que se ignora a propósito (_next, _res
    // en middleware de Express, donde la firma de 4 argumentos es obligatoria
    // para que Express lo reconozca como manejador de errores). La regla honra
    // esa convención en vez de pelearse con ella.
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],

    // Los tres usos de rangos de control en expresiones regulares son
    // saneamiento deliberado de texto de terceros antes de que llegue a una
    // bitácora de auditoría, a un índice único VARCHAR y al índice de prompts.
    // La regla existe para cazar caracteres de control ACCIDENTALES; aquí son
    // justamente el control de seguridad.
    'no-control-regex': 'off',

    // `declare global { namespace Express { interface Request ... } }` es la
    // única forma de aumentar el Request de Express. Se permite declarar
    // namespaces; seguir prohibiendo los que llevan código.
    '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
  },

  overrides: [
    {
      // Las pruebas son otro oficio que el código de producción.
      files: ['tests/**/*.ts'],
      rules: {
        // Los dobles de prueba fingen Request/Response de Express con la
        // forma mínima que el caso necesita; exigirles el tipo completo no
        // hace la prueba más verdadera, solo más larga.
        '@typescript-eslint/no-explicit-any': 'off',
        // tests/ai/injection-scan.spec.ts incrusta A PROPOSITO espacios de
        // ancho cero y separadores unicode: son la carga que el escáner debe
        // detectar y limpiar. "Corregir" ese espacio vacía la prueba.
        'no-irregular-whitespace': 'off',
      },
    },
  ],
};
