import path from 'path';
import { Primitive, RawFinding } from './types.js';
import { CheckOf } from './spec.js';
import { matchGlob } from './glob.js';

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Literal text with glob wildcards: `*` and `?` mean what they mean in matchGlob. */
const wildcards = (part: string): string => part.replace(/[.+^$()|[\]\\{}]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');

/** `{name}.view.tsx` → regex capturing the unit name; `{a,b}` alternatives, `*` and `?` are allowed too. */
function anchorRegExp(anchor: string): RegExp {
  const re = anchor.split(/(\{name\}|\{[^{}]*\})/).map(part =>
    part === '{name}' ? '(.+?)' : /^\{.*\}$/.test(part) ? `(?:${part.slice(1, -1).split(',').map(wildcards).join('|')})` : wildcards(part)).join('');
  return new RegExp(`^${re}$`);
}

/**
 * Units in a folder are identified by anchor files; each unit must have the required sibling files.
 * Reported once per unit, on its first anchor file, at line 1. `{name}` and `{file}` are available to the message.
 */
export const requireFiles: Primitive<CheckOf<'require-files'>> = ({ input, spec }) => {
  const out: RawFinding[] = [];
  const folder = path.posix.dirname(input.file);
  const anchors = spec.anchors.map(anchorRegExp);
  const names = [...new Set(input.folderFiles.flatMap(f => anchors.map(a => f.match(a)?.[1]).filter((n): n is string => !!n)))].sort(compare);
  const base = path.posix.basename(input.file);
  for (const name of names) {
    const own = input.folderFiles.filter(f => anchors.some(a => f.match(a)?.[1] === name)).sort(compare)[0];
    if (base !== own) continue;
    for (const required of spec.required) {
      const condition = required.if?.replace(/\{name\}/g, name);
      if (condition && !input.folderFiles.some(f => matchGlob(f, condition))) continue;
      const file = required.file.replace(/\{name\}/g, name);
      if (!input.folderFiles.some(f => matchGlob(f, file))) out.push({ line: 1, column: 1, key: `missing:${file}`, values: { name, file, value: `${folder}/${file}`, text: file } });
    }
  }
  return out;
};
