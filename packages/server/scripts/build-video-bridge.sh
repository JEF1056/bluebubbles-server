#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARCH="$(uname -m)"
OUT_DIR="${SERVER_DIR}/appResources/macos/tools"
OUT_VIDEO_BIN="${OUT_DIR}/BlueBubblesVideoBridge"
OUT_CAMERA_BIN="${OUT_DIR}/BlueBubblesCameraBridge"

mkdir -p "${OUT_DIR}"

swiftc -O \
    -target "${ARCH}-apple-macos12.3" \
    -framework ScreenCaptureKit \
    -framework VideoToolbox \
    -framework CoreMedia \
    -framework CoreVideo \
    -framework CoreGraphics \
    -framework Foundation \
    "${SCRIPT_DIR}/BlueBubblesVideoBridge.swift" \
    -o "${OUT_VIDEO_BIN}"

chmod +x "${OUT_VIDEO_BIN}"
echo "Built ${OUT_VIDEO_BIN}"

swiftc -O \
    -target "${ARCH}-apple-macos12.3" \
    -framework VideoToolbox \
    -framework CoreMedia \
    -framework CoreVideo \
    -framework Foundation \
    "${SCRIPT_DIR}/BlueBubblesCameraBridge.swift" \
    -o "${OUT_CAMERA_BIN}"

chmod +x "${OUT_CAMERA_BIN}"
codesign -f -s - "${OUT_CAMERA_BIN}" >/dev/null 2>&1 || true
echo "Built ${OUT_CAMERA_BIN}"
