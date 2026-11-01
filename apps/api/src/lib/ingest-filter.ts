// Path filter for repo ingestion. Decides from tree metadata alone, so excluded files are never fetched.

export interface TreeEntry {
  path: string;
  type: string;
  mode: string;
  sha: string;
  size?: number;
}

export type SkipReason =
  | 'symlink'
  | 'submodule'
  | 'unsupported_entry'
  | 'unsafe_path'
  | 'dependency'
  | 'build_output'
  | 'lockfile'
  | 'credential'
  | 'binary'
  | 'too_large'
  | 'not_text';

const DEPENDENCY_DIRS = new Set([
  'node_modules',
  'vendor',
  'bower_components',
  'third_party',
  'Pods',
  '.venv',
  'venv',
]);

const BUILD_DIRS = new Set([
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '__pycache__',
  '.gradle',
  'obj',
  '.turbo',
  '.cache',
]);

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'go.sum',
]);

const KEY_FILES = new Set(['id_rsa', 'id_ecdsa', 'id_ed25519']);
const KEY_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx']);
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

const BINARY_EXTENSIONS = new Set([
  // images and fonts
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'psd',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // media
  'mp3', 'mp4', 'mov', 'wav', 'avi', 'webm',
  // archives and documents
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'pdf',
  // compiled code and data
  'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'pyc', 'wasm', 'sqlite', 'db',
]);

const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const MAX_PATH_LENGTH = 512;

function isUnsafePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return true;
  if (path.startsWith('/') || path.includes('\\')) return true;
  if (/[\x00-\x1f\x7f]/.test(path)) return true;
  return path.split('/').some((s) => s === '' || s === '.' || s === '..');
}

function isCredential(name: string, ext: string): boolean {
  if (name === '.env' || (name.startsWith('.env.') && !ENV_TEMPLATES.has(name))) return true;
  return KEY_FILES.has(name) || KEY_EXTENSIONS.has(ext);
}

/**
 * Returns 'ignore' for directory entries, null to keep a regular file, or the reason it is skipped.
 * Directory rules match whole directory segments only, never the file name itself.
 */
export function filterEntry(entry: TreeEntry, maxFileBytes: number): SkipReason | 'ignore' | null {
  // Mode first: submodules arrive as type 'commit', symlinks as type 'blob'.
  if (entry.mode === '120000') return 'symlink';
  if (entry.mode === '160000') return 'submodule';
  if (entry.type === 'tree') return 'ignore';
  if (entry.type !== 'blob' || !REGULAR_FILE_MODES.has(entry.mode)) return 'unsupported_entry';

  if (isUnsafePath(entry.path)) return 'unsafe_path';

  const segments = entry.path.split('/');
  const name = segments.pop()!;
  if (segments.some((s) => DEPENDENCY_DIRS.has(s))) return 'dependency';
  if (segments.some((s) => BUILD_DIRS.has(s))) return 'build_output';

  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (LOCKFILES.has(name)) return 'lockfile';
  if (isCredential(name, ext)) return 'credential';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';

  if ((entry.size ?? 0) > maxFileBytes) return 'too_large';
  return null;
}
