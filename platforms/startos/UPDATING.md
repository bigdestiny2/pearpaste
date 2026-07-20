# Updating

## Determining The Upstream Version

Pear Paste is packaged from the Docker image built from the repository root.
The image tag is derived from root `package.json` and the registry/digest live in
`release/container-image.json` alongside the internal web port, Umbrel launch
port, and StartOS preferred launch port:

```sh
npm run container:status
```

The StartOS package version is derived from the same root version plus
`startOsPackageRevision`.

## Applying The Bump

1. Update root `package.json` `version`.
2. If the StartOS package needs a repack without an app version bump, increment
   `startOsPackageRevision` in `release/container-image.json`.
3. Publish and pin the multi-arch image:
   ```sh
   npm run container:publish -- --apply-digest
   ```
4. If the image was published elsewhere, pin the digest directly instead:
   ```sh
   npm run container:pin-digest -- --digest sha256:<multi-arch-digest>
   ```
5. Update `startos/versions/current.ts` release notes.
6. Run `npm run container:check` and `npm run startos:verify`, then
   `cd platforms/startos && npm ci && make x86 && make arm`.
