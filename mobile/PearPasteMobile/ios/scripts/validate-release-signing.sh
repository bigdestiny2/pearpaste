#!/bin/sh
set -eu

configuration="${CONFIGURATION:-}"
sdk_name="${SDK_NAME:-}"
platform_name="${PLATFORM_NAME:-}"
effective_platform_name="${EFFECTIVE_PLATFORM_NAME:-}"

if [ "$configuration" != "Release" ]; then
  exit 0
fi

case "$sdk_name:$platform_name:$effective_platform_name" in
  *iphonesimulator*|*simulator*)
    exit 0
    ;;
esac

case "$sdk_name" in
  iphoneos*) ;;
  *) exit 0 ;;
esac

bundle_identifier="${PRODUCT_BUNDLE_IDENTIFIER:-}"
development_team="${DEVELOPMENT_TEAM:-}"
code_sign_style="${CODE_SIGN_STYLE:-}"
code_sign_identity="${CODE_SIGN_IDENTITY:-${EXPANDED_CODE_SIGN_IDENTITY_NAME:-}}"
profile_specifier="${PROVISIONING_PROFILE_SPECIFIER:-}"

missing=""

add_missing() {
  if [ -z "$missing" ]; then
    missing="$1"
  else
    missing="$missing, $1"
  fi
}

is_placeholder() {
  case "$1" in
    ""|org.reactjs.native.example*|com.example*|com.your-company*|YOUR_*|*REPLACE_ME*)
      return 0
      ;;
  esac
  return 1
}

if is_placeholder "$bundle_identifier"; then
  add_missing "PRODUCT_BUNDLE_IDENTIFIER"
fi

if is_placeholder "$development_team"; then
  add_missing "DEVELOPMENT_TEAM"
fi

if is_placeholder "$code_sign_style"; then
  add_missing "CODE_SIGN_STYLE"
fi

if [ "$code_sign_style" = "Manual" ] && is_placeholder "$profile_specifier"; then
  add_missing "PROVISIONING_PROFILE_SPECIFIER"
fi

case "$code_sign_identity" in
  ""|"iPhone Developer"|"Apple Development")
    add_missing "Apple Distribution signing identity"
    ;;
esac

if [ -n "$missing" ]; then
  cat >&2 <<EOF
error: PearPaste Release iphoneos builds require explicit Apple signing settings.
Missing or placeholder values: $missing.

Provide real values via ios/Config/Signing.local.xcconfig, or pass xcodebuild
build settings such as PEARPASTE_BUNDLE_IDENTIFIER, PEARPASTE_DEVELOPMENT_TEAM,
PEARPASTE_CODE_SIGN_STYLE, and PEARPASTE_PROVISIONING_PROFILE_SPECIFIER.
No Apple team ID, provisioning profile, or certificate is checked into this repo.
EOF
  exit 1
fi
