import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Skills, parseSkill } from '../src/skills.js';
import { ScopedMcp } from '../src/scopes.js';
import { Groups } from '../src/groups.js';
import { host, runtime } from './helpers.js';
import type { Member } from '../src/types.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-groups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    a = join(root, 'a'),
    b = join(root, 'b');
  await mkdir(a);
  await mkdir(b);
  const skills = new Skills({ home, agentsHome: join(root, 'agents') });
  const mcp = new ScopedMcp(host(), { profileDir: join(root, 'profile'), loadRuntime: runtime });
  t.after(() => mcp.dispose());
  const groups = new Groups(skills, mcp, join(root, 'profile'));
  async function skill(name: string, cwd?: string) {
    const path = join(cwd ? join(cwd, '.dsh') : home, 'skills', name, 'SKILL.md');
    await mkdir(join(path, '..', 'assets'), { recursive: true });
    await writeFile(
      path,
      `---\nname: ${name}\ndescription: Test group\n---\nBody with spaces.  \n`,
    );
    await writeFile(join(path, '..', 'assets/data.txt'), 'resource bytes');
    return path;
  }
  return { root, home, a, b, skills, mcp, groups, skill };
}

test('a scene selects Skills and MCP together, deactivation affects only members, and groups persist', async (t) => {
  const { skills, mcp, groups, skill } = await fixture(t);
  const coding = await skill('coding'),
    drawing = await skill('drawing');
  await mcp.save({ name: 'code', command: 'node' });
  await mcp.save({ name: 'draw', command: 'node' });
  const group = await groups.save({
    name: '编码',
    members: [
      { kind: 'skill', path: coding },
      { kind: 'mcp', name: 'code' },
    ],
  });
  await groups.apply(group.id, true);
  assert.equal(parseSkill(await readFile(coding, 'utf8')).modelEnabled, true);
  assert.equal(parseSkill(await readFile(drawing, 'utf8')).userEnabled, false);
  assert.equal((await mcp.get('code')).enabled, true);
  assert.equal((await mcp.get('draw')).enabled, false);
  assert.equal((await groups.list())[0].state, 'enabled');
  await mcp.toggle('draw', true);
  await groups.apply(group.id, false);
  assert.equal((await mcp.get('draw')).enabled, true);
  assert.equal((await mcp.get('code')).enabled, false);
  assert.equal((await skills.read(coding)).modelEnabled, false);
  const reopened = new Groups(skills, mcp, mcp.profileDir);
  assert.equal((await reopened.list())[0].name, '编码');
  assert.equal((await reopened.list())[0].state, 'disabled');
  await reopened.apply(group.id, true);
  await skills.toggle(coding, false);
  assert.equal((await reopened.list())[0].state, 'mixed');
});

test('workspace scenes never mutate global entries or another workspace, even with same names', async (t) => {
  const { a, b, mcp, groups, skill } = await fixture(t);
  const global = await skill('same'),
    local = await skill('same', a),
    other = await skill('same', b);
  await mcp.save({ name: 'same', command: 'global-command' });
  await mcp.save({ name: 'same', command: 'local-command' }, undefined, {
    scope: 'workspace',
    cwd: a,
  });
  await mcp.save({ name: 'same', command: 'other-command' }, undefined, {
    scope: 'workspace',
    cwd: b,
  });
  const files = [global, other, mcp.store.file, join(b, '.dsh/skills-mcp-universal.json')];
  const original = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  const options = { scope: 'workspace' as const, cwd: a };
  const group = await groups.save(
    {
      name: '本地编码',
      members: [
        { kind: 'skill', path: local },
        { kind: 'mcp', name: 'same' },
      ],
    },
    options,
  );
  await groups.apply(group.id, false, options);
  assert.equal(parseSkill(await readFile(local, 'utf8')).modelEnabled, false);
  assert.equal((await mcp.get('same', options)).enabled, false);
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file, 'utf8'))), original);
  assert.equal((await groups.list({ scope: 'workspace', cwd: b })).length, 0);
  await assert.rejects(
    groups.save({ name: 'bad', members: [{ kind: 'skill', path: global }] }, options),
    /current scope/,
  );
});

