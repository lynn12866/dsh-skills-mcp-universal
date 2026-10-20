import type {
  SkillRoot,
  SkillItem,
  ScannedSkill,
  ScanResult,
  SkillImportPayload,
  ImportResult,
} from './types.js';
import { readFile, readdir, lstat, realpath, mkdir, cp, rename, stat, rm } from 'node:fs/promises';
import { join, dirname, resolve, basename, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { atomicWrite, fileLock, serial } from './storage.js';

const missing = (error: NodeJS.ErrnoException) =>
  error.code === 'ENOENT' || error.code === 'ENOTDIR';
export function parseSkill(raw: string) {
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/.exec(raw);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter.');
  const document = parseDocument(match[2], { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0].message);
  const meta = document.toJS({ maxAliasCount: 20 });
  if (!meta || typeof meta !== 'object' || Array.isArray(meta))
    throw new Error('Invalid skill metadata.');
  if (typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name))
    throw new Error('Skill name must use lowercase letters, numbers and hyphens.');
  if (typeof meta.description !== 'string' || !meta.description.trim())
    throw new Error('Skill description is required.');
  const boolean = (value: unknown, fallback: boolean) => {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    if (/^(true|yes|on|1)$/i.test(String(value))) return true;
    if (/^(false|no|off|0)$/i.test(String(value))) return false;
    throw new Error('Invalid invocation flag.');
  };
  return {
    document,
    match,
    name: meta.name,
    description: meta.description,
    whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : '',
    modelEnabled: !boolean(meta['disable-model-invocation'], false),
    userEnabled: boolean(meta['user-invocable'], true),
    content: match[4],
  };
}

/** Compare instructions and every resource while ignoring deployment invocation flags. */
export async function skillFingerprint(item: SkillItem): Promise<string> {
  const { document, content } = parseSkill(await readFile(item.path, 'utf8'));
  document.delete('disable-model-invocation');
  document.delete('user-invocable');
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, stable(child)]),
      );
    return value;
  };
  const hash = createHash('sha256').update(
    JSON.stringify([stable(document.toJS({ maxAliasCount: 20 })), content]),
  );
  const walk = async (directory: string, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const key = prefix + entry.name;
      if (key === 'SKILL.md') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Skill bundles must not contain symbolic links.');
      if (entry.isDirectory()) {
        hash.update(JSON.stringify(['directory', key]));
        await walk(path, key + '/');
      } else if (entry.isFile()) {
        const raw = await readFile(path);
        hash.update(JSON.stringify(['file', key, raw.length])).update(raw);
      } else throw new Error('Unsupported Skill resource.');
    }
  };
  if (item.kind === 'bundle') await walk(dirname(item.path));
  return hash.digest('hex');
}

