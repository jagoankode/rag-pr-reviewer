import { readFileSync, existsSync } from 'fs';
import path from 'path';

let cachedVersion = '';

export function getAppVersion(): string {
  if (cachedVersion !== '') {
    return cachedVersion;
  }

  const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

  const candidatePaths = [
    path.resolve(currentDir, '../package.json'),
    path.resolve(currentDir, '../../package.json'),
    path.resolve(currentDir, 'package.json'),
  ];

  for (const pkgPath of candidatePaths) {
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'lumio' && typeof pkg.version === 'string') {
          cachedVersion = pkg.version;
          return cachedVersion;
        }
      } catch {}
    }
  }

  cachedVersion = '2.0.2';
  return cachedVersion;
}
