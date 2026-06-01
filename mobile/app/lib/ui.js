// Paste — shared RN UI primitives. These mirror the website CSS components in
// `website/styles.css` (eyebrow, gradient text, card, chip, button, sealed-row,
// terminal panel) so every screen reads from one consistent visual language.
//
// Gradient note: `expo-linear-gradient` IS installed in the Expo host that
// actually boots (`mobile/pearpaste-expo/package.json`). The earlier swarm
// note that no gradient lib was present applied to the other host
// (`mobile/PearPasteMobile/`) which is not the running app. So the primary
// button, brand mark, sealed pill, etc. now use real LinearGradient.
// MaskedView (`@react-native-masked-view/masked-view`) is NOT installed, so
// gradient-text (background-clip: text equivalent) is approximated with the
// gradient applied to bordering / ringing chrome around solid mint text.

import React from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { theme, hexA, gradientProps } from './theme'

// ---------- typography ----------

export function H1 ({ children, style }) {
  return <Text style={[styles.h1, style]}>{children}</Text>
}

export function H2 ({ children, style }) {
  return <Text style={[styles.h2, style]}>{children}</Text>
}

export function Lede ({ children, style }) {
  return <Text style={[styles.lede, style]}>{children}</Text>
}

export function Hint ({ children, style }) {
  return <Text style={[styles.hint, style]}>{children}</Text>
}

// The website's eyebrow label: a 22-px mint underline-bar then the kicker
// text in uppercase mint with wide letter-spacing.
export function Eyebrow ({ children, style }) {
  return (
    <View style={[styles.eyebrowRow, style]}>
      <View style={styles.eyebrowBar} />
      <Text style={styles.eyebrowText}>{String(children || '').toUpperCase()}</Text>
    </View>
  )
}

// Gradient-text fallback: RN has no css `background-clip: text` and the
// MaskedView lib isn't installed, so the "accent word" inside a heading is
// rendered as solid mint. Use `<H1>{prefix}<GradientWord>{word}</GradientWord></H1>`.
export function GradientWord ({ children, style }) {
  return <Text style={[{ color: theme.color.mint, fontWeight: '700' }, style]}>{children}</Text>
}

// ---------- containers ----------

