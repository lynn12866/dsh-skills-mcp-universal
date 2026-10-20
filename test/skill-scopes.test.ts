import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Skills } from '../src/skills.js';

test('skills carry global/workspace identity and disabling a workspace skill leaves the global copy unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'skill-scopes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    workspace = join(root, 'project');
  const global = join(home, 'skills/same/SKILL.md'),
    local = join(workspace, '.dsh/skills/same/SKILL.md');
  const body = '---\nname: same\ndescription: Test scope\n---\nTest body\n';
  for (const file of [global, local]) {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, body);
  }
  const skills = new Skills({ home, agentsHome: join(root, 'agents') });
  assert.deepEqual(
    (await skills.list()).map((skill) => skill.scope),
    ['global'],
  );
  const both = await skills.list(workspace);
  assert.equal(both.length, 2);
  assert.equal(both.find((skill) => skill.scope === 'workspace')!.workspace, workspace);
  await skills.toggle(local, false, workspace);
  assert.equal(await readFile(global, 'utf8'), body);
  const disabled = (await skills.list(workspace)).find((skill) => skill.scope === 'workspace');
  assert.ok(disabled);
  assert.equal(disabled.modelEnabled, false);
  assert.equal(disabled.userEnabled, false);
  await skills.toggle(local, true, workspace);
  assert.equal(
    (await skills.list(workspace)).find((skill) => skill.scope === 'workspace')!.modelEnabled,
    true,
  );
});
