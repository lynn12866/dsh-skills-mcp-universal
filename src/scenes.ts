import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Groups } from './groups.js';
import { Skills } from './skills.js';
import { ScopedMcp, workspaceRoot } from './scopes.js';
import { JsonStore, fileLock } from './storage.js';
import type {
  Group,
  Member,
  SceneAssignmentData,
  SceneCatalog,
  SceneRef,
  SceneTarget,
  Server,
} from './types.js';

export const sceneKey = (ref: SceneRef) => `${ref.scope}:${ref.cwd ?? ''}:${ref.id}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class Scenes {
  store: JsonStore<SceneAssignmentData>;

  constructor(
    private groups: Groups,
    private skills: Skills,
    private mcp: ScopedMcp,
    profileDir: string,
  ) {
    this.store = new JsonStore(join(profileDir, 'skills-mcp-scenes.json'), {
      version: 1,
      entries: [],
    });
  }

  private validate(data: SceneAssignmentData) {
    if (data.version !== 1 || !Array.isArray(data.entries))
      throw new Error('Corrupt scene assignments were preserved.');
    const keys = new Set<string>();
    for (const entry of data.entries) {
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        !/^[\w-]{1,80}$/.test(entry.id) ||
        !['global', 'workspace'].includes(entry.scope) ||
        (entry.scope === 'workspace' &&
          (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd))) ||
        (entry.scope === 'global' && entry.cwd !== undefined) ||
        !Array.isArray(entry.workspaces) ||
        entry.workspaces.length > 128 ||
        entry.workspaces.some((path) => typeof path !== 'string' || !isAbsolute(path)) ||
        new Set(entry.workspaces).size !== entry.workspaces.length
      )
        throw new Error('Invalid scene assignments were preserved.');
      const key = sceneKey(entry);
      if (keys.has(key)) throw new Error('Duplicate scene assignments were preserved.');
      keys.add(key);
    }
    return data.entries;
  }

  private async reference(ref: SceneRef): Promise<SceneRef> {
    if (!ref || typeof ref.id !== 'string' || !/^[\w-]{1,80}$/.test(ref.id))
      throw new Error('Invalid scene ID.');
    if (ref.scope === 'global') return { id: ref.id, scope: 'global' };
    if (ref.scope !== 'workspace') throw new Error('Invalid scene source.');
    return { id: ref.id, scope: 'workspace', cwd: await workspaceRoot(ref.cwd!) };
  }

  private async definition(ref: SceneRef) {
    const group = (await this.groups.read(await this.groups.owner(ref))).find(
      (group) => group.id === ref.id,
    );
    if (!group) throw new Error('Scene no longer exists.');
    return group;
  }

  private async destinations(ref: SceneRef) {
    const entries = this.validate(await this.store.read());
    return (
      entries.find((entry) => sceneKey(entry) === sceneKey(ref))?.workspaces ??
      (ref.scope === 'workspace' ? [ref.cwd!] : [])
    );
  }

  async assign(source: SceneRef, paths: string[]) {
    const ref = await this.reference(source);
    if (!Array.isArray(paths) || paths.length > 128)
      throw new Error('Select up to 128 workspace directories.');
    const workspaces = [
      ...new Set(
        await Promise.all(
          paths.map(async (path) => {
            const cwd = await workspaceRoot(path);
            if (cwd === this.skills.home || cwd === this.mcp.profileDir)
              throw new Error('Global storage cannot be assigned as a workspace.');
            return cwd;
          }),
        ),
      ),
    ];
    await this.store.update(async (data) => {
      this.validate(data);
      await this.definition(ref);
      data.entries = [
        ...data.entries.filter((entry) => sceneKey(entry) !== sceneKey(ref)),
        { ...ref, workspaces },
      ];
    });
    return { source: ref, workspaces };
  }

  private async names(group: Group, ref: SceneRef) {
    const skills = await this.skills.list(ref.cwd);
    return group.members.map((member) => {
      if (member.kind === 'mcp') return { member, name: member.name };
      const skill = skills.find(
        (skill) => skill.path === member.path && skill.scope === ref.scope && !skill.error,
      );
      if (!skill) throw new Error('A scene Skill is missing or invalid.');
      return { member, name: skill.name };
    });
  }

  private async target(group: Group, ref: SceneRef, cwd: string): Promise<SceneTarget> {
    try {
      const workspace = await workspaceRoot(cwd);
      const names = await this.names(group, ref);
      const localSkills = (await this.skills.list(workspace)).filter(
        (skill) => skill.scope === 'workspace',
      );
      const localServers = await (
        await this.mcp.owner({ scope: 'workspace', cwd: workspace })
      ).manager.read();
      const states = names.map(({ member, name }) => {
        if (member.kind === 'mcp')
          return localServers.find((server) => server.name === name)?.enabled;
        const skill = localSkills.find((skill) => skill.name === name && !skill.error);
        return skill ? !!(skill.modelEnabled || skill.userEnabled) : undefined;
      });
      return {
        cwd: workspace,
        state:
          !states.length || states.some((state) => state === undefined)
            ? 'pending'
            : states.every(Boolean)
              ? 'enabled'
              : states.some(Boolean)
                ? 'mixed'
                : 'disabled',
      };
    } catch (error) {
      return { cwd, state: 'pending', error: error.message };
    }
  }

  async list(paths: string[]): Promise<SceneCatalog> {
    if (!Array.isArray(paths) || paths.length > 512) throw new Error('Invalid workspace list.');
    const assignments = this.validate(await this.store.read());
    const roots = new Set<string>();
    const errors: string[] = [];
    for (const path of [
      ...paths,
      ...assignments.flatMap((entry) => (entry.scope === 'workspace' ? [entry.cwd!] : [])),
    ]) {
      try {
        roots.add(await workspaceRoot(path));
      } catch (error) {
        errors.push(`${path}: ${error.message}`);
      }
    }
    const items: SceneCatalog['items'] = [];
    for (const owner of [
      { scope: 'global' as const },
      ...[...roots].map((cwd) => ({ scope: 'workspace' as const, cwd })),
    ]) {
      try {
        for (const group of await this.groups.list(owner)) {
          const source: SceneRef = { ...owner, id: group.id };
          const workspaces =
            assignments.find((entry) => sceneKey(entry) === sceneKey(source))?.workspaces ??
            (owner.scope === 'workspace' ? [owner.cwd] : []);
          const targets = await Promise.all(
            workspaces.map((cwd) => this.target(group, source, cwd)),
          );
          items.push({ ...group, key: sceneKey(source), source, targets });
        }
      } catch (error) {
        if (owner.scope === 'global') throw error;
        errors.push(`${owner.cwd}: ${error.message}`);
      }
    }
    return { items, errors };
  }

  async remove(source: SceneRef) {
    const ref = await this.reference(source);
    await this.store.update(async (data) => {
      this.validate(data);
      await this.groups.remove(ref.id, ref);
      data.entries = data.entries.filter((entry) => sceneKey(entry) !== sceneKey(ref));
    });
    return { id: ref.id };
  }

  async apply(source: SceneRef, destinationCwd: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean.');
    const ref = await this.reference(source);
    const cwd = await workspaceRoot(destinationCwd);
    if (!(await this.destinations(ref)).includes(cwd))
      throw new Error('Assign this scene to the workspace first.');
    const group = await this.definition(ref);
    if (!group.members.length) throw new Error('Add scene members first.');
    const sourceSummary = (await this.groups.list(ref)).find((value) => value.id === ref.id)!;
    if (sourceSummary.missing)
      throw new Error('A scene member is missing or read-only. Edit it first.');
    const options = { scope: 'workspace' as const, cwd };
    const targetGroupStore = await this.groups.owner(options);
    return fileLock(targetGroupStore.file + '.activation', async () => {
      const names = await this.names(group, ref);
      if (new Set(names.map((item) => item.member.kind + ':' + item.name)).size !== names.length)
        throw new Error('Select only one source for each same-name scene member.');
      const localSkills = (await this.skills.list(cwd)).filter(
        (skill) => skill.scope === 'workspace',
      );
      const manager = (await this.mcp.owner(options)).manager;
      const localServers = await manager.read();
      const plan = await Promise.all(
        names.map(async ({ member, name }) => {
          if (member.kind === 'skill') {
            const sourceSkill = await this.skills.managed(member.path, ref.cwd, true);
            const existing = localSkills.find((skill) => skill.name === name);
            if (existing) await this.skills.managed(existing.path, cwd, true);
            return { kind: 'skill' as const, source: sourceSkill.path, existing: existing?.path };
          }
          const { scope, workspace, ...server } = await this.mcp.get(member.name, ref);
          return {
            kind: 'mcp' as const,
            server: { ...server, enabled: false } as Server,
            exists: localServers.some((server) => server.name === name),
          };
        }),
      );
      const createdSkills: { path: string; hash: string }[] = [];
      const createdServers: Server[] = [];
      try {
        const members: Member[] = [];
        for (const item of plan) {
          if (item.kind === 'skill') {
            let path = item.existing;
            if (!path) {
              const copied = await this.skills.copyForScene(item.source, ref.cwd, cwd);
              path = copied.path.endsWith('.md') ? copied.path : join(copied.path, 'SKILL.md');
              createdSkills.push({ path, hash: digest(await readFile(path, 'utf8')) });
            }
            members.push({ kind: 'skill', path });
          } else {
            if (!item.exists) {
              await manager.save(item.server);
              createdServers.push(await manager.get(item.server.name));
            }
            members.push({ kind: 'mcp', name: item.server.name });
          }
        }
        const result = await this.groups.applyMembers(members, enabled, options, async () => {
          if (
            JSON.stringify(await this.definition(ref)) !== JSON.stringify(group) ||
            !(await this.destinations(ref)).includes(cwd)
          )
            throw new Error('Scene changed during activation. Try again.');
        });
        return { source: ref, cwd, ...result };
      } catch (error) {
        for (const server of createdServers.reverse()) {
          const current = await manager.get(server.name).catch(() => null);
          if (JSON.stringify(current) === JSON.stringify(server)) await manager.remove(server.name);
        }
        for (const skill of createdSkills.reverse()) {
          const raw = await readFile(skill.path, 'utf8').catch(() => null);
          if (raw !== null && digest(raw) === skill.hash) await this.skills.remove(skill.path, cwd);
        }
        throw error;
      }
    });
  }
}