test('invalid and stale group operations do not change configuration; failed MCP commits restore exact Skill bytes', async (t) => {
  const { mcp, groups, skill } = await fixture(t);
  const path = await skill('coding');
  await mcp.save({ name: 'code', command: 'node' });
  const members: Member[] = [
    { kind: 'skill', path },
    { kind: 'mcp', name: 'code' },
  ];
  const group = await groups.save({ name: '编码', members });
  const original = await readFile(path, 'utf8');
  const groupStore = await groups.owner();
  const originalGroup = await readFile(groupStore.file, 'utf8');
  await assert.rejects(groups.save({ name: '编码', members }), /already exists/);
  await assert.rejects(groups.save({ id: 'missing', name: 'other', members }), /no longer/);
  assert.equal(await readFile(groupStore.file, 'utf8'), originalGroup);
  const store = mcp.global.store;
  const update = store.update;
  store.update = async () => {
    throw new Error('simulated disk failure');
  };
  await assert.rejects(groups.apply(group.id, false), /disk failure/);
  store.update = update;
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal((await mcp.get('code')).enabled, true);
  await mcp.remove('code');
  assert.equal((await groups.list())[0].missing, 1);
  await assert.rejects(groups.apply(group.id, true), /missing/);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('global Skill copy and move preserve resources and disabled flags and reject both local-root conflicts', async (t) => {
  const { a, b, skills, skill } = await fixture(t);
  const source = await skill('copy-skill');
  await skills.toggle(source, false);
  const original = await readFile(source, 'utf8');
  const copied = await skills.transfer(source, a);
  assert.equal(await readFile(join(copied.path, 'SKILL.md'), 'utf8'), original);
  assert.equal(await readFile(join(copied.path, 'assets/data.txt'), 'utf8'), 'resource bytes');
  assert.equal(await readFile(source, 'utf8'), original);
  await assert.rejects(skills.transfer(source, a, 'move'), /already exists/);
  assert.equal(await readFile(source, 'utf8'), original);
  const moved = await skills.transfer(source, b, 'move');
  await assert.rejects(access(source));
  assert.equal(await readFile(join(moved.path, 'SKILL.md'), 'utf8'), original);
  assert.equal(await readFile(join(moved.recoveryPath!, 'SKILL.md'), 'utf8'), original);
  const second = await skill('conflict');
  await mkdir(join(a, '.agents/skills/conflict'), { recursive: true });
  await writeFile(
    join(a, '.agents/skills/conflict/SKILL.md'),
    '---\nname: conflict\ndescription: original\n---\n',
  );
  await assert.rejects(skills.transfer(second, a), /already exists/);
  await symlink(second, join(second, '..', 'unsafe'));
  await assert.rejects(skills.transfer(second, b), /symbolic/);
  assert.equal(
    (await skills.list(b)).filter((item) => item.scope === 'workspace' && item.name === 'conflict')
      .length,
    0,
  );
});

test('MCP copy/move preserve secrets and enabled state; conflicts leave both files byte-identical', async (t) => {
  const { a, b, mcp } = await fixture(t);
  await mcp.save({ name: 'copy', command: 'node', enabled: false, env: { TOKEN: 'keep-private' } });
  await mcp.save({ name: 'unrelated', command: 'node' });
  const original = await readFile(mcp.store.file, 'utf8');
  await mcp.transfer('copy', a);
  assert.equal(await readFile(mcp.store.file, 'utf8'), original);
  const target = join(a, '.dsh/skills-mcp-universal.json');
  const targetBytes = await readFile(target, 'utf8');
  await assert.rejects(mcp.transfer('copy', a, 'move'), /already exists/);
  assert.equal(await readFile(target, 'utf8'), targetBytes);
  assert.equal(await readFile(mcp.store.file, 'utf8'), original);
  await mcp.transfer('copy', b, 'move');
  await assert.rejects(mcp.get('copy'), /not found/);
  const copied = await mcp.get('copy', { scope: 'workspace', cwd: b });
  assert.equal(copied.enabled, false);
  assert.equal(copied.transport, 'stdio');
  assert.equal(copied.env.TOKEN, 'keep-private');
  assert.equal((await mcp.get('unrelated')).enabled, true);
  assert.equal(await readFile(target, 'utf8'), targetBytes);
});

test('a read-only linked global Skill can be copied as independent files while move is rejected', async (t) => {
  const { root, home, a, skills } = await fixture(t);
  const external = join(root, 'external');
  await mkdir(external, { recursive: true });
  await mkdir(join(home, 'skills'), { recursive: true });
  const raw = '---\nname: linked\ndescription: Linked source\n---\nBody\n';
  await writeFile(join(external, 'SKILL.md'), raw);
  await symlink(external, join(home, 'skills/linked'));
  const source = join(home, 'skills/linked/SKILL.md');
  assert.equal((await skills.managed(source)).writable, false);
  const copy = await skills.transfer(source, a);
  assert.equal(await readFile(join(copy.path, 'SKILL.md'), 'utf8'), raw);
  assert.equal((await skills.managed(join(a, '.dsh/skills/linked/SKILL.md'), a)).writable, true);
  await assert.rejects(skills.transfer(source, a, 'move'), /read-only/);
  assert.equal(await readFile(join(external, 'SKILL.md'), 'utf8'), raw);
});

for (const scope of ['global', 'workspace'] as const) {
  test(`${scope}: overlapping groups derive state from entries; member edits and group deletion preserve original entries`, async (t) => {
    const { a, b, mcp, groups, skill, skills } = await fixture(t);
    const options = scope === 'workspace' ? { scope, cwd: a } : { scope };
    const paths = await Promise.all(
      ['shared', 'only-a', 'only-b'].map((name) =>
        skill(name, scope === 'workspace' ? a : undefined),
      ),
    );
    const names = ['shared', 'only-a', 'only-b'];
    for (const name of names)
      await mcp.save(
        { name, command: 'node', args: [name], env: { PROOF: name } },
        undefined,
        options,
      );
    const members = (indices: number[]): Member[] =>
      indices.flatMap((index) => [
        { kind: 'skill' as const, path: paths[index]! },
        { kind: 'mcp' as const, name: names[index]! },
      ]);
    const groupA = await groups.save({ name: 'A', members: members([0, 1]) }, options);
    const groupB = await groups.save({ name: 'B', members: members([0, 2]) }, options);
    const bodies = await Promise.all(
      paths.map((path) => readFile(path, 'utf8').then((raw) => parseSkill(raw).content)),
    );
    const check = async (expected: boolean[]) => {
      assert.deepEqual(
        await Promise.all(
          paths.map((path) =>
            skills.read(path, options.cwd).then((item) => [item.modelEnabled, item.userEnabled]),
          ),
        ),
        expected.map((enabled) => [enabled, enabled]),
      );
      assert.deepEqual(
        await Promise.all(names.map((name) => mcp.get(name, options).then((item) => item.enabled))),
        expected,
      );
      for (let i = 0; i < paths.length; i++) {
        assert.equal(parseSkill(await readFile(paths[i]!, 'utf8')).content, bodies[i]);
        assert.equal(
          await readFile(join(paths[i]!, '../assets/data.txt'), 'utf8'),
          'resource bytes',
        );
        const server = await mcp.get(names[i]!, options);
        assert.equal(server.transport, 'stdio');
        if (server.transport !== 'stdio') throw new Error('Expected stdio');
        assert.deepEqual(server.args, [names[i]]);
        assert.deepEqual(server.env, { PROOF: names[i] });
      }
      assert.equal((await groups.list({ scope: 'workspace', cwd: b })).length, 0);
    };
    await groups.apply(groupA.id, true, options);
    await check([true, true, false]);
    await groups.apply(groupB.id, true, options);
    await check([true, false, true]);
    await groups.apply(groupA.id, false, options);
    await check([false, false, true]);
    assert.equal(
      (await groups.list(options)).find((group) => group.id === groupB.id)!.state,
      'mixed',
    );
    await groups.apply(groupB.id, true, options);
    await check([true, false, true]);
    await groups.save({ ...groupB, members: members([1, 2]) }, options);
    await check([true, false, true]);
    await groups.apply(groupB.id, true, options);
    await check([false, true, true]);
    await groups.save({ ...groupB, members: members([0, 1]) }, options);
    await check([false, true, true]);
    await groups.apply(groupB.id, true, options);
    await check([true, true, false]);
    await groups.remove(groupA.id, options);
    await check([true, true, false]);
    await groups.remove(groupB.id, options);
    await check([true, true, false]);
    assert.deepEqual(await groups.list(options), []);
  });
}
