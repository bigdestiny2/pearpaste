# Paste Marketing Assets

Upload-ready marketing assets for Paste social profiles, launch posts, website previews, and press materials.

## Quick Picks

- Profile picture: `png/profiles/profile-picture-400x400.png`
- X / Twitter header: `png/banners/x-header-1500x500.png`
- LinkedIn banner: `png/banners/linkedin-banner-1584x396.png`
- YouTube channel art: `png/banners/youtube-header-2560x1440.png`
- Open Graph image: `png/headers/og-image-1200x630.png`
- GitHub social preview: `png/headers/github-social-preview-1280x640.png`
- Launch post: `png/posts/launch-post-1080x1080.png`
- Security post: `png/posts/security-post-1080x1080.png`
- Feature overview: `png/features/feature-overview-wide-1600x900.png`
- Feature card carousel:
  - `png/features/feature-product-overview-1080x1080.png`
  - `png/features/feature-cross-device-sync-1080x1080.png`
  - `png/features/feature-security-model-1080x1080.png`
  - `png/features/feature-notes-search-1080x1080.png`
  - `png/features/feature-pairing-recovery-1080x1080.png`
- Story format: `png/posts/story-1080x1920.png`
- Transparent mark: `icons/paste-mark-512x512.png`

## Brand

- Display name: `Paste`
- Tagline: `One notepad. Every device you own.`
- Support line: `Private clipboard / encrypted on-device`
- Short copy: `Copy on your laptop, paste on your phone. No account. No cloud. No plaintext on relays.`

Use `source/palette.css` for colors and `source/paste-mark.svg` for the canonical mark.

## Editable Sources

The `editable/` SVG files are the source of truth for layout and exact copy. PNG exports live under `png/`, grouped by usage.

## Regenerate

```sh
node assets/marketing/generate.mjs
```

To replace the no-text campaign backdrop, generate or choose a new PNG and run:

```sh
node assets/marketing/generate.mjs --backdrop /absolute/path/to/backdrop.png
```

This script uses `rsvg-convert` for PNG export. If it is missing, the editable SVG files are still usable.