export async function projectRoot(cwd: string) {
  const initial = resolve(cwd);
  let current = initial;
  for (;;) {
    try {
      await lstat(join(current, '.git'));
      return current;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

const inside = (root: string, file: string) => {
  const rel = relative(root, file);
  return rel === '' || (rel.split(/[\\/]/)[0] !== '..' && !isAbsolute(rel));
};

export class Skills {
  home: string;
  agentsHome: string;
  queue = serial();
  scans = new Map<string, { time: number; items: ScannedSkill[] }>();
  constructor({
    home = process.env.DSH_HOME || join(homedir(), '.dsh'),
    agentsHome = process.env.DSH_AGENTS_HOME || join(homedir(), '.agents'),
  } = {}) {
    this.home = resolve(home);
    this.agentsHome = resolve(agentsHome);
    this.queue = serial();
  }

  async roots(cwd?: string): Promise<SkillRoot[]> {
    const roots: SkillRoot[] = [];
    if (cwd) {
      if (!isAbsolute(cwd)) throw new Error('Workspace path must be absolute.');
      const root = await projectRoot(cwd);
      roots.push(
        {
          path: join(root, '.dsh/skills'),
          source: 'project-dsh',
          scope: 'workspace',
          workspace: root,
        },
        {
          path: join(root, '.agents/skills'),
          source: 'project-agents',
          scope: 'workspace',
          workspace: root,
        },
      );
    }
    return [
      ...roots,
      { path: join(this.home, 'skills'), source: 'user-dsh', scope: 'global', workspace: null },
      {
        path: join(this.agentsHome, 'skills'),
        source: 'user-agents',
        scope: 'global',
        workspace: null,
      },
    ];
  }

  async inspect(file: string, extra: Partial<SkillItem> = {}) {
    const raw = await readFile(file, 'utf8');
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024)
      throw new Error('Skill instruction file is too large.');
    const skill = parseSkill(raw);
    const { document, match, ...summary } = skill;
    return { ...summary, path: file, source: 'import', writable: false, ...extra };
  }

  async scanRoot(root: SkillRoot): Promise<SkillItem[]> {
    let entries;
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const items: SkillItem[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      let kind: 'bundle' | 'file';
      let file;
      const base = join(root.path, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        kind = 'bundle';
        file = join(base, 'SKILL.md');
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        kind = 'file';
        file = base;
      } else continue;
      try {
        const target = await realpath(file);
        const rootTarget = await realpath(root.path);
        // Symlinked external bundles remain visible, but mutations are read-only.
        const writable = inside(rootTarget, target) && !entry.isSymbolicLink();
        items.push(
          await this.inspect(file, {
            kind,
            source: root.source,
            scope: root.scope,
            workspace: root.workspace,
            writable,
          }),
        );
      } catch (error) {
        if (!missing(error))
          items.push({
            path: file,
            source: root.source,
            scope: root.scope,
            workspace: root.workspace,
            name: entry.name,
            error: error.message,
            writable: false,
          });
      }
    }
    return items;
  }

  async list(cwd?: string) {
    const items = (
      await Promise.all((await this.roots(cwd)).map((root) => this.scanRoot(root)))
    ).flat();
    return items.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  }

  async managed(file: string, cwd?: string, write = false) {
    const skill = (await this.list(cwd)).find((item) => resolve(item.path) === resolve(file));
    if (!skill) throw new Error('Skill is outside the managed roots.');
    if (write && !skill.writable) throw new Error('This skill is read-only or invalid.');
    return skill;
  }

  async read(file: string, cwd?: string) {
    await this.managed(file, cwd);
    return this.inspect(file);
  }

  async mutate<T>(
    file: string,
    cwd: string | undefined,
    operation: (skill: SkillItem) => Promise<T>,
  ) {
    const initial = await this.managed(file, cwd, true);
    const root = (await this.roots(cwd)).find((root) => root.source === initial.source);
    return fileLock(join(root!.path, '.skills-mcp-operations'), async () =>
      operation(await this.managed(file, cwd, true)),
    );
  }

  async toggle(file: string, enabled: boolean, cwd?: string) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean.');
    return this.queue(() =>
      this.mutate(file, cwd, async () => {
        const raw = await readFile(file, 'utf8');
        const { document, match } = parseSkill(raw);
        document.set('disable-model-invocation', !enabled);
        document.set('user-invocable', enabled);
        const newline = raw.includes('\r\n') ? '\r\n' : '\n';
        const frontmatter = document.toString().trimEnd().replace(/\r?\n/g, newline);
        const mode = (await stat(file)).mode & 0o777;
        await atomicWrite(file, match[1] + frontmatter + match[3] + match[4], mode);
        return this.inspect(file);
      }),
    );
  }

  async applyBatch<T>(
    changes: { path: string; enabled: boolean }[],
    cwd: string | undefined,
    commit: () => Promise<T>,
  ): Promise<T> {
    return this.queue(async () => {
      const roots = await this.roots(cwd);
      const locks = [
        ...new Set(
          await Promise.all(
            changes.map(async (change) => {
              const skill = await this.managed(change.path, cwd, true);
              return join(
                roots.find((root) => root.source === skill.source)!.path,
                '.skills-mcp-operations',
              );
            }),
          ),
        ).values(),
      ].sort();
      const withLocks = async (index: number): Promise<T> => {
        if (index < locks.length) return fileLock(locks[index], () => withLocks(index + 1));
        const prepared = await Promise.all(
          changes.map(async (change) => {
            await this.managed(change.path, cwd, true);
            const raw = await readFile(change.path, 'utf8');
            const { document, match, modelEnabled, userEnabled } = parseSkill(raw);
            document.set('disable-model-invocation', !change.enabled);
            document.set('user-invocable', change.enabled);
            const newline = raw.includes('\r\n') ? '\r\n' : '\n';
            return {
              ...change,
              raw,
              changed: modelEnabled !== change.enabled || userEnabled !== change.enabled,
              mode: (await stat(change.path)).mode & 0o777,
              next:
                match[1] +
                document.toString().trimEnd().replace(/\r?\n/g, newline) +
                match[3] +
                match[4],
            };
          }),
        );
        const written: typeof prepared = [];
        try {
          for (const item of prepared.filter((item) => item.changed)) {
            await atomicWrite(item.path, item.next, item.mode);
            written.push(item);
          }
          return await commit();
        } catch (error) {
          for (const item of written.reverse()) await atomicWrite(item.path, item.raw, item.mode);
          throw error;
        }
      };
      return withLocks(0);
    });
  }

  transfer(file: string, destinationCwd: string, mode: 'copy' | 'move' = 'copy') {
    return this.transferManaged(file, destinationCwd, mode);
  }

  copyForScene(file: string, sourceCwd: string | undefined, destinationCwd: string) {
    return this.transferManaged(file, destinationCwd, 'copy', sourceCwd, true);
  }

  private async transferManaged(
    file: string,
    destinationCwd: string,
    mode: 'copy' | 'move',
    sourceCwd?: string,
    forScene = false,
  ) {
    if (!['copy', 'move'].includes(mode)) throw new Error('Invalid transfer mode.');
    if (!isAbsolute(destinationCwd)) throw new Error('Select an absolute workspace directory.');
    const cwd = await realpath(destinationCwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace must be a directory.');
    return this.queue(async () => {
      const source = await this.managed(file, sourceCwd, mode === 'move');
      if ((!forScene && source.scope !== 'global') || source.error || !source.kind)
        throw new Error('Only valid global skills can be transferred.');
      const destination = join(await projectRoot(cwd), '.dsh/skills');
      const sourceRoot = (await this.roots(sourceCwd)).find(
        (root) => root.source === source.source,
      )!;
      const locks = [
        ...new Set([
          join(sourceRoot.path, '.skills-mcp-operations'),
          join(destination, '.skills-mcp-operations'),
        ]),
      ].sort();
      type Receipt = { path: string; recoveryPath?: string; mode: 'copy' | 'move' };
      const withLocks = async (index: number): Promise<Receipt> => {
        if (index < locks.length) return fileLock(locks[index], () => withLocks(index + 1));
        await this.managed(file, sourceCwd, mode === 'move');
        if (
          (await this.list(cwd)).some(
            (item) => item.scope === 'workspace' && item.name === source.name,
          )
        )
          throw new Error('A workspace skill with this name already exists. Nothing was changed.');
        const target = join(
          destination,
          source.kind === 'bundle' ? source.name : source.name + '.md',
        );
        const temporary = join(destination, '.transfer-' + randomUUID());
        const originalPath = source.kind === 'bundle' ? dirname(file) : file;
        const sourcePath = await realpath(originalPath);
        let published = false;
        try {
          await cp(sourcePath, temporary, {
            recursive: source.kind === 'bundle',
            dereference: false,
            errorOnExist: true,
            force: false,
            filter: async (path) => {
              if ((await lstat(path)).isSymbolicLink())
                throw new Error('Skill bundles must not contain symbolic links.');
              return true;
            },
          });
          const stagedSkill = source.kind === 'bundle' ? join(temporary, 'SKILL.md') : temporary;
          await this.inspect(stagedSkill);
          if (forScene) {
            const raw = await readFile(stagedSkill, 'utf8');
            const { document, match } = parseSkill(raw);
            document.set('disable-model-invocation', true);
            document.set('user-invocable', false);
            const newline = raw.includes('\r\n') ? '\r\n' : '\n';
            await atomicWrite(
              stagedSkill,
              match[1] +
                document.toString().trimEnd().replace(/\r?\n/g, newline) +
                match[3] +
                match[4],
              (await stat(stagedSkill)).mode & 0o777,
            );
          }
          await rename(temporary, target);
          published = true;
          let recoveryPath: string | undefined;
          if (mode === 'move') {
            const trash = join(dirname(originalPath), '.trash');
            await mkdir(trash, { recursive: true });
            recoveryPath = join(trash, basename(originalPath) + '-' + randomUUID());
            await rename(originalPath, recoveryPath);
          }
          return { path: target, recoveryPath, mode };
        } catch (error) {
          await rm(temporary, { recursive: true, force: true });
          if (published) await rm(target, { recursive: true, force: true });
          throw error;
        }
      };
      return withLocks(0);
    });
  }

  async remove(file: string, cwd?: string) {
    return this.queue(() =>
      this.mutate(file, cwd, async (skill) => {
        const target = skill.kind === 'bundle' ? dirname(file) : file;
        const trash = join(dirname(target), '.trash');
        await mkdir(trash, { recursive: true });
        const destination = join(trash, `${basename(target)}-${randomUUID()}`);
        await rename(target, destination);
        return { removed: file, recoveryPath: destination };
      }),
    );
  }

  async scan(directory: string): Promise<ScanResult> {
    if (!isAbsolute(directory))
      throw new Error('Select an absolute directory on the Harness host.');
    const root = await realpath(directory);
    const items: ScannedSkill[] = [];
    try {
      items.push({
        ...(await this.inspect(join(root, 'SKILL.md'))),
        kind: 'bundle',
        sourcePath: root,
      });
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (!items.length) {
      for (const item of await this.scanRoot({ path: root, source: 'import' })) {
        if (!item.error && item.kind)
          items.push({
            ...item,
            kind: item.kind,
            sourcePath: item.kind === 'bundle' ? dirname(item.path) : item.path,
          });
      }
    }
    const token = randomUUID();
    this.scans.set(token, { time: Date.now(), items });
    for (const [id, scan] of this.scans)
      if (Date.now() - scan.time > 15 * 60 * 1000) this.scans.delete(id);
    return { token, items };
  }

  async import({ token, paths, scope = 'user', cwd }: SkillImportPayload): Promise<ImportResult[]> {
    return this.queue(async () => {
      const scan = this.scans.get(token);
      if (!scan || Date.now() - scan.time > 15 * 60 * 1000)
        throw new Error('Scan expired. Scan the directory again.');
      if (!Array.isArray(paths) || !paths.length) throw new Error('Select at least one skill.');
      if (!['user', 'project'].includes(scope)) throw new Error('Invalid scope.');
      if (scope === 'project' && !cwd) throw new Error('Select a workspace first.');
      const destination =
        scope === 'project'
          ? join(await projectRoot(cwd!), '.dsh/skills')
          : join(this.home, 'skills');
      await mkdir(destination, { recursive: true });
      return fileLock(join(destination, '.skills-mcp-operations'), async () => {
        const results: ImportResult[] = [];
        for (const selectedPath of [...new Set(paths)]) {
          const sourcePath = await realpath(selectedPath);
          const item = scan.items.find((value) => value.sourcePath === sourcePath);
          if (!item) throw new Error('Only scanned skills may be imported.');
          const target = join(destination, item.kind === 'bundle' ? item.name : item.name + '.md');
          const temporary = join(destination, '.import-' + randomUUID());
          try {
            try {
              await lstat(target);
              throw new Error('A skill with this name already exists.');
            } catch (error) {
              if (!missing(error)) throw error;
            }
            await this.inspect(item.kind === 'bundle' ? join(sourcePath, 'SKILL.md') : sourcePath);
            await cp(sourcePath, temporary, {
              recursive: item.kind === 'bundle',
              dereference: false,
              errorOnExist: true,
              force: false,
              filter: async (source) => {
                if ((await lstat(source)).isSymbolicLink())
                  throw new Error('Import bundles must not contain symbolic links.');
                return true;
              },
            });
            await rename(temporary, target);
            results.push({ name: item.name, ok: true, path: target });
          } catch (error) {
            const { rm } = await import('node:fs/promises');
            await rm(temporary, { recursive: true, force: true });
            results.push({ name: item.name, ok: false, error: error.message });
          }
        }
        return results;
      });
    });
  }
}
