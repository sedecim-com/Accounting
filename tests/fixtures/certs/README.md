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

`efirma-sat-serial.cer`/`.key` (EFIRMA-4, #442) is the same kind of synthetic
e.firma, with a serial written the way the SAT writes it (the hex of 20 ASCII
digits, here `00001000000000000145`), so the Anexo 24 `noCertificado` can be
derived from it. Password `test1234`. Regenerate it with:

    openssl req -x509 -newkey rsa:2048 -keyout seal.pem -out seal-cert.pem \
      -days 3650 -nodes -set_serial 0x3030303031303030303030303030303030313435 \
      -subj "/CN=DEMO CORP MX/O=DEMO CORP MX/x500UniqueIdentifier=AAA010101AAA \/ AAAA010101HDFAAA01" \
      -addext "keyUsage=critical,digitalSignature,keyEncipherment,dataEncipherment"
    openssl x509 -in seal-cert.pem -outform DER -out efirma-sat-serial.cer
    openssl pkcs8 -topk8 -v1 PBE-SHA1-3DES -in seal.pem -outform DER \
      -out efirma-sat-serial.key -passout pass:test1234
