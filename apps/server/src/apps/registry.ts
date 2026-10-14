import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_MANIFEST_FILE, parseAppManifest, type AppManifest } from '@hub/protocol/manifest';

export interface AppEntry {
  name: string;
  dir: string;
  adopted: boolean;
  manifest: AppManifest | null;
  manifestError: string | null;
}

type ManifestFields = Pick<AppEntry, 'adopted' | 'manifest' | 'manifestError'>;

/** Hidden names, `.` and `..`, empty names and anything with a path separator are never apps. */
function isPlausibleName(name: string): boolean {
  return name !== '' && !name.startsWith('.') && !/[/\\]/.test(name);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function notAdopted(manifestError: string | null): ManifestFields {
  return { adopted: false, manifest: null, manifestError };
}

export class AppRegistry {
  private readonly appsDir: string;

  constructor(appsDir: string) {
    this.appsDir = appsDir;
  }

  /** Every git checkout directly in appsDir, sorted by name. Rescans on each call. */
  async list(): Promise<AppEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.appsDir);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return [];
      throw err;
    }
    const candidates = names.filter(isPlausibleName).sort();
    const found = await Promise.all(candidates.map((name) => this.scan(name)));
    return found.filter((entry): entry is AppEntry => entry !== null);
  }

  /** The app called `name`, or null when it is unknown or the name is unsafe. Stats only that folder. */
  async get(name: string): Promise<AppEntry | null> {
    if (!isPlausibleName(name)) return null;
    return this.scan(name);
  }

  private async scan(name: string): Promise<AppEntry | null> {
    const dir = join(this.appsDir, name);
    if (!(await isDirectory(dir)) || !(await exists(join(dir, '.git')))) return null;
    return { name, dir, ...(await this.readManifest(name, dir)) };
  }

  private async readManifest(name: string, dir: string): Promise<ManifestFields> {
    let text: string;
    try {
      text = await readFile(join(dir, APP_MANIFEST_FILE), 'utf8');
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return notAdopted(null);
      return notAdopted(`${APP_MANIFEST_FILE} could not be read (${errorCode(err) ?? 'unknown error'})`);
    }
    const result = parseAppManifest(text);
    if (!result.ok) return notAdopted(result.error);
    if (result.manifest.name !== name) {
      return notAdopted(`manifest name "${result.manifest.name}" does not match the folder name "${name}"`);
    }
    return { adopted: true, manifest: result.manifest, manifestError: null };
  }
}
