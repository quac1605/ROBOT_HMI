#!/usr/bin/env bash
set -euo pipefail

# Keep the media server outside Git and verify the exact release bytes.
readonly VERSION=v1.21.2
readonly SHA256=121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27
readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ARCHIVE="${ROOT}/.bin/mediamtx_${VERSION}_linux_amd64.tar.gz"
mkdir -p "${ROOT}/.bin"
if [[ ! -x "${ROOT}/.bin/mediamtx" ]]; then
  curl -fL --retry 2 \
    "https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/mediamtx_${VERSION}_linux_amd64.tar.gz" \
    -o "${ARCHIVE}"
  printf '%s  %s\n' "${SHA256}" "${ARCHIVE}" | sha256sum -c -
  tar -xzf "${ARCHIVE}" -C "${ROOT}/.bin" mediamtx LICENSE
fi
actual_version="$("${ROOT}/.bin/mediamtx" --version)"
[[ "${actual_version}" == "${VERSION}" ]] || {
  echo "Unexpected MediaMTX version: ${actual_version}" >&2
  exit 1
}
printf '%s\n' "${actual_version}"
