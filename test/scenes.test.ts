import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Skills } from '../src/skills.js';
import { ScopedMcp } from '../src/scopes.js';
import { Groups } from '../src/groups.js';
import { Scenes, sceneKey } from '../src/scenes.js';
import { host, runtime } from './helpers.js';
import type { Group, SceneRef } from '../src/types.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-scenes-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    a = join(root, 'a'),
    b = join(root, 'b');
  await mkdir(a);
  await mkdir(b);
  const skills = new Skills({ home, agentsHome: join(root, 'agents') });
  const mcp = new ScopedMcp(host(), { profileDir: join(root, 'profile'), loadRuntime: runtime });
  t.after(() => mcp.dispose());
  const groups = new Groups(skills, mcp, mcp.profileDir);
  const scenes = new Scenes(groups, skills, mcp, mcp.profileDir);
  async function group(
    name: string,
    cwd?: string,
  ): Promise<{ group: Group; ref: SceneRef; path: string }> {
    const path = join(cwd ? join(cwd, '.dsh') : home, 'skills', name, 'SKILL.md');
    await mkdir(join(path, '../assets'), { recursive: true });
    await writeFile(
      path,
      `---\nname: ${name}\ndescription: Scene fixture\n---\n${cwd ? 'local' : 'global'} body.  \n`,
    );
    await writeFile(join(path, '../assets/data.txt'), 'preserved asset');
    const options = cwd ? { scope: 'workspace' as const, cwd } : { scope: 'global' as const };
    await mcp.save(
      { name, command: 'node', args: [cwd || 'global'], env: { PROOF: name } },
      undefined,
      options,
    );
    const group = await groups.save(
      {
        name,
        members: [
          { kind: 'skill', path },
          { kind: 'mcp', name },
        ],
      },
      options,
    );
    return { group, ref: { id: group.id, ...options }, path };
  }
  const local = (cwd: string, name: string) => join(cwd, '.dsh/skills', name, 'SKILL.md');
  return { root, home, a, b, skills, mcp, groups, scenes, group, local };
}

test('multiple scenes have independent persistent assignments; assignment changes no entries and excludes global storage', async (t) => {
  const { root, home, a, b, skills, mcp, groups, scenes, group, local } = await fixture(t);
  const x = await group('coding'),
    y = await group('writing');
  const originals = await Promise.all(
    [x.path, y.path, mcp.store.file].map((p) => readFile(p, 'utf8')),
  );
  const alias = join(root, 'alias');
  await symlink(a, alias);
  await scenes.assign(x.ref, [a, alias, b]);
  await scenes.assign(y.ref, [b]);
  const reopened = new Scenes(groups, skills, mcp, mcp.profileDir);
  const catalog = await reopened.list([a, b]);
  assert.equal(catalog.items.length, 2);
  assert.deepEqual(
    catalog.items.find((s) => s.id === x.group.id)!.targets.map((s) => s.cwd),
    [a, b],
  );
  assert.deepEqual(
    catalog.items.find((s) => s.id === y.group.id)!.targets.map((s) => s.cwd),
    [b],
  );
  assert.equal(catalog.items[0]!.targets[0]!.state, 'pending');
  assert.deepEqual(
    await Promise.all([x.path, y.path, mcp.store.file].map((p) => readFile(p, 'utf8'))),
    originals,
  );
  await assert.rejects(access(local(a, 'coding')));
  for (const target of ['', 'global', home, mcp.profileDir])
    await assert.rejects(scenes.assign(x.ref, [target]));
  await assert.rejects(scenes.apply(y.ref, a, true), /Assign/);
  assert.deepEqual(
    (await reopened.list([a, b])).items.find((s) => s.id === x.group.id)!.targets.map((s) => s.cwd),
    [a, b],
  );
});

test('assigned scene disable blocks global fallback, enable restores local entries, and other workspaces and originals stay unchanged', async (t) => {
  const { a, b, mcp, skills, scenes, group, local } = await fixture(t);
  const x = await group('coding');
  const originals = await Promise.all([x.path, mcp.store.file].map((p) => readFile(p, 'utf8')));
  await scenes.assign(x.ref, [a, b]);
  await scenes.apply(x.ref, a, false);
  assert.equal((await skills.read(local(a, 'coding'), a)).modelEnabled, false);
  assert.equal((await mcp.effective(a)).find((s) => s.name === 'coding')!.enabled, false);
  assert.equal((await mcp.effective(b)).find((s) => s.name === 'coding')!.enabled, true);
  assert.equal(
    await readFile(join(local(a, 'coding'), '../assets/data.txt'), 'utf8'),
    'preserved asset',
  );
  await scenes.apply(x.ref, a, true);
  assert.equal((await skills.read(local(a, 'coding'), a)).userEnabled, true);
  assert.equal((await mcp.effective(a)).find((s) => s.name === 'coding')!.enabled, true);
  assert.deepEqual(
    await Promise.all([x.path, mcp.store.file].map((p) => readFile(p, 'utf8'))),
    originals,
  );
  const reopened = new Scenes(new Groups(skills, mcp, mcp.profileDir), skills, mcp, mcp.profileDir);
  assert.equal((await reopened.list([a, b])).items[0]!.targets[0]!.state, 'enabled');
  await reopened.apply(x.ref, a, false);
  assert.equal((await reopened.list([a, b])).items[0]!.targets[0]!.state, 'disabled');
});

