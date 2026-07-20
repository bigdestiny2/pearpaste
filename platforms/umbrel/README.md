# Pear Paste for Umbrel

This directory contains the Umbrel app-store entries for Pear Paste.

- `pearpaste/` is the neutral app package shape for an official or standalone
  Umbrel app store.
- `hiverelay-pearpaste/` is the community-store package for the existing
  HiveRelay community app store at
  `https://github.com/bigdestiny2/blindspark-umbrel-store`.

## Image

Build and push the multi-arch image from the repository root:

```sh
npm run container:publish -- --apply-digest
```

The script derives the tag from root `package.json`, pushes the platforms listed
in `release/container-image.json`, records the published multi-arch digest, and
regenerates both package `exports.sh` files. The Compose files consume that
export:

```yaml
image: ${APP_PEARPASTE_IMAGE}
```

If the image was published elsewhere, pin it without rebuilding:

```sh
npm run container:pin-digest -- --digest sha256:<multi-arch-digest>
```

Sync the HiveRelay community-store checkout after the image ref changes:

```sh
npm run container:sync-store -- --store ../../00-core/blindspark-umbrel-store
npm run container:check-store -- --store ../../00-core/blindspark-umbrel-store
```

## Layout

Copy `pearpaste/` into an official-style Umbrel app store checkout, or copy
`hiverelay-pearpaste/` into the HiveRelay community store checkout. Both
packages proxy Umbrel's launch port to Pear Paste's internal web service on
`${APP_PEARPASTE_WEB_PORT}` and persist the vault store under
`${APP_DATA_DIR}/data`.
