/**
 * Constants for terminal font settings validation and constraints
 * Used in both UI components and store validation
 */

// Font size constraints
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;
// Font weight constraints
const FONT_WEIGHT_MIN = 100;
const FONT_WEIGHT_MAX = 900;
const FONT_WEIGHT_STEP = 100;

// Line height constraints
const LINE_HEIGHT_MIN = 1.0;
const LINE_HEIGHT_MAX = 2.0;
// Letter spacing constraints
const LETTER_SPACING_MIN = -2;
const LETTER_SPACING_MAX = 5;
// Scrollback constraints
const SCROLLBACK_MIN = 1000;
const SCROLLBACK_MAX = 100000;
// Maximum font array length to prevent DoS
const MAX_FONT_FAMILY_LENGTH = 10;

// Valid cursor styles
const VALID_CURSOR_STYLES = ['block', 'underline', 'bar'] as const;
export type CursorStyle = typeof VALID_CURSOR_STYLES[number];

// Hex color regex (3-digit, 6-digit, or 8-digit)
const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
/**
 * Validates a font size value is within bounds
 */
export function isValidFontSize(value: number): boolean {
  return value >= FONT_SIZE_MIN && value <= FONT_SIZE_MAX;
}

/**
 * Validates a font weight value is within bounds and is a multiple of 100
 * CSS font-weight only accepts 100, 200, 300... 900
 */
export function isValidFontWeight(value: number): boolean {
  return (
    value >= FONT_WEIGHT_MIN &&
    value <= FONT_WEIGHT_MAX &&
    value % FONT_WEIGHT_STEP === 0
  );
}

/**
 * Validates a line height value is within bounds
 */
export function isValidLineHeight(value: number): boolean {
  return value >= LINE_HEIGHT_MIN && value <= LINE_HEIGHT_MAX;
}

/**
 * Validates a letter spacing value is within bounds
 */
export function isValidLetterSpacing(value: number): boolean {
  return value >= LETTER_SPACING_MIN && value <= LETTER_SPACING_MAX;
}

/**
 * Validates a scrollback value is within bounds
 */
export function isValidScrollback(value: number): boolean {
  return value >= SCROLLBACK_MIN && value <= SCROLLBACK_MAX;
}

/**
 * Validates a cursor style is one of the valid options
 */
export function isValidCursorStyle(value: string): value is CursorStyle {
  return VALID_CURSOR_STYLES.includes(value as CursorStyle);
}

/**
 * Validates a hex color string
 */
export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_REGEX.test(value);
}

/**
 * Validates font family array
 */
export function isValidFontFamily(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_FONT_FAMILY_LENGTH &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}
