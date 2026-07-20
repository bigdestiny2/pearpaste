# Pear Paste for StartOS

This is the StartOS wrapper for Pear Paste.

## Build

The package consumes the Pear Paste Docker image derived from the root
`package.json` version plus `release/container-image.json`.
The daemon listens on the internal web port from that file and exports the
StartOS web interface on the preferred external port from the same metadata.

Prerequisites for `.s9pk` packing:

- `start-cli` from the matching StartOS SDK/release.
- `mksquashfs` on `PATH`; on macOS, `brew install squashfs`.

```sh
npm ci
npm run verify
make x86
make arm
START_CLI=/path/to/start-cli npm run verify:artifacts
```

Override the image tag at build time if needed:

```sh
PEARPASTE_IMAGE=ghcr.io/bigdestiny2/pearpaste:<version>@sha256:<digest> make x86
```

The build produces `.s9pk` artifacts that can be sideloaded into StartOS.
`npm run verify` does not require `start-cli`; it builds the StartOS JavaScript
ingredient and verifies the compiled manifest against the root release metadata.
`npm run verify:artifacts` does require `start-cli`; it inspects the built
`pearpaste_x86_64.s9pk` and `pearpaste_aarch64.s9pk` manifests with an isolated
temporary `HOME`, then prints the artifact SHA-256 hashes.

## Image Release

From the repository root:

```sh
npm run container:status
npm run startos:verify
npm run container:publish -- --apply-digest
START_CLI=/path/to/start-cli npm run startos:verify-artifacts
```

`container:publish -- --apply-digest` pushes the multi-arch image and records the
published index digest in `release/container-image.json`. That digest is then
picked up by this StartOS package without editing the manifest by hand.