export function Card ({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>
}

// Banner: tinted card with a colored 1-px border. `kind` picks the palette.
export function Banner ({ kind = 'ok', children, style }) {
  const palette = {
    ok: { border: hexA(theme.color.mint, 0.35), bg: hexA(theme.color.mint, 0.08), text: theme.color.mint },
    warn: { border: hexA(theme.color.warn, 0.35), bg: hexA(theme.color.warn, 0.08), text: theme.color.warn },
    error: { border: hexA(theme.color.danger, 0.35), bg: hexA(theme.color.danger, 0.08), text: theme.color.danger },
    info: { border: theme.color.line2, bg: hexA('#22d3ee', 0.06), text: theme.color.text }
  }[kind] || {}
  return (
    <View style={[styles.banner, { borderColor: palette.border, backgroundColor: palette.bg }, style]}>
      <Text style={[styles.bannerText, { color: palette.text }]}>{children}</Text>
    </View>
  )
}

// ---------- chip / pill ----------

export function Chip ({ children, style, tone = 'muted' }) {
  // 'gradient' tone: gradient ring around a tinted pill. Used by the sealed
  // badge in <SealedRow>. Rendered via <GradientBorder> for a 1-px ring.
  if (tone === 'gradient') {
    return (
      <GradientBorder
        radius={theme.radius.pill}
        thickness={1}
        style={[styles.gradientChipWrap, style]}
        innerStyle={{ backgroundColor: hexA(theme.color.mint, 0.1) }}
      >
        <View style={styles.gradientChipInner}>
          {/* Was theme.color.mint on a 10%-mint background → mint-on-mint,
              unreadable on the sealed-device badge. Plain light foreground
              text reads cleanly while the gradient ring still signals the
              "encrypted / unresolved" affordance. */}
          <Text style={[styles.chipText, { color: theme.color.text }]}>{children}</Text>
        </View>
      </GradientBorder>
    )
  }
  // tone:'mint' had the same mint-on-mint problem on the "active" device pill;
  // switch the foreground to plain light text but keep the mint border + tint
  // so the affirmative semantics remain.
  const toneColor = tone === 'mint' ? theme.color.text : theme.color.muted
  const toneBorder = tone === 'mint' ? hexA(theme.color.mint, 0.45) : theme.color.line
  const toneBg = tone === 'mint' ? hexA(theme.color.mint, 0.12) : 'rgba(255,255,255,0.03)'
  return (
    <View style={[styles.chip, { borderColor: toneBorder, backgroundColor: toneBg }, style]}>
      <Text style={[styles.chipText, { color: toneColor }]}>{children}</Text>
    </View>
  )
}

// ---------- gradient border ----------

/**
 * Pattern for "gradient borders" on RN: there's no native CSS-style gradient
 * border, so we render a <LinearGradient> with `padding: thickness` and place
 * an opaque inner View on top. The thickness becomes the visible ring.
 *
 * The inner View's radius is `radius - thickness` so the corners stay concentric.
 * `overflow: 'hidden'` on the inner ensures children with their own bg respect
 * the rounded mask.
 */
export function GradientBorder ({ children, radius = theme.radius.lg, style, innerStyle, thickness = 1.5 }) {
  return (
    <LinearGradient {...gradientProps()} style={[{ borderRadius: radius, padding: thickness }, style]}>
      <View style={[{ borderRadius: Math.max(0, radius - thickness), backgroundColor: theme.color.surface, overflow: 'hidden' }, innerStyle]}>
        {children}
      </View>
    </LinearGradient>
  )
}

// ---------- buttons ----------

/**
 * Primary: real mint→cyan→blue LinearGradient bg, dark text (matches the
 *          website's `.btn.primary` linear-gradient(120deg, …)).
 * Ghost:   transparent bg, 1-px line border.
 * Danger:  warn-colored border + text on transparent bg.
 *
 * The gradient is rendered with `expo-linear-gradient`, which IS installed in
 * the Expo host (verified vs `mobile/pearpaste-expo/package.json`).
 * Ghost/danger/secondary stay as flat 1-px borders to preserve hierarchy —
 * gradient is reserved for the highest-emphasis action.
 */
export function Button ({ kind = 'primary', onPress, disabled, busy, children, style, textStyle, accessibilityLabel }) {
  const layout = {
    primary: {
      container: { borderColor: 'transparent' },
      // Black text on the mint→cyan→blue gradient. The website's `.btn.primary`
      // uses near-black `#04130d`; on Android the saturated brand colours read
      // best with plain black for maximum luminance contrast — the previous
      // white/mint-derived value washed out into the gradient.
      text: { color: '#000000', fontWeight: '700' }
    },
    ghost: {
      container: { backgroundColor: 'transparent', borderColor: theme.color.line2 },
      text: { color: theme.color.text, fontWeight: '600' }
    },
    danger: {
      container: { backgroundColor: 'transparent', borderColor: hexA(theme.color.danger, 0.6) },
      text: { color: theme.color.danger, fontWeight: '700' }
    },
    secondary: {
      container: { backgroundColor: theme.color.surface, borderColor: theme.color.line2 },
      text: { color: theme.color.text, fontWeight: '600' }
    }
  }[kind] || {}

  const body = busy
    ? <ActivityIndicator color={layout.text?.color || theme.color.text} />
    : <Text style={[styles.btnText, layout.text, textStyle]}>{children}</Text>

  if (kind === 'primary') {
    return (
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled || busy}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: !!(disabled || busy) }}
        activeOpacity={0.85}
        style={[(disabled || busy) && { opacity: 0.5 }, style]}
      >
        <LinearGradient
          {...gradientProps()}
          style={[styles.btn, layout.container, styles.btnPrimaryShadow]}
        >
          {body}
        </LinearGradient>
      </TouchableOpacity>
    )
  }

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!(disabled || busy) }}
      style={[styles.btn, layout.container, (disabled || busy) && { opacity: 0.5 }, style]}
    >
      {body}
    </TouchableOpacity>
  )
}

// ---------- list row ----------

/**
 * Standard sealed list row. Left: 36×36 rounded square with mint tint
 * background + a unicode icon glyph (no SVG dep — see Metro OPTIONAL_STUBS).
 * Middle: title + meta. Right: mint "sealed" pill.
 */
