import type { TestContext } from 'node:test';
import type { Agent, ToolSchema } from '../src/types.js';
import { host, runtime } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScopedMcp } from '../src/scopes.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scopes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = join(dir, 'workspace-a'),
    b = join(dir, 'workspace-b');
  await mkdir(a);
  await mkdir(b);
  const agents = [a, b].map((cwd) => {
    const tools = new Map<string, ToolSchema>();
    const agent: Agent & { tools: Map<string, ToolSchema> } = {
      session: { header: { cwd } },
      tools,
      ctx: undefined!,
    };
    agent.ctx = host({
      tools: {
        schemas: (scope) => {
          assert.equal(scope, agent);
          return [...tools.values()];
        },
      },
      plugin(_client, value) {
        const config = value as { serverName: string; command: string };
        const name = `mcp__${config.serverName}__echo`;
        const definition = { name, description: config.command };
        tools.set(name, definition);
        return Object.assign(Promise.resolve(), {
          dispose: async () => {
            if (tools.get(name) === definition) tools.delete(name);
          },
        });
      },
    });
    return agent;
  });
  const ctx = host({
    agents: { list: () => agents },
    tools: { schemas: () => [] },
    logger: { error() {}, warn() {} },
  });
  const manager = new ScopedMcp(ctx, { profileDir: join(dir, 'profile'), loadRuntime: runtime });
  t.after(() => manager.dispose());
  return { dir, a, b, agents, manager };
}
test('workspace MCP stays local; disable really unregisters tools and global data is preserved', async (t) => {
  const { a, b, agents, manager } = await fixture(t);
  await manager.save({
    name: 'global',
    command: 'global-command',
    env: { TOKEN: 'SECRET_TOKEN_92851' },
  });
  await manager.save({ name: 'local', command: 'local-command' }, undefined, {
    scope: 'workspace',
    cwd: a,
  });
  await manager.attach(agents[0]);
  await manager.attach(agents[1]);
  assert.ok(agents[0].tools.has('mcp__local__echo'));
  assert.ok(!agents[1].tools.has('mcp__local__echo'));
  assert.equal((await manager.list(a)).find((item) => item.name === 'local')!.scope, 'workspace');
  assert.equal((await manager.list(b)).length, 1);
  assert.ok(!JSON.stringify(await manager.list(a)).includes('SECRET_TOKEN_92851'));
  await manager.toggle('local', false, { scope: 'workspace', cwd: a });
  assert.ok(!agents[0].tools.has('mcp__local__echo'));
  assert.ok(agents.every((agent) => agent.tools.has('mcp__global__echo')));
  await manager.toggle('global', false);
  assert.ok(agents.every((agent) => !agent.tools.has('mcp__global__echo')));
  await manager.toggle('global', true);
  assert.ok(agents.every((agent) => agent.tools.has('mcp__global__echo')));
  const local = JSON.parse(await readFile(join(a, '.dsh/skills-mcp-universal.json'), 'utf8'));
  assert.equal(local.servers[0].enabled, false);
  assert.equal(JSON.parse(await readFile(manager.store.file, 'utf8')).servers.length, 1);
});
test('same names in different scopes are independent and a disabled local override blocks global fallback', async (t) => {
  const { a, b, agents, manager } = await fixture(t);
  await manager.save({ name: 'same', command: 'global-command' });
  await manager.save({ name: 'same', command: 'workspace-command' }, undefined, {
    scope: 'workspace',
    cwd: a,
  });
  await manager.attach(agents[0]);
  await manager.attach(agents[1]);
  assert.equal(agents[0].tools.get('mcp__same__echo')!.description, 'workspace-command');
  assert.equal(agents[1].tools.get('mcp__same__echo')!.description, 'global-command');
  await manager.toggle('same', false, { scope: 'workspace', cwd: a });
  assert.ok(!agents[0].tools.has('mcp__same__echo'));
  assert.ok(agents[1].tools.has('mcp__same__echo'));
  assert.equal((await manager.list(a)).filter((item) => item.name === 'same').length, 2);
  assert.equal((await manager.list(a)).find((item) => item.scope === 'global')!.overridden, true);
  await manager.remove('same', { scope: 'workspace', cwd: a });
  assert.equal(agents[0].tools.get('mcp__same__echo')!.description, 'global-command');
  assert.equal((await manager.list(b))[0].scope, 'global');
});
test('corrupt workspace data fails closed without stopping global disable in other workspaces', async (t) => {
  const { a, agents, manager } = await fixture(t);
  await manager.save({ name: 'one', command: 'node' });
  await manager.save({ name: 'local', command: 'node' }, undefined, { scope: 'workspace', cwd: a });
  await writeFile(join(a, '.dsh/skills-mcp-universal.json'), '{broken');
  await manager.toggle('one', false);
  assert.ok(agents.every((agent) => agent.tools.size === 0));
  assert.equal(await readFile(join(a, '.dsh/skills-mcp-universal.json'), 'utf8'), '{broken');
});

test(
  'a server can be switched off while its first connection is still pending',
  { timeout: 2000 },
  async (t) => {
    const { agents, manager } = await fixture(t);
    let stop: () => void = () => {};
    const ready = new Promise((_, reject) => {
      stop = () => reject(new Error('connection canceled'));
    });
    agents[0].ctx.plugin = () => Object.assign(ready, { dispose: async () => stop() });
    await manager.save({ name: 'slow', command: 'node' });
    const attaching = manager.attach(agents[0]);
    await new Promise((resolve) => setImmediate(resolve));
    await manager.toggle('slow', false);
    await attaching;
    assert.equal((await manager.get('slow')).enabled, false);
    assert.equal(manager.workers.get(agents[0])!.worker.live.size, 0);
  },
);
