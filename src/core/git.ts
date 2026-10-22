import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitDiffOptions {
  staged?: boolean;
  branch?: string;
  cwd?: string;
}

/**
 * Mengambil diff dari git (staged, uncommitted vs working tree, atau antar branch)
 */
export async function getGitDiff(options: GitDiffOptions = {}): Promise<string> {
  const args = ['diff'];
  
  if (options.staged) {
    args.push('--staged');
  } else if (options.branch) {
    args.push(options.branch);
  }

  // Filter diff stats dan file exclusion jika perlu
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: options.cwd || process.cwd(),
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return stdout;
  } catch (err: any) {
    throw new Error(`Gagal mengambil git diff: ${err.message}`);
  }
}

/**
 * Cek apakah direktori merupakan git repository
 */
export async function isGitRepo(cwd: string = process.cwd()): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return true;
  } catch {
    return false;
  }
}