export function SealedRow ({ icon = '◐', title, meta, badge = 'sealed', badgeTone = 'gradient', onPress, right }) {
  const inner = (
    <View style={styles.sealedRow}>
      <View style={styles.sealedIcon}>
        <Text style={styles.sealedIconGlyph}>{icon}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.sealedTitle}>{title}</Text>
        {meta ? <Text style={styles.sealedMeta}>{meta}</Text> : null}
      </View>
      {right || (badge ? <Chip tone={badgeTone}>{badge}</Chip> : null)}
    </View>
  )
  if (!onPress) return inner
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="button">
      {inner}
    </TouchableOpacity>
  )
}

// ---------- input ----------

// Re-exported style block — screens can spread this onto a <TextInput> rather
// than declaring their own input style. Kept as styles so multiline/secure
// modifiers still work as TextInput props on the screen.
export const inputStyle = {
  backgroundColor: theme.color.surface,
  color: theme.color.text,
  borderColor: theme.color.line,
  borderWidth: 1,
  borderRadius: theme.radius.md,
  padding: 14,
  fontSize: theme.font.size.lg,
  marginBottom: theme.spacing.md
}

// ---------- terminal proof panel ----------

/**
 * Mac-window terminal panel for the verifier output (matches website
 * `.proof`). `lines` is an array of `{ kind: 'ok'|'dim'|'warn'|'cmd', text }`.
 */
export function TerminalPanel ({ lines = [], filename = 'paste-verifier' }) {
  const kindColor = {
    ok: theme.color.mint,
    dim: theme.color.faint,
    warn: theme.color.warn,
    cmd: theme.color.cyan,
    text: '#b9c4cd'
  }
  return (
    <View style={styles.terminalWrap}>
      <View style={styles.terminalBar}>
        <View style={styles.terminalDots}>
          <View style={styles.terminalDot} />
          <View style={styles.terminalDot} />
          <View style={styles.terminalDot} />
        </View>
        <Text style={styles.terminalFile}>{filename}</Text>
      </View>
      <View style={styles.terminalBody}>
        {lines.map((l, i) => {
          const k = (l && l.kind) || 'text'
          return (
            <Text key={i} style={[styles.terminalLine, { color: kindColor[k] || kindColor.text }]}>
              {String(l && l.text != null ? l.text : '')}
            </Text>
          )
        })}
      </View>
    </View>
  )
}

// ---------- brand mark ----------

// Brand wordmark — no SVG dep available, so use a glyph + text. The website
// stroke-gradient is approximated with solid mint here. Used for small-context
// placements (topbars, in-screen inline brand). For the splash / unlock hero
// use <GradientBrandMark> below — that's the full gradient treatment.
export function BrandMark ({ size = theme.font.size.hero }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <View style={{
        width: size * 0.9, height: size * 0.9, borderRadius: 10,
        borderWidth: 1.5, borderColor: theme.color.mint,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: hexA(theme.color.mint, 0.08), marginRight: 12
      }}>
        <Text style={{ color: theme.color.mint, fontSize: size * 0.5, fontWeight: '700' }}>P</Text>
      </View>
      <Text style={{ color: theme.color.text, fontSize: size, fontWeight: '700', letterSpacing: -0.5 }}>Paste</Text>
    </View>
  )
}

/**
 * Hero brand mark with the signature mint→cyan→blue gradient applied to the
 * icon ring (via <GradientBorder>) and to a subtle underline accent below the
 * wordmark. Used on the splash and the unlock-screen hero.
 *
 * Gradient-text on the wordmark itself would require
 * `@react-native-masked-view/masked-view` (not installed — verified vs
 * `mobile/pearpaste-expo/package.json`), so the wordmark stays in solid
 * `theme.color.text` and the gradient is expressed via the ring around the P
 * glyph plus a 3-px gradient bar accent under "Paste". This still reads as
 * gradient-branded without pulling in another native dep.
 *
 *  - `iconSize`  : px width/height of the rounded P-glyph square
 *  - `wordSize`  : px font size of "Paste"
 *  - `tagline`   : optional muted line below the wordmark
 */
