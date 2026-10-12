#!/usr/bin/env bash
# Regenerates the PKCS#12 test fixtures in this directory with the OpenSSL CLI (>= 3.4: needs
# `-not_before/-not_after`, `-legacy` and `-pbmac1_pbkdf2`). The keys and certificates are
# synthetic test material: never use real certificates in tests.
#
#   OPENSSL=/opt/homebrew/bin/openssl ./generate.sh
#
# Fixtures (passphrase "Fixture-1234" unless noted):
#   rsa-openssl3.p12        RSA-2048 leaf + RSA CA. OpenSSL 3 defaults: PBES2/AES-256-CBC, MAC SHA-256
#   rsa-legacy-rc2.p12      same key/certs, `-legacy`: key PBE-SHA1-3DES, certs PBE-SHA1-RC2-40, MAC SHA-1
#   rsa-pbmac1.p12          same key/certs, PBES2 + PBMAC1 (RFC 9579) integrity
#   rsa-nonascii.p12        same key/certs, passphrase "Contraseña-Ñ€1", OpenSSL 3 defaults
#   rsa-nonascii-legacy.p12 same key/certs, passphrase "Contraseña-Ñ€1", `-legacy`
#   rsa-expired.p12         expired RSA leaf (2015-2020)
#   rsa-nokey.p12           certificates only, no private key
#   ec-p256-openssl3.p12    EC P-256 leaf + EC P-384 CA, OpenSSL 3 defaults
#   ec-p384-legacy.p12      EC P-384 leaf + EC P-384 CA, `-legacy`
set -euo pipefail
OPENSSL="${OPENSSL:-openssl}"
cd "$(dirname "$0")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS='Fixture-1234'
NONASCII='Contraseña-Ñ€1'

# --- RSA hierarchy -----------------------------------------------------------------------------
"$OPENSSL" req -x509 -new -newkey rsa:2048 -nodes -keyout "$TMP/ca-rsa.key" -out "$TMP/ca-rsa.crt" \
  -utf8 -subj '/C=ES/O=SPAINASSISTANT TEST/OU=CERES TEST/CN=AC TEST USUARIOS' \
  -not_before 20250101000000Z -not_after 20500101000000Z \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'

"$OPENSSL" req -new -newkey rsa:2048 -nodes -keyout "$TMP/rsa.key" -out "$TMP/rsa.csr" -utf8 \
  -subj '/C=ES/serialNumber=IDCES-99999999R/SN=ESPAÑOLA ESPAÑOLA/GN=CARMEN/CN=ESPAÑOLA ESPAÑOLA CARMEN - 99999999R'

cat > "$TMP/leaf.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth,emailProtection
EXT

"$OPENSSL" x509 -req -in "$TMP/rsa.csr" -CA "$TMP/ca-rsa.crt" -CAkey "$TMP/ca-rsa.key" \
  -set_serial 0x1A2B3C4D5E6F -not_before 20260101000000Z -not_after 20460101000000Z \
  -extfile "$TMP/leaf.ext" -out "$TMP/rsa.crt"

"$OPENSSL" x509 -req -in "$TMP/rsa.csr" -CA "$TMP/ca-rsa.crt" -CAkey "$TMP/ca-rsa.key" \
  -set_serial 0x0EC5 -not_before 20150101000000Z -not_after 20200101000000Z \
  -extfile "$TMP/leaf.ext" -out "$TMP/rsa-expired.crt"

NAME='ESPAÑOLA ESPAÑOLA CARMEN - 99999999R'
"$OPENSSL" pkcs12 -export -inkey "$TMP/rsa.key" -in "$TMP/rsa.crt" -certfile "$TMP/ca-rsa.crt" \
  -name "$NAME" -passout "pass:$PASS" -out rsa-openssl3.p12
"$OPENSSL" pkcs12 -export -legacy -inkey "$TMP/rsa.key" -in "$TMP/rsa.crt" \
  -certfile "$TMP/ca-rsa.crt" -name "$NAME" -passout "pass:$PASS" -out rsa-legacy-rc2.p12
