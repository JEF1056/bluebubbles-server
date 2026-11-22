#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARCH="$(uname -m)"
OUT_DIR="${SERVER_DIR}/appResources/macos/tools"
OUT_BIN="${OUT_DIR}/BlueBubblesTranslator"

mkdir -p "${OUT_DIR}"

swiftc -O \
    -target "${ARCH}-apple-macos15.0" \
    -framework Foundation \
    -framework NaturalLanguage \
    -framework Translation \
    "${SCRIPT_DIR}/BlueBubblesTranslator.swift" \
    -o "${OUT_BIN}"

chmod +x "${OUT_BIN}"
codesign -f -s - "${OUT_BIN}" >/dev/null 2>&1 || true
echo "Built ${OUT_BIN}"