export function GradientBrandMark ({ iconSize = 64, wordSize = theme.font.size.hero, tagline, style }) {
  return (
    <View style={[{ alignItems: 'center' }, style]}>
      <GradientBorder
        radius={iconSize * 0.28}
        thickness={2}
        innerStyle={{ backgroundColor: theme.color.bg2 }}
        style={{ marginBottom: 14 }}
      >
        <View style={{ width: iconSize, height: iconSize, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: theme.color.mint, fontSize: iconSize * 0.55, fontWeight: '800', letterSpacing: -1 }}>P</Text>
        </View>
      </GradientBorder>
      <Text style={{ color: theme.color.text, fontSize: wordSize, fontWeight: '700', letterSpacing: -0.6 }}>Paste</Text>
      {/* 3-px gradient underline bar — small, centered, sits flush under wordmark. */}
      <LinearGradient
        {...gradientProps()}
        style={{ width: Math.max(48, wordSize * 1.6), height: 3, borderRadius: 2, marginTop: 8 }}
      />
      {tagline
        ? <Text style={{ color: theme.color.muted, fontSize: 14, marginTop: 12, textAlign: 'center', lineHeight: 20 }}>{tagline}</Text>
        : null}
    </View>
  )
}

// ---------- shared styles ----------

const styles = StyleSheet.create({
  h1: {
    color: theme.color.text,
    fontSize: theme.font.size.hero,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: theme.spacing.sm
  },
  h2: {
    color: theme.color.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginBottom: theme.spacing.sm
  },
  lede: {
    color: theme.color.muted,
    fontSize: 16,
    lineHeight: 24,
    marginBottom: theme.spacing.lg
  },
  hint: {
    color: theme.color.faint,
    fontSize: 13,
    lineHeight: 19
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
    gap: 8
  },
  eyebrowBar: {
    width: 22,
    height: 1.5,
    backgroundColor: theme.color.accent,
    opacity: 0.7,
    marginRight: 8
  },
  eyebrowText: {
    color: theme.color.accent,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.6
  },
  card: {
    backgroundColor: theme.color.surface,
    borderColor: theme.color.line,
    borderWidth: 1,
    borderRadius: theme.radius.lg,
    padding: 20
  },
  banner: {
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: theme.spacing.md
  },
  bannerText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500'
  },
  chip: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: theme.radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 12
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600'
  },
  btn: {
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48
  },
  btnText: {
    fontSize: 15
  },
  // Slight elevation under the gradient primary so it pops off cards.
  btnPrimaryShadow: {
    shadowColor: theme.color.mint,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4
  },
  gradientChipWrap: {
    alignSelf: 'flex-start'
  },
  gradientChipInner: {
    paddingVertical: 5,
    paddingHorizontal: 11
  },
  sealedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.color.line,
    backgroundColor: 'rgba(255,255,255,0.02)',
    marginBottom: 10
  },
  sealedIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: hexA(theme.color.mint, 0.1),
    borderWidth: 1,
    borderColor: theme.color.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12
  },
  sealedIconGlyph: {
    color: theme.color.accent,
    fontSize: 18,
    fontWeight: '700'
  },
  sealedTitle: {
    color: theme.color.text,
    fontSize: 15,
    fontWeight: '600'
  },
  sealedMeta: {
    color: theme.color.faint,
    fontSize: 12,
    marginTop: 3
  },
  terminalWrap: {
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.color.line,
    backgroundColor: '#070b0a',
    overflow: 'hidden'
  },
  terminalBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomColor: theme.color.line,
    borderBottomWidth: 1
  },
  terminalDots: {
    flexDirection: 'row',
    gap: 6,
    flex: 1
  },
  terminalDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#2a3139',
    marginRight: 6
  },
  terminalFile: {
    color: theme.color.faint,
    fontSize: 11,
    fontFamily: theme.font.family.mono
  },
  terminalBody: {
    padding: 16,
    paddingTop: 12
  },
  terminalLine: {
    fontFamily: theme.font.family.mono,
    fontSize: 12.5,
    lineHeight: 20
  }
})

export default {
  H1, H2, Lede, Hint, Eyebrow, GradientWord,
  Card, Banner, Chip, Button, SealedRow, GradientBorder,
  TerminalPanel, BrandMark, GradientBrandMark, inputStyle
}
