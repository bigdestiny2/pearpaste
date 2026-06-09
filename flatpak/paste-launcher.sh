#!/bin/sh
# PearPaste launcher INSIDE the Flatpak sandbox.
#
# Chromium cannot use its own setuid/namespace sandbox under Flatpak's sandbox, so
# the Electron binary MUST be wrapped with `zypak-wrapper` (provided by
# org.electronjs.Electron2.BaseApp). Launching the Electron binary directly will
# crash with a sandbox error.
#
# /app/paste/Paste is the materialized pear-electron Electron executable.
# scripts/build-flatpak.mjs verifies the real binary name in the payload and
# symlinks it to `Paste` if upstream names it differently (e.g. the bare runtime
# basename), so this path stays stable.
exec zypak-wrapper /app/paste/Paste "$@"
