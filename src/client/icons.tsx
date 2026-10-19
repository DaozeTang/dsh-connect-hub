/**
 * Inline SVG glyphs. No external assets or icon fonts: every mark is
 * hand-authored on the 16px grid, strokes use `currentColor`, and sizes are
 * controlled by the caller. Decorative marks are aria-hidden; a control that
 * needs a name supplies its own label.
 */

import type { ReactNode, SVGProps } from 'react'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number
}

function Glyph({ size = 16, children, ...rest }: IconProps & { children: ReactNode }): JSX.Element {
  const { className, ...svgProps } = rest
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...svgProps}
    >
      {children}
    </svg>
  )
}

export function IconRefresh({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <path d="M13.4 8a5.4 5.4 0 1 1-1.58-3.82" />
      <path d="M13.6 2.7v3.1h-3.1" />
    </Glyph>
  )
}

export function IconSearch({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <circle cx="6.9" cy="6.9" r="4.1" />
      <path d="m10.1 10.1 3.2 3.2" />
    </Glyph>
  )
}

export function IconCheck({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <path d="m3.4 8.4 3 3 6.2-7.1" />
    </Glyph>
  )
}

export function IconClose({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" />
    </Glyph>
  )
}

export function IconWarning({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <path d="M7 3.1a1.15 1.15 0 0 1 2 0l5 8.7a1.15 1.15 0 0 1-1 1.72H3a1.15 1.15 0 0 1-1-1.72z" />
      <path d="M8 6.3v3.1" />
      <path d="M8 11.6h.01" />
    </Glyph>
  )
}

export function IconInfo({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 7.2v3.6" />
      <path d="M8 4.9h.01" />
    </Glyph>
  )
}

export function IconError({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="m5.9 5.9 4.2 4.2M10.1 5.9l-4.2 4.2" />
    </Glyph>
  )
}

export function IconKey({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <circle cx="5.4" cy="10.6" r="2.9" />
      <path d="m7.6 8.4 5.6-5.6" />
      <path d="m11.1 3 1.9 1.9M9.4 4.7l1.9 1.9" />
    </Glyph>
  )
}

export function IconCoins({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <ellipse cx="8" cy="4.7" rx="5" ry="2.2" />
      <path d="M3 4.7v3.2c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V4.7" />
      <path d="M3 7.9v3.4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V7.9" />
    </Glyph>
  )
}

export function IconShield({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <path d="M8 2.1 13 4v3.8c0 3-2 5.1-5 6.1-3-1-5-3.1-5-6.1V4z" />
      <path d="m5.8 7.9 1.6 1.6 2.9-3.2" />
    </Glyph>
  )
}

export function IconExport({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <path d="M2.8 10.5v2.3a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-2.3" />
      <path d="M8 2.4v7.2" />
      <path d="M5.2 6.8 8 9.6l2.8-2.8" />
    </Glyph>
  )
}

export function IconImport({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <path d="M2.8 10.5v2.3a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-2.3" />
      <path d="M8 10V2.8" />
      <path d="M5.2 5.6 8 2.8l2.8 2.8" />
    </Glyph>
  )
}

export function IconCalendar({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <rect x="2.6" y="3.4" width="10.8" height="10" rx="1.6" />
      <path d="M2.6 6.4h10.8M5.5 2.2v2.4M10.5 2.2v2.4" />
    </Glyph>
  )
}

export function IconModels({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <rect x="2.2" y="2.6" width="7.4" height="7.4" rx="1.6" />
      <rect x="6.4" y="6.4" width="7.4" height="7.4" rx="1.6" />
    </Glyph>
  )
}

export function IconSliders({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <Glyph size={size} {...rest}>
      <path d="M2.4 5.2h11.2M2.4 10.8h11.2" />
      <circle cx="6.1" cy="5.2" r="1.6" />
      <circle cx="9.9" cy="10.8" r="1.6" />
    </Glyph>
  )
}
