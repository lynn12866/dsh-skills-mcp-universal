import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Groups } from './groups.js';
import { Skills, skillFingerprint } from './skills.js';
import { ScopedMcp, workspaceRoot } from './scopes.js';
import { atomicWrite, fileLock, JsonStore } from './storage.js';
import type {
  GroupMember,
  GroupState,
  ManagedGroup,
  ManagedGroupSummary,
  SceneAssignmentData,
  ScopedServer,
  SkillImportPayload,
  SkillItem,
  Server,
} from './types.js';

export const groupMemberKey = (member: GroupMember) =>
  member.kind === 'skill'
    ? `skill:${resolve(member.path)}`
    : `mcp:${member.cwd ?? ''}:${member.name}`;

type SkillSource = { item: SkillItem; manager: Skills; cwd?: string };
type Undo = () => Promise<unknown>;
const unavailable = (error: NodeJS.ErrnoException) =>
  error.code === 'ENOENT' || error.code === 'ENOTDIR';

/** One library and persistent group switches. Native directories are deployment targets. */
export class GroupManager {
  store: JsonStore<GroupState>;
  library: Skills;
  private legacy: Groups;
  private initialized = false;
  private availableWorkspaceKey = '';

  constructor(
    private skills: Skills,
    private mcp: ScopedMcp,
    profileDir: string,
  ) {
    this.store = new JsonStore(join(profileDir, 'skills-mcp-group-state.json'), {
      version: 1,
      groups: [],
      workspaces: [],
      migrated: [],
      copies: [],
    });
    const libraryRoot = join(profileDir, 'skills-mcp-library');
    this.library = new Skills({ home: libraryRoot, agentsHome: join(libraryRoot, '.agents') });
    this.legacy = new Groups(skills, mcp, profileDir);
    // Install the gate before any Agent can connect, including during migration.
    mcp.resolveServers = (cwd) => this.effective(cwd);
  }

  private validate(data: GroupState) {
    if (
      data.version !== 1 ||
      !Array.isArray(data.groups) ||
      !Array.isArray(data.workspaces) ||
      !Array.isArray(data.migrated) ||
      !Array.isArray(data.copies) ||
      data.workspaces.some((path) => typeof path !== 'string' || !isAbsolute(path)) ||
      data.migrated.some((path) => typeof path !== 'string') ||
      data.copies.some(
        (copy) =>
          !copy ||
          typeof copy.path !== 'string' ||
          !isAbsolute(copy.path) ||
          typeof copy.source !== 'string' ||
          !isAbsolute(copy.source),
      )
    )
      throw new Error('Corrupt group configuration was preserved.');
    for (const group of data.groups) {
      if (
        !group ||
        typeof group.id !== 'string' ||
        !/^[\w-]{1,80}$/.test(group.id) ||
        typeof group.name !== 'string' ||
        !group.name.trim() ||
        group.name.length > 64 ||
        typeof group.enabled !== 'boolean' ||
        !Array.isArray(group.workspaces) ||
        group.workspaces.length > 128 ||
        group.workspaces.some((path) => typeof path !== 'string' || !isAbsolute(path)) ||
        new Set(group.workspaces).size !== group.workspaces.length ||
        !Array.isArray(group.members) ||
        group.members.length > 512 ||
        group.members.some(
          (member) =>
            !member ||
            (member.kind === 'skill'
              ? typeof member.path !== 'string' || !isAbsolute(member.path)
              : member.kind !== 'mcp' ||
                typeof member.name !== 'string' ||
                !member.name ||
                (member.cwd !== undefined &&
                  (typeof member.cwd !== 'string' || !isAbsolute(member.cwd)))),
        ) ||
        new Set(group.members.map(groupMemberKey)).size !== group.members.length
      )
        throw new Error('Invalid group configuration was preserved.');
    }
    if (new Set(data.groups.map((group) => group.id)).size !== data.groups.length)
      throw new Error('Duplicate group IDs were preserved.');
    return data;
  }

  private async read() {
    return this.validate(await this.store.read());
  }