"$OPENSSL" pkcs12 -export -pbmac1_pbkdf2 -inkey "$TMP/rsa.key" -in "$TMP/rsa.crt" \
  -certfile "$TMP/ca-rsa.crt" -name "$NAME" -passout "pass:$PASS" -out rsa-pbmac1.p12
"$OPENSSL" pkcs12 -export -inkey "$TMP/rsa.key" -in "$TMP/rsa.crt" -certfile "$TMP/ca-rsa.crt" \
  -name "$NAME" -passout "pass:$NONASCII" -out rsa-nonascii.p12
"$OPENSSL" pkcs12 -export -legacy -inkey "$TMP/rsa.key" -in "$TMP/rsa.crt" \
  -certfile "$TMP/ca-rsa.crt" -name "$NAME" -passout "pass:$NONASCII" -out rsa-nonascii-legacy.p12
"$OPENSSL" pkcs12 -export -inkey "$TMP/rsa.key" -in "$TMP/rsa-expired.crt" \
  -certfile "$TMP/ca-rsa.crt" -name "$NAME" -passout "pass:$PASS" -out rsa-expired.p12
"$OPENSSL" pkcs12 -export -nokeys -in "$TMP/rsa.crt" -certfile "$TMP/ca-rsa.crt" \
  -passout "pass:$PASS" -out rsa-nokey.p12

# --- EC hierarchy (FNMT issues ECDSA certificates since late 2025) ------------------------------
cat > "$TMP/leaf-ec.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth,emailProtection
EXT

"$OPENSSL" req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-384 -nodes \
  -keyout "$TMP/ca-ec.key" -out "$TMP/ca-ec.crt" -sha384 \
  -utf8 -subj '/C=ES/O=SPAINASSISTANT TEST/CN=AC TEST USUARIOS EC' \
  -not_before 20250101000000Z -not_after 20500101000000Z \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'

"$OPENSSL" req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$TMP/ec256.key" \
  -out "$TMP/ec256.csr" -utf8 \
  -subj '/C=ES/serialNumber=IDCES-X1234567L/SN=MUESTRA SAMPLE/GN=JUAN/CN=MUESTRA SAMPLE JUAN - X1234567L'
"$OPENSSL" x509 -req -in "$TMP/ec256.csr" -CA "$TMP/ca-ec.crt" -CAkey "$TMP/ca-ec.key" -sha384 \
  -set_serial 0x2B3C4D5E6F70 -not_before 20260101000000Z -not_after 20460101000000Z \
  -extfile "$TMP/leaf-ec.ext" -out "$TMP/ec256.crt"

"$OPENSSL" req -new -newkey ec -pkeyopt ec_paramgen_curve:P-384 -nodes -keyout "$TMP/ec384.key" \
  -out "$TMP/ec384.csr" -utf8 \
  -subj '/C=ES/serialNumber=IDCES-12345678Z/SN=PRUEBA CERTIFICADO/GN=ANA/CN=PRUEBA CERTIFICADO ANA - 12345678Z'
"$OPENSSL" x509 -req -in "$TMP/ec384.csr" -CA "$TMP/ca-ec.crt" -CAkey "$TMP/ca-ec.key" -sha384 \
  -set_serial 0x3C4D5E6F7081 -not_before 20260101000000Z -not_after 20460101000000Z \
  -extfile "$TMP/leaf-ec.ext" -out "$TMP/ec384.crt"

"$OPENSSL" pkcs12 -export -inkey "$TMP/ec256.key" -in "$TMP/ec256.crt" -certfile "$TMP/ca-ec.crt" \
  -name 'MUESTRA SAMPLE JUAN - X1234567L' -passout "pass:$PASS" -out ec-p256-openssl3.p12
"$OPENSSL" pkcs12 -export -legacy -inkey "$TMP/ec384.key" -in "$TMP/ec384.crt" \
  -certfile "$TMP/ca-ec.crt" -name 'PRUEBA CERTIFICADO ANA - 12345678Z' -passout "pass:$PASS" \
  -out ec-p384-legacy.p12

ls -l ./*.p12
