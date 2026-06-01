// Paste — shared mobile theme tokens. Source: docs/DESIGN_SPEC.md & ui/shared/design-tokens.css.
import { Platform } from 'react-native'

export const theme = Object.freeze({
  color: {
    bg: '#07090c',
    bg2: '#0b0d10',
    surface: '#0f1318',
    surface2: '#141a21',
    line: 'rgba(255,255,255,0.08)',
    line2: 'rgba(255,255,255,0.14)',
    text: '#e9eef3',
    muted: '#9aa6b2',
    faint: '#6b7682',
    mint: '#4ade80',
    cyan: '#22d3ee',
    violet: '#8b7bff',
    accent: '#43e0a0',
    danger: '#ff6b6b',
    warn: '#f1c47b',
    ok: '#4ade80',
    // Matches desktop's --shadow stop: 0 24px 60px -28px rgba(0,0,0,.8)
    shadow: 'rgba(0,0,0,0.8)',
  },
  gradient: {
    brand: ['#4ade80', '#22d3ee', '#6aa9ff'],
    brandStops: [0, 0.6, 1],
    brandSoft: ['rgba(74,222,128,0.16)', 'rgba(34,211,238,0.14)'],
  },
  radius: {
    sm: 8,
    md: 12,
    lg: 16,
    xl: 22,
    pill: 999,
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    '2xl': 24,
    '3xl': 32,
    '4xl': 48,
  },
  font: {
    family: {
      // RN default system font on each platform.
      sans: undefined,
      mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    size: {
      xs: 11,
      sm: 12,
      body: 14,
      md: 15,
      lg: 17,
      xl: 20,
      hero: 34,
    },
    weight: {
      regular: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
      heavy: '800',
    },
  },
})

/**
 * Convenience props for a linear-gradient lib (expo-linear-gradient or
 * react-native-linear-gradient). Don't assume the lib is installed — screens
 * that want a brand gradient can spread this onto the component.
 */
export function gradientProps() {
  return {
    colors: theme.gradient.brand,
    locations: theme.gradient.brandStops,
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  }
}

/**
 * hexA('#4ade80', 0.5) -> 'rgba(74,222,128,0.5)'. Useful for borders/overlays
 * tinted from the palette without baking a separate token.
 */
export function hexA(hex, alpha) {
  let h = String(hex || '').trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6) return `rgba(0,0,0,${alpha})`
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const a = Math.max(0, Math.min(1, Number(alpha)))
  return `rgba(${r},${g},${b},${a})`
}

export default theme
