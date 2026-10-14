#!/usr/bin/env bash
set -euo pipefail
readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${ROOT}/.local"
if [[ -e "${ROOT}/.local/server.key" || -e "${ROOT}/.local/server.crt" ]]; then
  echo 'Certificate already exists; refusing to overwrite it.' >&2
  exit 1
fi
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 \
  -keyout "${ROOT}/.local/server.key" \
  -out "${ROOT}/.local/server.crt" \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
chmod 600 "${ROOT}/.local/server.key"
echo 'Development certificate created for localhost / 127.0.0.1.'
