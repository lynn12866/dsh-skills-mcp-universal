import { host, runtime } from './helpers.js';
import type { Fiber } from '../src/types.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mcp, normalizeServer, parseServers } from '../src/mcp.js';
import { JsonStore } from '../src/storage.js';

test('validates MCP schemas and imports common JSON formats', () => {
  const [stdio] = parseServers({
    mcpServers: { memory: { command: 'node', args: ['server.js'], env: { TOKEN: 'test' } } },
  });
  assert.equal(stdio.transport, 'stdio');
  const remote = parseServers({
    servers: [{ name: 'remote', transport: 'streamable-http', url: 'https://example.com/mcp' }],
  })[0];
  assert.equal(remote.transport, 'streamable-http');
  assert.equal(remote.url, 'https://example.com/mcp');
  assert.throws(() => normalizeServer({ name: 'x', command: 'node', args: 'wrong' }), /array/);
  assert.throws(
    () => normalizeServer({ name: 'x', command: 'node', env: { TOKEN: null } }),
    /string/,
  );
  assert.throws(
    () => normalizeServer({ name: 'x', transport: 'sse', url: 'https://example.com' }),
    /Supported/,
  );
  assert.throws(() => normalizeServer({ name: 'x', url: 'file:///etc/passwd' }), /HTTP/);
});
test('concurrent writes are serialized, secrets get owner-only permissions, corrupt files stay intact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'data.json');
  const a = new JsonStore(file, { count: 0 });
  const b = new JsonStore(file, { count: 0 });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? a : b).update((data) => {
        data.count++;
      }),
    ),
  );
  assert.equal((await a.read()).count, 20);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await writeFile(file, '{broken');
  await assert.rejects(a.update(() => {}));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
test('save/toggle/edit/remove dispose fibers and do not leak secrets in list', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let starts = 0,
    stops = 0;
  const ctx = host({
    tools: { schemas: () => [{ name: 'mcp__one__echo', description: 'Echo' }] },
    plugin() {
      starts++;
      return Object.assign(Promise.resolve(), {
        dispose: async () => {
          stops++;
        },
      });
    },
  });
  const manager = new Mcp(ctx, { profileDir: dir, loadRuntime: runtime });
  const server = { name: 'one', command: 'node', env: { SECRET: 'private' } };
  await manager.save(server);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal((await manager.list())[0].tools.length, 1);
  assert.ok(!JSON.stringify(await manager.list()).includes('private'));
  await assert.rejects(manager.save(server), /already exists/);
  await manager.toggle('one', false);
  assert.equal(stops, 1);
  await manager.toggle('one', true);
  assert.equal(starts, 2);
  await manager.save({ ...server, name: 'two' }, 'one');
  assert.equal(stops, 2);
  await manager.remove('two');
  assert.equal(stops, 3);
  assert.equal((await manager.list()).length, 0);
  await manager.dispose();
});

test('unloading cancels an in-flight isolated probe and rejects queued probes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-probe-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contexts: ProbeContext[] = [];
  class ProbeContext {
    stopped = false;
    reject?: (error: Error) => void;
    fiber: { dispose(): Promise<void> };
    constructor() {
      contexts.push(this);
      this.stopped = false;
      this.fiber = {
        dispose: async () => {
          this.stopped = true;
          this.reject?.(new Error('probe stopped'));
        },
      };
    }
    provide() {}
    plugin(): Fiber {
      return Object.assign(
        new Promise((_, reject) => {
          this.reject = reject;
        }),
        { dispose: async () => {} },
      );
    }
  }
  const manager = new Mcp(host(), {
    profileDir: dir,
    loadRuntime: async () => ({ Context: ProbeContext, client: {} }),
  });
  const probing = manager.test({ name: 'probe', command: 'node' });
  while (!contexts.length) await new Promise((resolve) => setImmediate(resolve));
  await manager.dispose();
  assert.equal((await probing).ok, false);
  assert.equal(contexts[0].stopped, true);
  assert.equal(manager.probeRoots.size, 0);
  await assert.rejects(manager.test({ name: 'later', command: 'node' }), /unloaded/);
});
