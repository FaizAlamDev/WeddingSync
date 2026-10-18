export const colors = {
  background: '#FFFFFF',
  surface: '#F5F5F7',
  surfaceAlt: '#EBEBEF',

  text: '#14141A',
  textMuted: '#5A5A66',
  textInverse: '#FFFFFF',

  primary: '#7B2D43', // deep maroon
  primaryDark: '#5E1F31',
  primarySoft: '#F6E9ED',

  success: '#1B7A43',
  successSoft: '#E4F3EA',
  danger: '#B3261E',
  dangerSoft: '#FBE9E7',

  border: '#D8D8DE',
  focus: '#7B2D43',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const borderWidth = {
  hairline: 1,
  strong: 2,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const fontSize = {
  sm: 13,
  body: 16,
  lg: 18,
  xl: 20,
  xxl: 26,
} as const;

export type AppTheme = typeof colors & { dark: false };
