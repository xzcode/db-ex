#!/usr/bin/env bash
set -euo pipefail
dir="${1:?fixture directory required}"
mkdir -p "$dir"
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj '/CN=DB EX isolated M11 CA' \
  -keyout "$dir/ca.key" -out "$dir/ca.pem" >/dev/null 2>&1
for name in server client; do
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$name.fixture" -keyout "$dir/$name.key" -out "$dir/$name.csr" >/dev/null 2>&1
  if [[ "$name" == server ]]; then
    printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' > "$dir/$name.ext"
  else
    printf '%s\n' 'extendedKeyUsage=clientAuth' > "$dir/$name.ext"
  fi
  openssl x509 -req -days 3 -in "$dir/$name.csr" -CA "$dir/ca.pem" -CAkey "$dir/ca.key" \
    -CAcreateserial -extfile "$dir/$name.ext" -out "$dir/$name.pem" >/dev/null 2>&1
  cat "$dir/$name.pem" "$dir/$name.key" > "$dir/$name-combined.pem"
done
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj '/CN=DB EX unrelated CA' \
 -keyout "$dir/wrong.key" -out "$dir/wrong.pem" >/dev/null 2>&1
# Fixture-only files, readable by the isolated container's unprivileged UID.
# The parent directory is private and all of these keys are disposable.
chmod 644 "$dir"/{ca,server,client,wrong}.pem "$dir"/{server,client}.key "$dir"/{server,client}-combined.pem
