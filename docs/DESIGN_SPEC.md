# Paste — design spec (ported from website)

Authoritative source: `website/styles.css` + `website/index.html`. This doc
distills it into platform-agnostic tokens so the desktop renderer (CSS) and the
mobile RN app (StyleSheet) produce visually consistent UI.

## Brand

- **Display name everywhere:** `Paste` (never "PearPaste" in user-visible
  strings; npm package, pear app key, Android applicationId are infra and stay
  on `pearpaste` — do NOT change them).
- **Tagline:** "One notepad. Every device you own."
- **Sub-tagline / chip:** "Private clipboard · encrypted on-device".
- **Logo:** clipboard with a lock badge, stroked in the brand gradient (see
  `website/index.html` line ~22 — `<svg viewBox="0 0 32 32">…</svg>`). Reuse
  that exact path; export as `ui/shared/assets/logo.svg` and reference from
  both desktop & mobile.

## Color tokens

```
bg          #07090c    page background
bg-2        #0b0d10    slightly elevated bg
surface     #0f1318    cards, panels
surface-2   #141a21    hover / nested surface
line        rgba(255,255,255,.08)   default 1px borders
line-2      rgba(255,255,255,.14)   hover / emphasized borders
text        #e9eef3    primary text
muted       #9aa6b2    secondary text
faint       #6b7682    tertiary text, captions

mint        #4ade80    primary accent
cyan        #22d3ee    secondary accent
violet      #8b7bff    tertiary accent (sparingly)
accent      #43e0a0    "the accent" used in chip icons, eyebrow underline

danger      #ff6b6b
warn        #f1c47b    (note: website uses #f1c47b; desktop currently uses
                       #e7b75f — converge on f1c47b)
ok          #4ade80    same as mint
```

### Gradient (the signature)

```
grad       linear-gradient(120deg, #4ade80 0%, #22d3ee 60%, #6aa9ff 100%)
grad-soft  linear-gradient(120deg, rgba(74,222,128,.16), rgba(34,211,238,.14))
```

Used on: primary buttons, gradient text (`.gt`), card-icon background tint,
final CTA halo, brand logo SVG stroke.

### Aurora background (page-level)

Two fixed, blurred radial gradients that drift slowly:

```
::before — left:-18vw top:-22vw, 60vw x 60vw, radial mint @ .35, blur 120px
::after  — right:-22vw top:12vh, 60vw x 60vw, radial cyan @ .30, blur 120px
```

Plus a subtle SVG-fractal-noise grain at opacity .035 fixed overlay (see
`website/styles.css:69`). Implementation note for desktop Electron renderer:
this is fine. For mobile RN: simulate with two absolutely-positioned `View`s
using `react-native-linear-gradient` OR — to avoid a new dep — solid radial
approximations via stacked `View`s with low opacity and a large `borderRadius`,
positioned off-screen, with `transform`. If the gradient lib isn't already
present, prefer a flat dark bg with subtle accent glow at top — do not block
the rebrand on installing new libs.

## Radii & shadows

```
radius      16px (cards)
radius-lg   22px (devices, terminal proof panel, CTA)
button      12px
chip        999px (pill)
input       10–12px

shadow      0 24px 60px -28px rgba(0,0,0,.8)
```

## Typography

```
ff   system stack: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", sans-serif
fm   monospace: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace

H1 hero:       clamp(38px, 6.6vw, 76px), letter-spacing -.035em, weight 700
H2 section:    clamp(28px, 4.4vw, 46px), letter-spacing -.02em, weight 700
H3 card:       18px, weight 700
H4 list item:  15.5px, weight 700

body:          14.5–16px, line-height 1.6
small/muted:   13.5px
chip / caption: 11–12.5px
mono code:     12.8–13.5px, line-height 1.85 (for the proof terminal)
```

## Component patterns

### Eyebrow label

Small uppercase kicker above a section title. Mint underline tick before.

```html
<span class="eyebrow">Security model</span>
```

CSS:

