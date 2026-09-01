# Material criptográfico SINTÉTICO

Todo lo que vive en este directorio (`fiel.cer`/`fiel.key`, `csd.cer`/`csd.key`,
`seed.key`…) es **material de prueba generado localmente**: certificados
autofirmados con RFCs de fixture (`XAXX010101000` y similares), sin relación
con ninguna persona ni credencial real del SAT. Se rastrea en git a propósito
para que la suite corra sin pasos de preparación.

Regenerarlo (OpenSSL, mismas características que produce el SAT — RSA 2048,
DER):

    openssl req -x509 -newkey rsa:2048 -keyout fiel.pem -out fiel-cert.pem \
      -days 3650 -nodes -subj "/CN=FIXTURE/serialNumber=XAXX010101000"
    openssl x509 -in fiel-cert.pem -outform DER -out fiel.cer
    openssl rsa -in fiel.pem -outform DER -out fiel.key

La regla del repositorio para material REAL no cambia: una e.firma real jamás
entra al repo ni al chat — sólo por el prompt oculto de `mnemosine sat cred
add`, a la bóveda.
