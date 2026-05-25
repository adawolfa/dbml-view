import { en } from './en.js';

export { en } from './en.js';

/** Union of all valid translation keys. */
export type TranslationKey = keyof typeof en;

/** Shape a full locale must satisfy — every key in English must be present. */
export type Translations = Record<TranslationKey, string>;

// The active locale. Starts as English; call setLocale() to switch.
let current: Translations = en;

/**
 * Replace the active locale. Provide a complete `Translations` record.
 * Only needed when adding languages beyond English.
 */
export function setLocale(translations: Translations): void {
  current = translations;
}

/**
 * Return the translation for `key`, substituting any `{name}` placeholders
 * with the matching value from `vars`.
 *
 * @example
 *   t('detail.empty.schema_info', { parts: '3 tables, 1 enum' })
 *   // → '3 tables, 1 enum in this schema.'
 */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = current[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const val = vars[name];
    return val !== undefined ? String(val) : `{${name}}`;
  });
}
