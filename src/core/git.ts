import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitDiffOptions {
  staged?: boolean;
  branch?: string;        // Target base branch (legacy / quick option)
  targetBranch?: string;  // Base branch (e.g. main, origin/main)
  sourceBranch?: string;  // Head / feature branch (e.g. feature-x, origin/feature-x, or HEAD)
  fetchRemote?: boolean;  // Optional git fetch before diff
  cwd?: string;
}

/**
 * Mengambil diff dari git:
 * 1. Staged diff (`git diff --staged`)
 * 2. Uncommitted changes (`git diff`)
 * 3. Branch comparison: PR style `git diff <target>...<source>`
 */
export async function getGitDiff(options: GitDiffOptions = {}): Promise<string> {
  const cwd = options.cwd || process.cwd();

  // Jika user membandingkan origin branch, opsional fetch remote terlebih dahulu
  if (options.fetchRemote) {
    try {
      await execFileAsync('git', ['fetch', '--all', '--prune'], { cwd });
    } catch {
      // Abaikan jika offline / fetch gagal
    }
  }

  const args = ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', '--no-renames', '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/'];

  if (options.staged) {
    args.push('--staged');
  } else if (options.targetBranch && options.sourceBranch) {
    // PR semantics: git diff <target>...<source>
    // Membandingkan perubahan pada source sejak bercabang dari target
    args.push(`${options.targetBranch}...${options.sourceBranch}`);
  } else if (options.targetBranch) {
    args.push(options.targetBranch);
  } else if (options.branch) {
    args.push(options.branch);
  }

  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 15 * 1024 * 1024, // 15MB
    });
    return stdout;
  } catch (err: any) {
    throw new Error(`Gagal mengambil git diff: ${err.message}`);
  }
}

/**
 * Mendapatkan branch lokal & remote (origin/*) yang tersedia di repo
 */
export async function getAvailableBranches(cwd: string = process.cwd()): Promise<{ local: string[]; remote: string[] }> {
  try {
    const { stdout: localOut } = await execFileAsync('git', ['branch', '--format=%(refname:short)'], { cwd });
    const { stdout: remoteOut } = await execFileAsync('git', ['branch', '-r', '--format=%(refname:short)'], { cwd });

    const local = localOut
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    const remote = remoteOut
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0 && !b.includes('->'));

    return { local, remote };
  } catch {
    return { local: [], remote: [] };
  }
}

/**
 * Mendapatkan nama branch saat ini (current branch)
 */
export async function getCurrentBranch(cwd: string = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return stdout.trim() || 'HEAD';
  } catch {
    return 'HEAD';
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