  private async sources(data: GroupState): Promise<SkillSource[]> {
    const sources: SkillSource[] = (await this.library.list()).map((item) => ({
      item,
      manager: this.library,
    }));
    sources.push(...(await this.skills.list()).map((item) => ({ item, manager: this.skills })));
    for (const cwd of await this.available(data.workspaces)) {
      sources.push(
        ...(await this.skills.list(cwd))
          .filter(
            (item) =>
              item.scope === 'workspace' && !data.copies.some((copy) => copy.path === item.path),
          )
          .map((item) => ({ item, manager: this.skills, cwd })),
      );
    }
    return [...new Map(sources.map((source) => [source.item.path, source])).values()];
  }

  private async serverSources(data: GroupState) {
    const result = (await this.mcp.global.read()).map((server) => ({
      server,
      cwd: undefined as string | undefined,
    }));
    for (const cwd of await this.available(data.workspaces)) {
      try {
        const owner = await this.mcp.owner({ scope: 'workspace', cwd });
        result.push(...(await owner.manager.read()).map((server) => ({ server, cwd })));
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
    }
    return result;
  }

  private async skillCatalog(data: GroupState) {
    const sources = await this.sources(data);
    const aliases = new Map<string, SkillSource>();
    const fingerprints = new Map<string, string | undefined>();
    const fingerprintOf = async (source: SkillSource) => {
      if (!fingerprints.has(source.item.path)) {
        try {
          fingerprints.set(source.item.path, await skillFingerprint(source.item));
        } catch {
          // Unreadable resources stay distinct; they must not block unrelated groups.
          fingerprints.set(source.item.path, undefined);
        }
      }
      return fingerprints.get(source.item.path);
    };
    const canonical: SkillSource[] = [];
    for (const source of sources) {
      const candidates = canonical.filter(
        ({ item }) => item.name === source.item.name && item.writable && !item.error,
      );
      let match: SkillSource | undefined;
      if (candidates.length && source.item.writable && !source.item.error) {
        const fingerprint = await fingerprintOf(source);
        for (const candidate of candidates) {
          if (fingerprint && (await fingerprintOf(candidate)) === fingerprint) {
            match = candidate;
            break;
          }
        }
      }
      aliases.set(source.item.path, match ?? source);
      if (!match) canonical.push(source);
    }
    return { sources: canonical, aliases };
  }

  private async resolveWorkspaces(paths: string[], allowUnavailable = false) {
    if (!Array.isArray(paths)) throw new Error('Select up to 128 workspace directories.');
    const roots: Record<string, string> = {};
    const unavailableWorkspaces: string[] = [];
    for (const path of paths) {
      let root: string;
      try {
        root = await workspaceRoot(path);
      } catch (error) {
        if (!allowUnavailable || !unavailable(error)) throw error;
        unavailableWorkspaces.push(path);
        continue;
      }
      if (
        [this.skills.home, this.skills.agentsHome, this.mcp.profileDir, this.library.home].includes(
          root,
        )
      )
        throw new Error('Select a workspace directory.');
      roots[path] = root;
    }
    return { roots, unavailableWorkspaces };
  }

  private async canonical(paths: string[]) {
    if (paths?.length > 128) throw new Error('Select up to 128 workspace directories.');
    return [...new Set(Object.values((await this.resolveWorkspaces(paths)).roots))];
  }

  private async available(paths: string[]) {
    return Object.keys((await this.resolveWorkspaces(paths, true)).roots);
  }

  private async availableGroups(data: GroupState) {
    const { unavailableWorkspaces } = await this.resolveWorkspaces(
      [
        ...new Set([
          ...data.workspaces,
          ...data.groups.flatMap((group) =>
            group.members.flatMap((member) =>
              member.kind === 'mcp' && member.cwd ? [member.cwd] : [],
            ),
          ),
        ]),
      ],
      true,
    );
    return data.groups.filter(
      (group) =>
        !group.members.some((member) =>
          member.kind === 'mcp'
            ? !!member.cwd && unavailableWorkspaces.includes(member.cwd)
            : unavailableWorkspaces.some((cwd) =>
                [join(cwd, '.dsh/skills'), join(cwd, '.agents/skills')].some((root) =>
                  member.path.startsWith(root + sep),
                ),
              ),
        ),
    );
  }

  private async transaction<T>(update: (data: GroupState, undo: Undo[]) => Promise<T>) {
    return fileLock(this.store.file + '.activation', async () => {
      const undo: Undo[] = [];
      let result: T;
      try {
        result = await this.store.update(async (data) => {
          this.validate(data);
          const value = await update(data, undo);
          this.validate(data);
          const catalog = await this.skillCatalog(data);
          for (const group of data.groups) {
            const members = group.members.map((member) =>
              member.kind === 'skill'
                ? { ...member, path: catalog.aliases.get(member.path)?.item.path ?? member.path }
                : member,
            );
            group.members = [
              ...new Map(members.map((member) => [groupMemberKey(member), member])).values(),
            ];
          }
          await this.syncSkills(data, undo);
          return value;
        });
      } catch (error) {
        for (const restore of undo.reverse()) await restore();
        await this.mcp.refresh();
        throw error;
      }
      this.initialized = true;
      await this.mcp.refresh();
      return result;
    });
  }

  async register(paths: string[]) {
    if (paths?.length > 128) throw new Error('Select up to 128 workspace directories.');
    const roots = [...new Set(Object.values((await this.resolveWorkspaces(paths, true)).roots))];
    const current = await this.read();
    const availableWorkspaceKey = JSON.stringify(
      await this.available([...new Set([...current.workspaces, ...roots])]),
    );
    if (
      this.initialized &&
      roots.every((root) => current.workspaces.includes(root)) &&
      this.availableWorkspaceKey === availableWorkspaceKey
    )
      return;
    await this.transaction(async (data) => {
      data.workspaces = [...new Set([...data.workspaces, ...roots])];
      const assignments = await new JsonStore<SceneAssignmentData>(
        join(this.mcp.profileDir, 'skills-mcp-scenes.json'),
        { version: 1, entries: [] },
      ).read();
      if (assignments.version !== 1 || !Array.isArray(assignments.entries))
        throw new Error('Corrupt previous group assignments were preserved.');
      // A stale Host registry entry must not block the library or be recreated.
      // Leave its migration pending so restoring the directory can retry it.
      for (const cwd of [undefined, ...(await this.available(data.workspaces))]) {
        const options = cwd ? { scope: 'workspace' as const, cwd } : {};
        const store = await this.legacy.owner(options);
        if (data.migrated.includes(store.file)) continue;
        for (const group of await this.legacy.read(store)) {
          const assignment = assignments.entries.find(
            (entry) =>
              entry.id === group.id &&
              entry.scope === (cwd ? 'workspace' : 'global') &&
              entry.cwd === cwd,
          );
          const targets = assignment?.workspaces ?? (cwd ? [cwd] : []);
          const resolved = await this.resolveWorkspaces(targets, true);
          const workspaces = [...new Set(targets.map((path) => resolved.roots[path] ?? path))];
          data.workspaces = [...new Set([...data.workspaces, ...workspaces])];
          let name = group.name;
          for (let suffix = 2; data.groups.some((item) => item.name === name); suffix++)
            name = group.name.slice(0, 56) + ` (${suffix})`;
          data.groups.push({
            id: createHash('sha256')
              .update(store.file + ':' + group.id)
              .digest('hex')
              .slice(0, 32),
            name,
            members: group.members.map((member) =>
              member.kind === 'mcp' && cwd ? { ...member, cwd } : member,
            ),
            workspaces,
            enabled: false,
          });
        }
        data.migrated.push(store.file);
      }
    });
    this.availableWorkspaceKey = availableWorkspaceKey;
  }

  async list(): Promise<ManagedGroupSummary[]> {
    const data = await this.read();
    const available = new Set([
      ...(await this.sources(data))
        .filter(({ item }) => item.writable && !item.error)
        .map(({ item }) => groupMemberKey({ kind: 'skill', path: item.path })),
      ...(await this.serverSources(data)).map(({ server, cwd }) =>
        groupMemberKey({ kind: 'mcp', name: server.name, cwd }),
      ),
    ]);
    return data.groups.map((group) => ({
      ...group,
      missing: group.members.filter((member) => !available.has(groupMemberKey(member))).length,
    }));
  }

  async catalog(paths: string[]) {
    await this.register(paths);
    const resolved = await this.resolveWorkspaces(paths, true);
    const historical = await this.resolveWorkspaces((await this.read()).workspaces, true);
    return {
      items: await this.list(),
      workspaceRoots: resolved.roots,
      unavailableWorkspaces: [
        ...new Set([...resolved.unavailableWorkspaces, ...historical.unavailableWorkspaces]),
      ],
    };
  }

  async save(input: { id?: string; name: string; members: GroupMember[]; workspaces: string[] }) {
    const workspaces = await this.canonical(input.workspaces);
    if (typeof input.name !== 'string') throw new Error('Group name is required.');
    return this.transaction(async (data) => {
      const previous = input.id ? data.groups.find((group) => group.id === input.id) : undefined;
      if (input.id && !previous) throw new Error('Group no longer exists.');
      const group: ManagedGroup = {
        ...input,
        id: input.id || randomUUID(),
        name: input.name.trim(),
        workspaces,
        enabled: previous?.enabled ?? false,
      };
      this.validate({ ...data, groups: [group] });
      if (data.groups.some((item) => item.id !== group.id && item.name === group.name))
        throw new Error('A group with this name already exists.');
      const available = new Set([
        ...(await this.sources(data))
          .filter(({ item }) => item.writable && !item.error)
          .map(({ item }) => groupMemberKey({ kind: 'skill', path: item.path })),
        ...(await this.serverSources(data)).map(({ server, cwd }) =>
          groupMemberKey({ kind: 'mcp', name: server.name, cwd }),
        ),
      ]);
      if (group.members.some((member) => !available.has(groupMemberKey(member))))
        throw new Error('A group member is missing or read-only. Edit the group first.');
      if (group.enabled && (!group.members.length || !workspaces.length))
        throw new Error('Disable the group before removing all members or workspaces.');
      data.workspaces = [...new Set([...data.workspaces, ...workspaces])];
      data.groups = previous
        ? data.groups.map((item) => (item.id === group.id ? group : item))
        : [...data.groups, group];
      return group;
    });
  }

  async assign(id: string, paths: string[]) {
    const workspaces = await this.canonical(paths);
    return this.transaction(async (data) => {
      const group = data.groups.find((group) => group.id === id);
      if (!group) throw new Error('Group no longer exists.');
      group.workspaces = workspaces;
      if (!workspaces.length) group.enabled = false;
      data.workspaces = [...new Set([...data.workspaces, ...workspaces])];
      return group;
    });
  }

  async toggle(id: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean.');
    return this.transaction(async (data) => {
      const group = data.groups.find((group) => group.id === id);
      if (!group) throw new Error('Group no longer exists.');
      if (enabled && (!group.members.length || !group.workspaces.length))
        throw new Error('Select members and at least one workspace before enabling the group.');
      if (enabled && !(await this.availableGroups(data)).some((item) => item.id === id))
        throw new Error('A group member workspace is unavailable. Restore it or edit the group.');
      group.enabled = enabled;
      return group;
    });
  }

  async remove(id: string) {
    return this.transaction(async (data) => {
      data.groups = data.groups.filter((group) => group.id !== id);
      return { id };
    });
  }

  async effective(cwd?: string | null): Promise<ScopedServer[]> {
    if (!cwd) return [];
    const workspace = await workspaceRoot(cwd);
    const data = await this.read();
    return this.serversFor(data, workspace);
  }

  private async serversFor(data: GroupState, workspace: string): Promise<ScopedServer[]> {
    const servers = new Map<string, ScopedServer>();
    for (const group of (await this.availableGroups(data)).filter(
      (group) => group.enabled && group.workspaces.includes(workspace),
    )) {
      for (const member of group.members) {
        if (member.kind !== 'mcp') continue;
        const server = await this.mcp.get(
          member.name,
          member.cwd ? { scope: 'workspace', cwd: member.cwd } : {},
        );
        const next = { ...server, enabled: true };
        if (
          servers.has(server.name) &&
          JSON.stringify(servers.get(server.name)) !== JSON.stringify(next)
        )
          throw new Error(`Enabled groups contain conflicting MCP servers: ${server.name}`);
        servers.set(server.name, next);
      }
    }
    return [...servers.values()];
  }

  private async syncSkills(data: GroupState, undo: Undo[]) {
    const sources = await this.sources(data);
    const groups = await this.availableGroups(data);
    const availableWorkspaces = new Set(await this.available(data.workspaces));
    for (const cwd of new Set(
      groups.filter((group) => group.enabled).flatMap((group) => group.workspaces),
    ))
      if (availableWorkspaces.has(cwd)) await this.serversFor(data, cwd);
    // Validate enabled MCP references before publishing any Skill flags.
    for (const group of groups.filter(
      (group) => group.enabled && group.workspaces.some((cwd) => availableWorkspaces.has(cwd)),
    )) {
      for (const member of group.members) {
        if (member.kind === 'mcp')
          await this.mcp.get(
            member.name,
            member.cwd ? { scope: 'workspace', cwd: member.cwd } : {},
          );
        else if (
          !sources.some(({ item }) => item.path === member.path && item.writable && !item.error)
        )
          throw new Error(
            'An enabled group Skill is missing or read-only. Edit or disable the group.',
          );
      }
    }
    const apply = async (
      manager: Skills,
      cwd: string | undefined,
      items: SkillItem[],
      selected: Set<string>,
    ) => {
      const changes = items.filter(
        (item) =>
          item.writable &&
          !item.error &&
          (item.modelEnabled !== selected.has(item.path) ||
            item.userEnabled !== selected.has(item.path)),
      );
      for (const item of changes) {
        const raw = await readFile(item.path, 'utf8');
        const mode = (await stat(item.path)).mode & 0o777;
        undo.push(() => atomicWrite(item.path, raw, mode));
      }
      if (changes.length)
        await manager.applyBatch(
          changes.map((item) => ({ path: item.path, enabled: selected.has(item.path) })),
          cwd,
          async () => {},
        );
    };
    await apply(this.library, undefined, await this.library.list(), new Set());
    await apply(this.skills, undefined, await this.skills.list(), new Set());
    for (const cwd of availableWorkspaces) {
      const selected = new Set<string>();
      const names = new Map<string, string>();
      for (const group of groups.filter(
        (group) => group.enabled && group.workspaces.includes(cwd),
      )) {
        for (const member of group.members) {
          if (member.kind !== 'skill') continue;
          const source = sources.find(({ item }) => item.path === member.path)!;
          if (names.has(source.item.name) && names.get(source.item.name) !== member.path)
            throw new Error(`Enabled groups contain conflicting Skills: ${source.item.name}`);
          names.set(source.item.name, member.path);
          let local = (await this.skills.list(cwd)).find(
            (item) => item.scope === 'workspace' && item.name === source.item.name,
          );
          if (
            local &&
            local.path !== member.path &&
            !data.copies.some((copy) => copy.path === local!.path && copy.source === member.path)
          ) {
            if ((await skillFingerprint(local)) !== (await skillFingerprint(source.item)))
              throw new Error(
                `A different Skill named ${source.item.name} already exists in ${cwd}. Select that entry or rename the conflicting Skill.`,
              );
            data.copies = [
              ...data.copies.filter((copy) => copy.path !== local!.path),
              { path: local.path, source: member.path },
            ];
          }
          if (!local) {
            const copied = await source.manager.copyForScene(member.path, source.cwd, cwd);
            const path =
              source.item.kind === 'bundle' ? join(copied.path, 'SKILL.md') : copied.path;
            undo.push(() =>
              rm(source.item.kind === 'bundle' ? dirname(path) : path, {
                recursive: true,
                force: true,
              }),
            );
            data.copies = [
              ...data.copies.filter((copy) => copy.path !== path),
              { path, source: member.path },
            ];
            local = await this.skills.managed(path, cwd, true);
          }
          if (!local.writable || local.error)
            throw new Error('A workspace Skill is read-only or invalid.');
          selected.add(local.path);
        }
      }
      const items = (await this.skills.list(cwd)).filter((item) => item.scope === 'workspace');
      await apply(this.skills, cwd, items, selected);
    }
  }

  async skillList() {
    const data = await this.read();
    return (await this.skillCatalog(data)).sources.map(({ item, cwd }) => ({
      name: item.name,
      path: item.path,
      description: item.description,
      writable: item.writable,
      error: item.error,
      originCwd: cwd,
    }));
  }

  private async source(path: string) {
    const source = (await this.sources(await this.read())).find(({ item }) => item.path === path);
    if (!source) throw new Error('Skill is outside the library.');
    return source;
  }

  async skillRead(path: string) {
    const source = await this.source(path);
    return source.manager.read(path, source.cwd);
  }

  async skillRemove(path: string) {
    return fileLock(this.store.file + '.activation', async () => {
      if (
        (await this.read()).groups.some((group) =>
          group.members.some((member) => member.kind === 'skill' && member.path === path),
        )
      )
        throw new Error('Remove this Skill from its groups first.');
      const source = await this.source(path);
      return source.manager.remove(path, source.cwd);
    });
  }

  async skillImport(payload: Pick<SkillImportPayload, 'token' | 'paths'>) {
    const results = await this.library.import({ token: payload.token, paths: payload.paths });
    for (const result of results) {
      if (result.ok && result.path) {
        const path = result.path.endsWith('.md') ? result.path : join(result.path, 'SKILL.md');
        await this.library.toggle(path, false);
      }
    }
    return results;
  }

  async serverList() {
    const data = await this.read();
    await this.mcp.refresh();
    return (await this.serverSources(data)).map(({ server, cwd }) => {
      const sessions = [...this.mcp.workers.entries()].filter(([, entry]) =>
        entry.effective.some(
          (item) => item.name === server.name && item.workspace === (cwd ?? null),
        ),
      );
      const states = sessions.map(([, entry]) => entry.worker.live.get(server.name)?.state);
      const error = sessions.map(([, entry]) => entry.worker.errors.get(server.name)).find(Boolean);
      const tools = [
        ...new Map(
          sessions.flatMap(([agent, entry]) =>
            entry.worker.live.get(server.name)?.state === 'active'
              ? agent.ctx.tools
                  .schemas(agent)
                  .filter((tool) => tool.name.startsWith(`mcp__${server.name}__`))
                  .map((tool) => [tool.name, tool] as const)
              : [],
          ),
        ).values(),
      ];
      const enabled = data.groups.some(
        (group) =>
          group.enabled &&
          group.members.some(
            (member) => member.kind === 'mcp' && member.name === server.name && member.cwd === cwd,
          ),
      );
      return {
        name: server.name,
        originCwd: cwd,
        transport: server.transport,
        target: server.transport === 'stdio' ? server.command : server.url,
        state: error
          ? 'failed'
          : states.includes('active')
            ? 'active'
            : states.includes('starting')
              ? 'starting'
              : enabled
                ? 'idle'
                : 'disabled',
        error,
        tools,
      };
    });
  }

  async serverRemove(name: string, cwd?: string) {
    return fileLock(this.store.file + '.activation', async () => {
      const key = groupMemberKey({ kind: 'mcp', name, cwd });
      if (
        (await this.read()).groups.some((group) =>
          group.members.some((member) => groupMemberKey(member) === key),
        )
      )
        throw new Error('Remove this MCP server from its groups first.');
      return this.mcp.remove(name, cwd ? { scope: 'workspace', cwd } : {});
    });
  }

  async serverSave(server: Server, previousName: string, cwd?: string) {
    const owner = await this.mcp.owner(cwd ? { scope: 'workspace', cwd } : {});
    return this.transaction(async (data, undo) => {
      const previous = await readFile(owner.manager.store.file, 'utf8');
      undo.push(() => atomicWrite(owner.manager.store.file, previous));
      await this.mcp.save(server, previousName, cwd ? { scope: 'workspace', cwd } : {});
      for (const group of data.groups) {
        group.members = group.members.map((member) =>
          member.kind === 'mcp' && member.name === previousName && member.cwd === cwd
            ? { ...member, name: server.name }
            : member,
        );
      }
      return { name: server.name };
    });
  }
}
