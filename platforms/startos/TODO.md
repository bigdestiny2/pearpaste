# StartOS Release Gates

This file tracks the StartOS marketplace gates that cannot be closed from source
inspection alone.

## Image Reference

- Current image tag is derived from root `package.json` and
  `release/container-image.json`.
- Before marketplace submission, run `npm run container:publish -- --apply-digest`
  or `npm run container:pin-digest -- --digest sha256:<multi-arch-digest>`.
- Preferred final proof: the immutable registry digest recorded in
  `release/container-image.json` for the same image that produced the submitted
  `.s9pk`.

## Package Proof

Run from `platforms/startos` after the image is published:

```sh
npm run --prefix ../.. container:check
npm run --prefix ../.. startos:verify
npm ci
make x86
make arm
```

Expected result: the compiled manifest verifies against root release metadata,
then both `.s9pk` artifacts build from the release image and can be sideloaded
into StartOS.

Packing prerequisites: `start-cli` from the matching StartOS release and
`mksquashfs` on `PATH` (`brew install squashfs` on macOS).

## Gallery Proof

- Capture StartOS gallery screenshots on real StartOS hardware.
- Record StartOS version, hardware model, package version, image tag or digest,
  and `.s9pk` filenames beside the screenshots.
- Do not mark marketplace-ready until the screenshots and sideload notes are
  attached to the release evidence.