test('existing same-name workspace versions take precedence and scene edits, unassignment and deletion preserve entries', async (t) => {
  const { a, b, mcp, skills, groups, scenes, group, local } = await fixture(t);
  const x = await group('same');
  const localDefinition = await group('same', a);
  const before = await readFile(localDefinition.path, 'utf8');
  await scenes.assign(x.ref, [a, b]);
  await scenes.apply(x.ref, a, true);
  assert.equal(await readFile(localDefinition.path, 'utf8'), before);
  const server = await mcp.get('same', { scope: 'workspace', cwd: a });
  assert.equal(server.transport, 'stdio');
  if (server.transport === 'stdio') assert.deepEqual(server.args, [a]);
  await groups.save({ ...x.group, name: 'renamed' });
  assert.deepEqual(
    (await scenes.list([a, b])).items.find((s) => s.id === x.group.id)!.targets.map((s) => s.cwd),
    [a, b],
  );
  await scenes.assign(x.ref, []);
  await scenes.remove(x.ref);
  assert.equal(await readFile(localDefinition.path, 'utf8'), before);
  assert.equal((await skills.read(local(a, 'same'), a)).modelEnabled, true);
  assert.equal((await mcp.get('same', { scope: 'workspace', cwd: a })).enabled, true);
  assert.equal((await scenes.list([a, b])).items[0]!.id, localDefinition.group.id);
});

test('legacy workspace scenes remain distinct, default to their own workspace, and can be assigned elsewhere', async (t) => {
  const { a, b, skills, mcp, groups, scenes, group, local } = await fixture(t);
  const x = await group('legacy', a),
    y = await group('other');
  // Same IDs from different owners are valid and must not collide.
  const store = await groups.owner();
  await store.update((data) => {
    data.groups[0]!.id = x.group.id;
  });
  y.ref.id = x.group.id;
  assert.notEqual(sceneKey(x.ref), sceneKey(y.ref));
  const before = await scenes.list([a, b]);
  assert.equal(before.items.length, 2);
  assert.deepEqual(
    before.items.find((s) => s.source.scope === 'workspace')!.targets.map((s) => s.cwd),
    [a],
  );
  assert.deepEqual(before.items.find((s) => s.source.scope === 'global')!.targets, []);
  await scenes.assign(x.ref, [a, b]);
  await scenes.apply(x.ref, b, false);
  assert.equal((await skills.read(local(b, 'legacy'), b)).modelEnabled, false);
  assert.equal((await skills.read(x.path, a)).modelEnabled, true);
  assert.equal((await mcp.get('legacy', { scope: 'workspace', cwd: b })).enabled, false);
});

test('overlapping assigned scenes switch only the selected workspace; metadata edits do not restore old flags', async (t) => {
  const { a, b, skills, mcp, groups, scenes, group, local } = await fixture(t);
  const x = await group('shared'),
    y = await group('only-b');
  const second = await groups.save({
    name: 'second',
    members: [...x.group.members, ...y.group.members],
  });
  const ref = { id: second.id, scope: 'global' as const };
  await scenes.assign(x.ref, [a, b]);
  await scenes.assign(ref, [a]);
  await scenes.apply(ref, a, true);
  await scenes.apply(x.ref, a, false);
  assert.equal(
    (await scenes.list([a, b])).items.find((s) => s.id === second.id)!.targets[0]!.state,
    'mixed',
  );
  await scenes.apply(x.ref, a, true);
  assert.equal((await skills.read(local(a, 'only-b'), a)).modelEnabled, false);
  assert.equal((await mcp.get('only-b', { scope: 'workspace', cwd: a })).enabled, false);
  await groups.save({ ...second, members: y.group.members });
  await scenes.remove(x.ref);
  const reopened = new Scenes(groups, skills, mcp, mcp.profileDir);
  assert.equal(
    (await reopened.list([a, b])).items.find((s) => s.id === second.id)!.targets[0]!.state,
    'disabled',
  );
  assert.equal((await skills.read(local(a, 'shared'), a)).modelEnabled, true);
});

test('stale assignment or failed activation rolls back newly prepared copies and preserves existing bytes', async (t) => {
  const { a, mcp, groups, scenes, group, local } = await fixture(t);
  const x = await group('rollback');
  await scenes.assign(x.ref, [a]);
  const original = await readFile(mcp.store.file, 'utf8');
  const apply = groups.applyMembers.bind(groups);
  groups.applyMembers = async (...args) => {
    await scenes.assign(x.ref, []);
    return apply(...args);
  };
  await assert.rejects(scenes.apply(x.ref, a, true), /changed/);
  await assert.rejects(access(local(a, 'rollback')));
  await assert.rejects(mcp.get('rollback', { scope: 'workspace', cwd: a }), /not found/);
  assert.equal(await readFile(mcp.store.file, 'utf8'), original);
  groups.applyMembers = apply;
  await scenes.assign(x.ref, [a]);
  await scenes.apply(x.ref, a, false);
  const files = [local(a, 'rollback'), join(a, '.dsh/skills-mcp-universal.json')];
  const bytes = await Promise.all(files.map((p) => readFile(p, 'utf8')));
  const manager = (await mcp.owner({ scope: 'workspace', cwd: a })).manager;
  manager.batchSet = async () => {
    throw new Error('simulated commit failure');
  };
  await assert.rejects(scenes.apply(x.ref, a, true), /commit failure/);
  assert.deepEqual(await Promise.all(files.map((p) => readFile(p, 'utf8'))), bytes);
});

test('corrupt assignment data fails closed and is preserved', async (t) => {
  const { a, scenes, group } = await fixture(t);
  const x = await group('safe');
  await scenes.assign(x.ref, [a]);
  const raw = '{"version":1,"entries":[{"id":12,"scope":"global","workspaces":[]}]}';
  await writeFile(scenes.store.file, raw);
  await assert.rejects(scenes.list([a]), /Invalid/);
  await assert.rejects(scenes.assign(x.ref, [a]), /Invalid/);
  assert.equal(await readFile(scenes.store.file, 'utf8'), raw);
});
