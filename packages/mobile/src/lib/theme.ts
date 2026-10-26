import { storage } from './platform.js'

export type Theme = 'dark' | 'light' | 'system'
export type TextSize = 'small' | 'default' | 'large' | 'xl'

const THEME_KEY = 'theme-preference'
const TEXT_SIZE_KEY = 'text-size-preference'

// Define light theme palette (high contrast)
const lightTheme = {
  'ink-950': '#ffffff',
  'ink-900': '#f5f5f5',
  'ink-850': '#efefef',
  'ink-800': '#e8e8e8',
  'ink-700': '#e0e0e0',
  'ink-600': '#d0d0d0',
  'ink-500': '#a0a0a0',
  'ink-400': '#707070',
  'ink-300': '#404040',
  'ink-200': '#202020',
  'ink-100': '#000000',
  'mint-500': '#006b47',
  'mint-600': '#008c5c',
  'mint-900': '#e8f5f0',
  'amber-glow': '#d87d2d',
  'amber-dim': '#fef3e6',
  'rose-glow': '#c6352a',
  'rose-dim': '#fee8e6',
}

const darkTheme = {
  'ink-950': '#090a0c',
  'ink-900': '#0b0c0e',
  'ink-850': '#121418',
  'ink-800': '#171a1f',
  'ink-700': '#1f242b',
  'ink-600': '#2a3038',
  'ink-500': '#3a424d',
  'ink-400': '#5b6573',
  'ink-300': '#8b939f',
  'ink-200': '#b9c0c9',
  'ink-100': '#e7e9ec',
  'mint-500': '#6ee7a8',
  'mint-600': '#3fc98a',
  'mint-900': '#0e2119',
  'amber-glow': '#f0b429',
  'amber-dim': '#2a2008',
  'rose-glow': '#f2706b',
  'rose-dim': '#2a1413',
}

const textSizeScales: Record<TextSize, number> = {
  small: 0.9,
  default: 1,
  large: 1.1,
  xl: 1.25,
}

export async function getThemePreference(): Promise<Theme> {
  const stored = await storage.get(THEME_KEY)
  return (stored as Theme) || 'system'
}

export async function setThemePreference(theme: Theme): Promise<void> {
  await storage.set(THEME_KEY, theme)
  applyTheme()
}

export async function getTextSizePreference(): Promise<TextSize> {
  const stored = await storage.get(TEXT_SIZE_KEY)
  return (stored as TextSize) || 'default'
}

export async function setTextSizePreference(size: TextSize): Promise<void> {
  await storage.set(TEXT_SIZE_KEY, size)
  applyTextSize()
}

export function getEffectiveTheme(): 'dark' | 'light' {
  const preference = localStorage.getItem(THEME_KEY) as Theme | null
  if (preference === 'dark') return 'dark'
  if (preference === 'light') return 'light'
  // System preference
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(): void {
  const theme = getEffectiveTheme()
  const palette = theme === 'dark' ? darkTheme : lightTheme
  const root = document.documentElement

  Object.entries(palette).forEach(([key, value]) => {
    root.style.setProperty(`--color-${key}`, value)
  })

  root.style.colorScheme = theme
  if (theme === 'light') {
    root.classList.add('light-theme')
  } else {
    root.classList.remove('light-theme')
  }
}

export function applyTextSize(): void {
  const stored = localStorage.getItem(TEXT_SIZE_KEY) as TextSize | null
  const size = stored || 'default'
  const scale = textSizeScales[size]
  const root = document.documentElement
  const baseFontSize = 15 * scale
  root.style.fontSize = `${baseFontSize}px`
}

export function initializeTheme(): void {
  // Apply stored preferences on app load
  const theme = localStorage.getItem(THEME_KEY) as Theme | null
  const textSize = localStorage.getItem(TEXT_SIZE_KEY) as TextSize | null

  if (theme) {
    localStorage.setItem(THEME_KEY, theme)
  }
  if (textSize) {
    localStorage.setItem(TEXT_SIZE_KEY, textSize)
  }

  applyTheme()
  applyTextSize()

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) as Theme | null) === 'system') {
      applyTheme()
    }
  })
}