```css
display: inline-flex; align-items:center; gap:8px;
font-size: 12.5px; font-weight:600; letter-spacing:.14em; text-transform:uppercase;
color: var(--accent); margin-bottom:18px;
&::before { content:""; width:22px; height:1px; background:var(--accent); opacity:.6; }
```

RN equivalent: a `<View flexDirection:'row' alignItems:'center'>` containing a
2px tall, 22px wide mint bar followed by `<Text style={{ color:accent,
fontSize:12, letterSpacing:1.6, textTransform:'uppercase', fontWeight:'600' }}>`.

### Gradient text (`.gt`)

```css
background: var(--grad);
-webkit-background-clip: text; background-clip: text;
color: transparent;
```

Use for the highlighted word/phrase in a title (e.g. "Every device you
**own**", "Encrypted on your device. **Always.**").

RN: there is no native background-clip:text. Use `MaskedView` from
`@react-native-masked-view/masked-view` IF already present; otherwise fall
back to a solid mint color for the highlighted word — do not block on
installing a library. Document the fallback in code.

### Buttons

Primary (gradient): `background: var(--grad)`, color `#04130d`, weight 600,
border-radius 12, padding 12×20, glow shadow on hover
`0 14px 34px -14px rgba(46,213,162,.7)`.

Ghost: transparent bg, 1px `var(--line-2)` border, color `var(--text)`.

Sizes: default 14.5px/12×20; `sm` 13.5px/9×15.

Hover: `transform: translateY(-1px)`, stronger glow.

Disabled: opacity .5, cursor not-allowed.

### Cards

```
border: 1px solid var(--line);
border-radius: 16px;
background: linear-gradient(180deg, var(--surface), rgba(15,19,24,.55));
padding: 26px;
```

Hover: lift `translateY(-3px)`, border → `var(--line-2)`, shadow `var(--shadow)`.

Card icon block:

```
42x42, border-radius 11px;
background: var(--grad-soft); border: 1px solid var(--line);
color: var(--accent); display:grid; place-items:center;
svg: 21x21
```

### Chip (trust pill)

```
display:inline-flex; gap:7px; padding:7px 12px; border-radius:999px;
font-size:12.5px; color: var(--muted);
background: rgba(255,255,255,.03); border: 1px solid var(--line);
svg: 14x14, color var(--accent)
```

Use for: `No accounts, ever`, `Encrypted on-device`, `Open verifier`,
`Offline-first`.

### Lock pill (status indicator, replaces current `.lockpill`)

Reuse chip styling. When unlocked: mint border + mint text. When locked: warn
border + warn text. Icon: small lock for locked, unlock for unlocked.

### Lists / rows (sealed items)

Replace the current `.row` (which is bordered + padded) with a card-style row:

```
display: flex; gap: 12px; padding: 14px 16px;
border: 1px solid var(--line); border-radius: 14px;
background: rgba(255,255,255,.02);
hover: border var(--line-2), background rgba(255,255,255,.04)
```

Icon column: 36×36 rounded square with `var(--grad-soft)` bg + accent icon.

"Sealed" badge: pill, `border: 1px solid rgba(74,222,128,.25)`, mint text,
mint .08 bg. (Replaces blue `.badge.sealed` in current desktop CSS.)

"Pinned" badge: warn-colored pill.

### Proof terminal panel

Distinct from regular cards — looks like a mac terminal window.

```
border: 1px solid var(--line);
border-radius: 22px;
overflow: hidden;
background: linear-gradient(180deg, #0a0f0d, #070b0a);
shadow: 0 24px 60px -28px rgba(0,0,0,.8);
```

Top bar: 3 dim dots (#2a3139), filename on right in mono+faint.

Body: `<pre>` with mono font, line-height 1.85, color `#b9c4cd`. Color spans:
`.ok` = mint, `.dim` = faint, `.warn` = f1c47b, `.cmd` = cyan.

Use this exact look for the in-app encryption-verifier output.

### FAQ / details disclosure

`<details>` with rotating `+` symbol. Padding 20–22, border 1px line, radius 14,
surface bg. The `+` is mint and rotates 45° when open. Use this for any
"learn more" sections in Settings / About.

### Steps (numbered)

Counter-reset CSS, `counter-increment: s; content: counter(s, decimal-leading-zero);`
in mono+accent. Use for the Pair-device flow's instructional cards.

## Reveal-on-scroll animation

Initial state `opacity:0; translateY(22px)`, transitions to `in` state when
intersected. 0.7s cubic-bezier(.2,.7,.2,1). Staggered with `data-d="1|2|3"`
delays of 70/140/210 ms.

Desktop: copy the website pattern (IntersectionObserver in `app.js` after
mount).

Mobile: skip — RN doesn't have IntersectionObserver and the value-add is
small on small screens. Static layout.

## Accessibility

- Focus ring: `outline: 2px solid var(--cyan); outline-offset: 3px; border-radius: 8px;`
- Honor `prefers-reduced-motion: reduce` — disable aurora drift, reveal
  transitions, and any caret blink.
- Tap targets ≥ 44px on mobile.
- `aria-busy` on app shell during boot (already present).

## Per-platform mapping table

| Token / pattern   | Website CSS    | Desktop CSS         | Mobile RN            |
| ----------------- | -------------- | ------------------- | -------------------- |
| `--bg`            | `#07090c`      | same                | `bg.base`            |
| `--grad`          | linear-grad    | same (kept as var)  | `gradient.brand` array of stops |
| `.gt` text        | bg-clip:text   | same                | MaskedView or fallback solid mint |
| `.card`           | css class      | same                | `View` w/ `theme.card` style     |
| Aurora            | fixed divs     | same                | optional simple glow only        |
| Reveal-on-scroll  | IntersectionObserver | same          | omit                              |

## Tokens file locations (must produce)

- `ui/shared/design-tokens.css` — CSS variables block (`:root { … }`) so
  desktop CSS just `@import`s it. Desktop's `styles.css` keeps everything else
  but reads vars from here so a future shared-app would only update one file.
- `mobile/app/lib/theme.js` — exports a `theme` object: `{ color, gradient,
  radius, spacing, font }`. Each RN screen imports from there.
- `ui/shared/assets/logo.svg` — the brand mark, single file with inline
  gradient defs (so it works as `<img>` and as embedded copy).

## Copy / naming changes summary

| Where                          | Was                  | Now             |
| ------------------------------ | -------------------- | --------------- |
| `COPY.appName` (both copies)   | `PearPaste`          | `Paste`         |
| `COPY.tagline`                 | "Encrypted notes…"   | "One notepad. Every device you own." |
| Window title (`index.html`)    | `PearPaste`          | `Paste`         |
| Splash brand (mobile)          | `PearPaste` text     | logo + `Paste`  |
| `COPY.proofBlurb`              | "PearPaste ships…"   | "Paste ships…"  |
| All in-code header comments    | `PearPaste` mentions | `Paste`         |
| READMEs / docs (top-level only)| `PearPaste`          | `Paste`         |
| `package.json` description     | "PearPaste — …"      | "Paste — …"     |
| `pear.json` description        | "PearPaste — …"      | "Paste — …"     |

**Untouched (infra):**

- `package.json` `name: "pearpaste"`
- `pear.json` `name: "pearpaste"`
- Android `applicationId com.pearpaste`, iOS bundle id
- `mobile/PearPasteMobile/`, `mobile/pearpaste-expo/` dir names
- `docs/PEARPASTE_TECHNICAL_SPEC.md` filename (canonical spec; rename = broken
  references in code comments referencing "spec §N")
- Pear staging key `pear://h5fdao9…`

The verifier in the spec (`COPY.proofRun`: "Run encryption verifier") and all
security-critical phrases ("Pair a device", "Restore with recovery phrase",
"Relays store encrypted blocks", "Reduced availability") are LOCKED — must
stay byte-for-byte. The `assertCopyClean` banned-phrase guard
(`ui/shared/copy.js:90`) must still pass.
