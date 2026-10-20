import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { JsonStore, fileLock } from './storage.js';
import { workspaceRoot, ScopedMcp } from './scopes.js';
import { Skills } from './skills.js';
import type { Group, GroupData, GroupSummary, Member, Scope, ScopeOptions } from './types.js';

export function memberKey(member: Member): string {
  return member.kind === 'skill' ? 'skill:' + resolve(member.path) : 'mcp:' + member.name;
}

function normalizeGroup(value: Group): Group {
  if (!value || typeof value.id !== 'string' || !/^[\w-]{1,80}$/.test(value.id))
    throw new Error('Invalid group ID.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 64)
    throw new Error('Group name must contain 1–64 characters.');
  if (!Array.isArray(value.members) || value.members.length > 512)
    throw new Error('Invalid group members.');
  const members: Member[] = value.members.map((member) => {
    if (member?.kind === 'skill' && typeof member.path === 'string')
      return { kind: 'skill', path: resolve(member.path) };
    if (member?.kind === 'mcp' && typeof member.name === 'string')
      return { kind: 'mcp', name: member.name };
    throw new Error('Invalid group member.');
  });
  if (new Set(members.map(memberKey)).size !== members.length)
    throw new Error('Duplicate group members.');
  return { id: value.id, name: value.name.trim(), members };
}

export class Groups {
  constructor(
    private skills: Skills,
    private mcp: ScopedMcp,
    private profileDir: string,
  ) {}

  async owner({ scope = 'global', cwd }: ScopeOptions = {}) {
    if (!['global', 'workspace'].includes(scope)) throw new Error('Invalid group scope.');
    const directory =
      scope === 'workspace' ? join(await workspaceRoot(cwd!), '.dsh') : this.profileDir;
    return new JsonStore<GroupData>(join(directory, 'skills-mcp-groups.json'), {
      version: 1,
      groups: [],
    });
  }

  validate(data: GroupData) {
    if (data.version !== 1 || !Array.isArray(data.groups))
      throw new Error('Corrupt group configuration was preserved.');
    const groups = data.groups.map(normalizeGroup);
    if (
      new Set(groups.map((group) => group.id)).size !== groups.length ||
      new Set(groups.map((group) => group.name)).size !== groups.length
    )
      throw new Error('Duplicate groups in configuration.');
    return groups;
  }

  async read(store: JsonStore<GroupData>) {
    return this.validate(await store.read());
  }

  async catalog({ scope = 'global', cwd }: ScopeOptions) {
    const owner = await this.mcp.owner({ scope, cwd });
    const skills = (await this.skills.list(cwd)).filter(
      (item) => item.scope === scope && item.writable && !item.error,
    );
    const servers = await owner.manager.read();
    return [
      ...skills.map((item) => ({
        member: { kind: 'skill' as const, path: item.path },
        enabled: !!(item.modelEnabled || item.userEnabled),
      })),
      ...servers.map((item) => ({
        member: { kind: 'mcp' as const, name: item.name },
        enabled: item.enabled,
      })),
    ];
  }

  async list(options: ScopeOptions = {}): Promise<GroupSummary[]> {
    const groups = await this.read(await this.owner(options));
    const catalog = new Map(
      (await this.catalog(options)).map((item) => [memberKey(item.member), item]),
    );
    return groups.map((group) => {
      const states = group.members.map((member) => catalog.get(memberKey(member))?.enabled);
      const missing = states.filter((state) => state === undefined).length;
      return {
        ...group,
        missing,
        state:
          states.length && states.every(Boolean)
            ? 'enabled'
            : states.some(Boolean)
              ? 'mixed'
              : 'disabled',
      };
    });
  }

  async save(input: { id?: string; name: string; members: Member[] }, options: ScopeOptions = {}) {
    const group = normalizeGroup({ ...input, id: input.id || randomUUID() });
    const store = await this.owner(options);
    const available = new Set((await this.catalog(options)).map((item) => memberKey(item.member)));
    if (group.members.some((member) => !available.has(memberKey(member))))
      throw new Error('Select existing, writable entries from the current scope.');
    await store.update(async (data) => {
      const groups = this.validate(data);
      if (input.id && !groups.some((item) => item.id === input.id))
        throw new Error('Group no longer exists.');
      if (groups.some((item) => item.name === group.name && item.id !== group.id))
        throw new Error('A group with this name already exists.');
      data.groups = [...groups.filter((item) => item.id !== group.id), group];
    });
    return group;
  }

  async remove(id: string, options: ScopeOptions = {}) {
    const store = await this.owner(options);
    await store.update(async (data) => {
      this.validate(data);
      data.groups = data.groups.filter((group) => group.id !== id);
    });
    return { id };
  }

  async apply(id: string, enabled: boolean, options: ScopeOptions = {}) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean.');
    const store = await this.owner(options);
    return fileLock(store.file + '.activation', async () => {
      const group = (await this.read(store)).find((item) => item.id === id);
      if (!group) throw new Error('Group no longer exists.');
      if (!group.members.length)
        throw new Error('Add at least one member before enabling the group.');
      const result = await this.applyMembers(group.members, enabled, options);
      return { id, ...result };
    });
  }

  async applyMembers(
    members: Member[],
    enabled: boolean,
    options: ScopeOptions,
    beforeCommit?: () => Promise<void>,
  ) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean.');
    if (!members.length) throw new Error('Add scene members first.');
    const catalog = await this.catalog(options);
    const selected = new Set(members.map(memberKey));
    const available = new Set(catalog.map((item) => memberKey(item.member)));
    if (members.some((member) => !available.has(memberKey(member))))
      throw new Error(
        'A group member is missing or read-only. Edit the group first. Nothing was changed.',
      );
    // Activating a scene selects its members. Deactivation only affects its members.
    const changes = catalog
      .filter((item) => enabled || selected.has(memberKey(item.member)))
      .map((item) => ({
        member: item.member,
        enabled: enabled && selected.has(memberKey(item.member)),
      }));
    const skillChanges = changes.flatMap((item) =>
      item.member.kind === 'skill' ? [{ path: item.member.path, enabled: item.enabled }] : [],
    );
    const serverChanges = changes.flatMap((item) =>
      item.member.kind === 'mcp' ? [{ name: item.member.name, enabled: item.enabled }] : [],
    );
    const owner = await this.mcp.owner(options);
    await this.skills.applyBatch(skillChanges, options.cwd, async () => {
      await beforeCommit?.();
      await owner.manager.batchSet(serverChanges);
    });
    await this.mcp.refresh();
    return { enabled, count: changes.length };
  }
}
