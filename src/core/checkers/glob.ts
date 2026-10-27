const cache = new Map<string, RegExp>();

function expandBraces(pattern: string): string[] {
  const m = pattern.match(/\{([^{}]*)\}/);
  if (!m) return [pattern];
  return m[1].split(',').flatMap(part => expandBraces(pattern.slice(0, m.index) + part + pattern.slice(m.index! + m[0].length)));
}

function toRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // `**/` matches zero or more directories; a trailing `**` matches everything below.
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Minimal glob: `*`, `?`, `**`, `{a,b}`. A pattern without `/` matches the basename,
 * like .gitignore, so `*.hook.ts` matches `src/a/x.hook.ts`; pass `basename = false` for plain names such as branches.
 */
export function matchGlob(value: string, pattern: string, basename = true): boolean {
  if (pattern === '*' || pattern === '**') return true;
  const name = value.slice(value.lastIndexOf('/') + 1);
  // Decided per alternative: in `{*.ts,lib/**}`, `*.ts` matches the basename and `lib/**` the path.
  return expandBraces(pattern).some(p => {
    let re = cache.get(p);
    if (!re) cache.set(p, re = toRegExp(p));
    return re.test(p.includes('/') || !basename ? value : name);
  });
}

export const matchAny = (value: string, patterns: readonly string[] | undefined, basename = true): boolean =>
  !!patterns && patterns.some(p => matchGlob(value, p, basename));
