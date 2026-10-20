import type { TestContext } from 'node:test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Skills, projectRoot, parseSkill } from '../src/skills.js';
const raw = (name = 'example') =>
  `---\nname: ${name}\ndescription: |\n  A multiline description.\n  With two lines.\nmetadata:\n  nested: { value: 3 }\n---\nBody with exact whitespace.  \n`;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new Skills({ home: join(root, 'home'), agentsHome: join(root, 'agents') });
  const skill = join(root, 'home/skills/example/SKILL.md');
  await mkdir(join(root, 'home/skills/example'), { recursive: true });
  await writeFile(skill, raw());
  return { root, manager, skill };
}
test('YAML metadata, body and CRLF survive enable/disable', async (t) => {
  const { manager, skill } = await fixture(t);
  await writeFile(skill, raw().replaceAll('\n', '\r\n'));
  assert.equal(
    (await manager.list())[0].description,
    'A multiline description.\nWith two lines.\n',
  );
  await manager.toggle(skill, false);
  let content = await readFile(skill, 'utf8');
  assert.match(content, /disable-model-invocation: true/);
  assert.equal(parseSkill(content).modelEnabled, false);
  assert.equal(parseSkill(content).userEnabled, false);
  assert.ok(content.endsWith('Body with exact whitespace.  \r\n'));
  assert.ok(!content.replaceAll('\r\n', '').includes('\n'));
  await manager.toggle(skill, true);
  content = await readFile(skill, 'utf8');
  assert.equal(parseSkill(content).document.toJS().metadata.nested.value, 3);
  assert.equal(parseSkill(content).modelEnabled, true);
});
test('non-Git workspace falls back to cwd, Git subdirectory finds project root', async (t) => {
  const { root } = await fixture(t);
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  assert.equal(await projectRoot(workspace), workspace);
  await writeFile(join(workspace, '.git'), 'gitdir: other');
  assert.equal(await projectRoot(join(workspace, 'nested')), workspace);
});
test('direct bundle and parent import preserve assets and never overwrite duplicates', async (t) => {
  const { root, manager } = await fixture(t);
  const source = join(root, 'download/new-skill');
  await mkdir(join(source, 'assets'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), raw('new-skill'));
  await writeFile(join(source, 'assets/data.txt'), 'asset');
  const scan = await manager.scan(source);
  assert.equal(scan.items.length, 1);
  const result = await manager.import({ token: scan.token, paths: [source] });
  assert.equal(result[0].ok, true);
  assert.equal(
    await readFile(join(root, 'home/skills/new-skill/assets/data.txt'), 'utf8'),
    'asset',
  );
  const duplicate = await manager.import({ token: scan.token, paths: [source] });
  assert.equal(duplicate[0].ok, false);
  const parentScan = await manager.scan(join(root, 'download'));
  assert.equal(parentScan.items.length, 1);
});
test('mutations reject arbitrary paths; deleting a managed bundle is recoverable', async (t) => {
  const { root, manager, skill } = await fixture(t);
  const external = join(root, 'outside.md');
  await writeFile(external, raw());
  await assert.rejects(manager.toggle(external, false), /outside/);
  await assert.rejects(access(external + '.lock'));
  await assert.rejects(manager.remove(external), /outside/);
  const receipt = await manager.remove(skill);
  assert.equal(await readFile(join(receipt.recoveryPath, 'SKILL.md'), 'utf8'), raw());
  await assert.rejects(access(skill));
});
test('external symlinks are read-only and import does not copy symlinks', async (t) => {
  const { root, manager } = await fixture(t);
  const external = join(root, 'external');
  await mkdir(external);
  await writeFile(join(external, 'SKILL.md'), raw('external'));
  await symlink(external, join(root, 'home/skills/external'));
  const item = (await manager.list()).find((item) => item.name === 'external');
  assert.ok(item);
  assert.equal(item.writable, false);
  await assert.rejects(manager.remove(item.path), /read-only/);
  await symlink(join(root, 'home'), join(external, 'escape'));
  const scan = await manager.scan(external);
  const result = await manager.import({ token: scan.token, paths: [external] });
  assert.equal(result[0].ok, false);
});
test('invalid metadata is visible as a diagnostic and cannot be toggled', async (t) => {
  const { manager, skill } = await fixture(t);
  await writeFile(skill, '---\nname: x\n---\ntext');
  const [item] = await manager.list();
  assert.match(item.error!, /description/);
  await assert.rejects(manager.toggle(skill, false), /invalid/);
});

test('project and flat-file imports work in a workspace without Git', async (t) => {
  const { root, manager } = await fixture(t);
  const source = join(root, 'flat');
  const cwd = join(root, 'project');
  await mkdir(source);
  await mkdir(cwd);
  await writeFile(join(source, 'flat.md'), raw('flat-skill'));
  const scan = await manager.scan(source);
  const result = await manager.import({
    token: scan.token,
    paths: [scan.items[0].sourcePath],
    scope: 'project',
    cwd,
  });
  assert.equal(result[0].ok, true);
  assert.equal(
    (await manager.list(cwd)).find((item) => item.name === 'flat-skill')!.source,
    'project-dsh',
  );
  await assert.rejects(
    manager.import({ token: scan.token, paths: [scan.items[0].sourcePath], scope: 'project' }),
    /workspace/,
  );
});

test('two app instances cannot recreate a skill while it is being deleted', async (t) => {
  const { root, manager, skill } = await fixture(t);
  const other = new Skills({ home: join(root, 'home'), agentsHome: join(root, 'agents') });
  const results = await Promise.allSettled([manager.toggle(skill, false), other.remove(skill)]);
  assert.equal(results[1].status, 'fulfilled');
  await assert.rejects(access(skill));
  assert.ok(
    parseSkill(await readFile(join(results[1].value.recoveryPath, 'SKILL.md'), 'utf8')).name,
  );
});
