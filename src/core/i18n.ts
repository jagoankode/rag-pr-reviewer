import { APP, AppKey } from '../locales/app.js';
import { OUTPUT, OutputKey } from '../locales/output.js';

export type Language = 'id' | 'en';

/** Language name as written in AI instructions. */
export const LANGUAGE_NAME: Record<Language, string> = { id: 'Bahasa Indonesia', en: 'English' };

// Follows config.language; loadConfig() keeps it in sync.
let current: Language = 'id';

export function setLanguage(lang?: Language): void {
  current = lang === 'en' ? 'en' : 'id';
}

export function getLanguage(): Language {
  return current;
}

type Vars = Record<string, string | number | boolean>;

/** Replaces {name} placeholders that have a value; any other braces are kept as written. */
function fill(text: string, vars?: Vars): string {
  return vars ? text.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match)) : text;
}

/** App label: menus, prompts, spinners, status lines and errors. */
export function t(key: AppKey, vars?: Vars): string {
  return fill(APP[current][key], vars);
}

/** Review output: terminal report, saved markdown report and the summary/notes of a review result. */
export function out(key: OutputKey, vars?: Vars): string {
  return fill(OUTPUT[current][key], vars);
}
