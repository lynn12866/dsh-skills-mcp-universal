import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupManager } from '../src/group-manager.js';
import { Groups } from '../src/groups.js';
import { ScopedMcp } from '../src/scopes.js';
import { Skills } from '../src/skills.js';
import { createMethods } from '../src/index.js';
import { host, runtime } from './helpers.js';
import type { Agent, GroupMember, ToolSchema } from '../src/types.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-group-manager-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = ['a', 'b', 'c'].map((name) => join(root, name));
  await Promise.all(paths.map((path) => mkdir(path)));
  const skills = new Skills({ home: join(root, 'home'), agentsHome: join(root, 'agents') });
  const agents = [...paths, undefined].map((cwd) => {
    const tools = new Map<string, ToolSchema>();
    const agent: Agent & { tools: typeof tools } = {
      session: { header: { cwd } },
      tools,
      ctx: undefined!,
    };
    agent.ctx = host({
      tools: { schemas: () => [...tools.values()] },
      plugin: (_plugin, value) => {
        const config = value as { serverName: string; command: string };
        const name = `mcp__${config.serverName}__echo`;
        const schema = { name, description: config.command };
        tools.set(name, schema);
        return Object.assign(Promise.resolve(), {
          dispose: async () => {
            if (tools.get(name) === schema) tools.delete(name);
          },
        });
      },
    });
    return agent;
  });
  const ctx = host({ agents: { list: () => agents } });
  const mcp = new ScopedMcp(ctx, { profileDir: join(root, 'profile'), loadRuntime: runtime });
  t.after(() => mcp.dispose());
  const manager = new GroupManager(skills, mcp, mcp.profileDir);
  const api = createMethods(skills, mcp, ctx.profileContext, manager);
  await manager.register(paths);
  const [a, b, c] = paths;
  const local = (cwd: string, name: string) => join(cwd, '.dsh/skills', name, 'SKILL.md');
  async function entries(name: string) {
    const source = join(root, 'imports', name);
    await mkdir(join(source, 'assets'), { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body.\n`,
    );
    await writeFile(join(source, 'assets/data.txt'), 'asset');
    const scan = await api.skillScan({ directory: source });
    const [result] = await api.skillImport({ token: scan.token, paths: [source] });
    assert.ok(result.ok, result.error);
    const path = join(result.path!, 'SKILL.md');
    await api.serverImport({
      json: { mcpServers: { [name]: { command: name, enabled: true, env: { SECRET: 'hidden' } } } },
    });
    const members: GroupMember[] = [
      { kind: 'skill', path },
      { kind: 'mcp', name },
    ];
    return { path, members };
  }
  return { root, a, b, c, paths, skills, mcp, manager, api, agents, local, entries };
}

test('imports and raw enabled flags cannot expose Skill or MCP without an enabled group', async (t) => {
  const { api, manager, mcp, agents, entries, a, local } = await fixture(t);
  const x = await entries('coding');
  assert.equal((await manager.skillRead(x.path)).modelEnabled, false);
  assert.equal((await manager.skillRead(x.path)).userEnabled, false);
  assert.equal((await mcp.get('coding')).enabled, false);
  await mcp.toggle('coding', true); // A stale client or file flag cannot bypass the group gate.
  for (const agent of agents) assert.equal(agent.tools.size, 0);
  assert.deepEqual(await mcp.effective(a), []);
  assert.deepEqual(await mcp.effective(), []);
  await assert.rejects(access(local(a, 'coding')));
  assert.equal(JSON.stringify(await api.servers({})).includes('hidden'), false);
  const group = await manager.save({ name: 'coding', members: x.members, workspaces: [a] });
  assert.equal(group.enabled, false);
  assert.equal(agents[0].tools.size, 0);
  await assert.rejects(manager.toggle(group.id, 'true' as unknown as boolean), /boolean/);
});

test('one group switch enables all selected workspaces, preserves assets, and survives reopening', async (t) => {
  const { a, b, c, paths, manager, skills, mcp, agents, local, entries } = await fixture(t);
  const x = await entries('coding');
  const group = await manager.save({ name: 'coding', members: x.members, workspaces: [a, b] });
  await manager.toggle(group.id, true);
  for (const cwd of [a, b]) {
    const skill = await skills.read(local(cwd, 'coding'), cwd);
    assert.equal(skill.modelEnabled, true);
    assert.equal(skill.userEnabled, true);
    assert.equal(await readFile(join(local(cwd, 'coding'), '../assets/data.txt'), 'utf8'), 'asset');
  }
  assert.equal((await manager.skillRead(x.path)).modelEnabled, false);
  assert.deepEqual(
    agents.map((agent) => agent.tools.size),
    [1, 1, 0, 0],
  );
  await assert.rejects(access(local(c, 'coding')));
  assert.equal((await manager.serverList())[0].tools.length, 1);
  const reopened = new GroupManager(skills, mcp, mcp.profileDir);
  await reopened.register(paths);
  assert.equal((await reopened.list())[0].enabled, true);
  await reopened.toggle(group.id, false);
  assert.deepEqual(
    agents.map((agent) => agent.tools.size),
    [0, 0, 0, 0],
  );
  for (const cwd of [a, b]) {
    assert.equal((await skills.read(local(cwd, 'coding'), cwd)).modelEnabled, false);
    assert.equal((await skills.read(local(cwd, 'coding'), cwd)).userEnabled, false);
  }
});

test('enabled groups form a union and disabling or deleting a group preserves shared members', async (t) => {
  const { a, manager, skills, agents, local, entries } = await fixture(t);
  const x = await entries('shared'),
    y = await entries('other');
  const first = await manager.save({ name: 'first', members: x.members, workspaces: [a] });
  const second = await manager.save({
    name: 'second',
    members: [...x.members, ...y.members],
    workspaces: [a],
  });
  await manager.toggle(first.id, true);
  await manager.toggle(second.id, true);
  await manager.toggle(second.id, false);
  assert.equal((await skills.read(local(a, 'shared'), a)).modelEnabled, true);
  assert.equal((await skills.read(local(a, 'other'), a)).modelEnabled, false);
  assert.deepEqual([...agents[0].tools.keys()], ['mcp__shared__echo']);
  await manager.remove(first.id);
  assert.equal((await skills.read(local(a, 'shared'), a)).modelEnabled, false);
  assert.equal(agents[0].tools.size, 0);
  await access(local(a, 'shared'));
});

test('workspace multiselection immediately revokes removed targets and applies added targets', async (t) => {
  const { a, b, c, manager, skills, agents, local, entries } = await fixture(t);
  const x = await entries('coding');
  const group = await manager.save({ name: 'coding', members: x.members, workspaces: [a, b] });
  await manager.toggle(group.id, true);
  await manager.assign(group.id, [b, c]);
  assert.deepEqual(
    agents.map((agent) => agent.tools.size),
    [0, 1, 1, 0],
  );
  assert.equal((await skills.read(local(a, 'coding'), a)).modelEnabled, false);
  assert.equal((await skills.read(local(c, 'coding'), c)).modelEnabled, true);
  await manager.assign(group.id, []);
  assert.equal((await manager.list())[0].enabled, false);
  assert.deepEqual(
    agents.map((agent) => agent.tools.size),
    [0, 0, 0, 0],
  );
  await assert.rejects(manager.toggle(group.id, true), /workspace/);
});

test('editing enabled members takes effect immediately; referenced entries cannot be deleted', async (t) => {
  const { a, api, manager, skills, agents, local, entries } = await fixture(t);
  const x = await entries('old'),
    y = await entries('new');
  const group = await manager.save({ name: 'coding', members: x.members, workspaces: [a] });
  await manager.toggle(group.id, true);
  await assert.rejects(api.skillRemove({ path: x.path }), /groups first/);
  await assert.rejects(api.serverRemove({ name: 'old' }), /groups first/);
  await manager.save({ ...group, members: y.members });
  assert.equal((await skills.read(local(a, 'old'), a)).modelEnabled, false);
  assert.equal((await skills.read(local(a, 'new'), a)).modelEnabled, true);
  assert.deepEqual([...agents[0].tools.keys()], ['mcp__new__echo']);
  await api.serverSaveJson({
    previousName: 'new',
    json: { mcpServers: { renamed: { command: 'updated' } } },
  });
  assert.deepEqual([...agents[0].tools.keys()], ['mcp__renamed__echo']);
  assert.ok(
    (await manager.list())[0].members.some(
      (member) => member.kind === 'mcp' && member.name === 'renamed',
    ),
  );
});

test('legacy definitions migrate once, start disabled, and old standalone Skills stop being callable', async (t) => {
  const { a, b, paths, skills, mcp } = await fixture(t);
  const path = join(skills.home, 'skills/legacy/SKILL.md');
  await mkdir(dirnameFor(path), { recursive: true });
  await writeFile(path, '---\nname: legacy\ndescription: legacy\n---\nbody\n');
  await mcp.save({ name: 'legacy', command: 'node' });
  const legacy = new Groups(skills, mcp, mcp.profileDir);
  const old = await legacy.save({
    name: 'legacy',
    members: [
      { kind: 'skill', path },
      { kind: 'mcp', name: 'legacy' },
    ],
  });
  await writeFile(
    join(mcp.profileDir, 'skills-mcp-scenes.json'),
    JSON.stringify({ version: 1, entries: [{ id: old.id, scope: 'global', workspaces: [a, b] }] }),
  );
  // A new state file simulates upgrading an older installation.
  await rm(join(mcp.profileDir, 'skills-mcp-group-state.json'));
  const upgraded = new GroupManager(skills, mcp, mcp.profileDir);
  await upgraded.register(paths);
  const [group] = await upgraded.list();
  assert.deepEqual(group.workspaces, [a, b]);
  assert.equal(group.enabled, false);
  assert.equal((await skills.read(path)).modelEnabled, false);
  assert.equal((await skills.read(path)).userEnabled, false);
  assert.deepEqual(await mcp.effective(a), []);
  const again = new GroupManager(skills, mcp, mcp.profileDir);
  await again.register(paths);
  assert.equal((await again.list()).length, 1);
  await again.toggle(group.id, true);
  assert.equal((await mcp.effective(a)).length, 1);
});

const dirnameFor = (path: string) => join(path, '..');

test('a failure in a later workspace rolls back group state and earlier Skill changes', async (t) => {
  const { a, b, manager, skills, agents, local, entries } = await fixture(t);
  const x = await entries('rollback');
  const group = await manager.save({ name: 'rollback', members: x.members, workspaces: [a, b] });
  const before = await readFile(manager.store.file, 'utf8');
  const apply = skills.applyBatch.bind(skills);
  skills.applyBatch = async (changes, cwd, commit) => {
    if (cwd === b) throw new Error('simulated workspace failure');
    return apply(changes, cwd, commit);
  };
  await assert.rejects(manager.toggle(group.id, true), /simulated/);
  assert.equal(await readFile(manager.store.file, 'utf8'), before);
  await assert.rejects(access(local(a, 'rollback')));
  await assert.rejects(access(local(b, 'rollback')));
  assert.deepEqual(
    agents.map((agent) => agent.tools.size),
    [0, 0, 0, 0],
  );
});

test('missing members block enabling but never prevent disabling or deleting the group', async (t) => {
  const { a, manager, agents, entries } = await fixture(t);
  const x = await entries('missing');
  const group = await manager.save({ name: 'missing', members: x.members, workspaces: [a] });
  await manager.toggle(group.id, true);
  await rm(x.path);
  await manager.toggle(group.id, false);
  assert.equal(agents[0].tools.size, 0);
  await assert.rejects(manager.toggle(group.id, true), /missing/);
  assert.equal((await manager.list())[0].enabled, false);
  await manager.remove(group.id);
});

test('corrupt group state is preserved and closes previously registered MCP tools', async (t) => {
  const { a, manager, mcp, agents, entries } = await fixture(t);
  const x = await entries('safe');
  const group = await manager.save({ name: 'safe', members: x.members, workspaces: [a] });
  await manager.toggle(group.id, true);
  const raw = '{"version":1,"groups":"corrupt"}';
  await writeFile(manager.store.file, raw);
  await mcp.refresh();
  assert.equal(agents[0].tools.size, 0);
  await assert.rejects(manager.toggle(group.id, true), /Corrupt/);
  assert.equal(await readFile(manager.store.file, 'utf8'), raw);
});

test('registered Git subdirectories and symlink aliases resolve to one selectable workspace', async (t) => {
  const { root, a, api, manager, entries } = await fixture(t);
  const nested = join(a, 'nested');
  await mkdir(join(a, '.git'));
  await mkdir(nested);
  const { symlink } = await import('node:fs/promises');
  const alias = join(root, 'alias');
  await symlink(a, alias);
  const catalog = await api.groups({ workspaces: [nested, alias] });
  assert.equal(catalog.workspaceRoots[nested], a);
  assert.equal(catalog.workspaceRoots[alias], a);
  const x = await entries('canonical');
  const group = await manager.save({
    name: 'canonical',
    members: x.members,
    workspaces: [nested, alias],
  });
  assert.deepEqual(group.workspaces, [a]);
});

test('conflicting same-name MCP sources cannot replace another enabled group', async (t) => {
  const { a, b, c, manager, mcp, agents } = await fixture(t);
  await mcp.save({ name: 'same', command: 'source-a' }, undefined, { scope: 'workspace', cwd: a });
  await mcp.save({ name: 'same', command: 'source-b' }, undefined, { scope: 'workspace', cwd: b });
  const first = await manager.save({
    name: 'first',
    members: [{ kind: 'mcp', name: 'same', cwd: a }],
    workspaces: [c],
  });
  const second = await manager.save({
    name: 'second',
    members: [{ kind: 'mcp', name: 'same', cwd: b }],
    workspaces: [c],
  });
  await manager.toggle(first.id, true);
  const state = await readFile(manager.store.file, 'utf8');
  await assert.rejects(manager.toggle(second.id, true), /conflicting MCP/);
  assert.equal(await readFile(manager.store.file, 'utf8'), state);
  assert.equal(agents[2].tools.get('mcp__same__echo')?.description, 'source-a');
  assert.deepEqual(
    agents.map((agent) => agent.tools.size),
    [0, 0, 1, 0],
  );
});

test('a same-name workspace Skill is never silently substituted for the selected library member', async (t) => {
  const { a, manager, skills, entries } = await fixture(t);
  const x = await entries('conflict');
  const path = join(a, '.dsh/skills/conflict/SKILL.md');
  await mkdir(dirnameFor(path), { recursive: true });
  await writeFile(
    path,
    '---\nname: conflict\ndescription: different\ndisable-model-invocation: true\nuser-invocable: false\n---\nDifferent Skill.\n',
  );
  const original = await readFile(path, 'utf8');
  const group = await manager.save({ name: 'conflict', members: x.members, workspaces: [a] });
  await assert.rejects(manager.toggle(group.id, true), /different Skill/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal((await manager.list())[0].enabled, false);
  assert.equal((await skills.read(path, a)).modelEnabled, false);
});

test('two group managers serialize switches without losing unrelated group state', async (t) => {
  const { a, b, paths, manager, skills, mcp, entries } = await fixture(t);
  const x = await entries('parallel-a'),
    y = await entries('parallel-b');
  const first = await manager.save({ name: 'first', members: x.members, workspaces: [a] });
  const second = await manager.save({ name: 'second', members: y.members, workspaces: [b] });
  const reopened = new GroupManager(skills, mcp, mcp.profileDir);
  await reopened.register(paths);
  await Promise.all([manager.toggle(first.id, true), reopened.toggle(second.id, true)]);
  assert.ok((await reopened.list()).every((group) => group.enabled));
  assert.deepEqual(
    (await mcp.effective(a)).map((server) => server.name),
    ['parallel-a'],
  );
  assert.deepEqual(
    (await mcp.effective(b)).map((server) => server.name),
    ['parallel-b'],
  );
});

test('saving an existing group repeatedly preserves its position in the list', async (t) => {
  const { a, manager, entries } = await fixture(t);
  const x = await entries('stable-order');
  const first = await manager.save({ name: 'first', members: x.members, workspaces: [a] });
  const second = await manager.save({ name: 'second', members: x.members, workspaces: [a] });
  const third = await manager.save({ name: 'third', members: x.members, workspaces: [a] });
  for (let attempt = 0; attempt < 10; attempt++) {
    await manager.save({ ...first, name: 'first-' + attempt });
    assert.deepEqual(
      (await manager.list()).map((group) => group.id),
      [first.id, second.id, third.id],
    );
  }
  const data = JSON.parse(await readFile(manager.store.file, 'utf8'));
  assert.deepEqual(
    data.groups.map((group: { id: string }) => group.id),
    [first.id, second.id, third.id],
  );
});

test('identical legacy workspace copies are deduplicated and reused when enabling a group', async (t) => {
  const { a, b, manager, skills, local, entries } = await fixture(t);
  const x = await entries('legacy-copy');
  await manager.library.copyForScene(x.path, undefined, a);
  const existing = local(a, 'legacy-copy');
  await skills.toggle(existing, true, a);
  const body = (await skills.read(existing, a)).content;
  assert.equal((await manager.skillList()).filter((item) => item.name === 'legacy-copy').length, 1);
  const group = await manager.save({
    name: 'same-skill',
    workspaces: [a, b],
    members: [x.members[0], { kind: 'skill', path: existing }],
  });
  assert.equal(group.members.length, 1);
  await manager.toggle(group.id, true);
  assert.equal((await skills.read(existing, a)).content, body);
  assert.equal((await skills.read(existing, a)).modelEnabled, true);
  assert.equal((await skills.read(local(b, 'legacy-copy'), b)).userEnabled, true);
  assert.equal(await readFile(join(existing, '../assets/data.txt'), 'utf8'), 'asset');
  assert.equal((await manager.skillList()).filter((item) => item.name === 'legacy-copy').length, 1);
  await manager.toggle(group.id, false);
  assert.equal((await skills.read(existing, a)).modelEnabled, false);
  assert.equal((await skills.read(existing, a)).userEnabled, false);
});

test('a duplicate legacy group saved by the previous version is repaired on activation', async (t) => {
  const { a, manager, local, entries } = await fixture(t);
  const x = await entries('old-duplicate');
  await manager.library.copyForScene(x.path, undefined, a);
  const existing = local(a, 'old-duplicate');
  const group = await manager.save({
    name: 'old-duplicate',
    members: [x.members[0]],
    workspaces: [a],
  });
  await manager.store.update((data) => {
    data.groups[0].members.push({ kind: 'skill', path: existing });
  });
  await manager.toggle(group.id, true);
  assert.equal((await manager.list())[0].members.length, 1);
  // Persisted members must no longer reference a second source of the same Skill.
  const data = JSON.parse(await readFile(manager.store.file, 'utf8'));
  assert.equal(data.groups[0].members.length, 1);
});

test('same instructions with different resources remain a real conflict and never overwrite assets', async (t) => {
  const { a, manager, local, entries } = await fixture(t);
  const x = await entries('different-assets');
  await manager.library.copyForScene(x.path, undefined, a);
  const existing = local(a, 'different-assets');
  const asset = join(existing, '../assets/data.txt');
  await writeFile(asset, 'workspace-specific asset');
  assert.equal(
    (await manager.skillList()).filter((item) => item.name === 'different-assets').length,
    2,
  );
  const group = await manager.save({
    name: 'different-assets',
    members: [x.members[0]],
    workspaces: [a],
  });
  const before = await readFile(manager.store.file, 'utf8');
  await assert.rejects(manager.toggle(group.id, true), /different Skill/);
  assert.equal(await readFile(asset, 'utf8'), 'workspace-specific asset');
  assert.equal(await readFile(manager.store.file, 'utf8'), before);
});
