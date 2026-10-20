import type { GroupManager } from '../src/group-manager.js';
import type { Skills } from '../src/skills.js';
import type { ScopedMcp } from '../src/scopes.js';
import type { Server, ScopeOptions } from '../src/types.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMethods, rpcRoute } from '../src/index.js';

test('shared Connection route validates envelopes and correlates results', async () => {
  const route = rpcRoute('info', async (payload: { value: number }) => ({
    value: payload.value + 1,
  }));
  const request = (payload: unknown) =>
    new Request('http://harness' + route.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const envelope = {
    type: 'client-request',
    rpcId: 'test-id',
    method: 'skills-mcp-universal/info',
    payload: { value: 1 },
  };
  const response = await route.fetch(request(envelope));
  assert.deepEqual(await response.json(), {
    type: 'server-response',
    rpcId: 'test-id',
    result: { ok: true, value: { value: 2 } },
  });
  assert.equal((await route.fetch(request({ ...envelope, method: 'wrong' }))).status, 400);
  assert.equal((await route.fetch(request({ ...envelope, payload: [] }))).status, 400);
});
test('business errors retain RPC structure instead of crashing the Host', async () => {
  const route = rpcRoute('info', async () => {
    throw new Error('configuration is corrupt');
  });
  const response = await route.fetch(
    new Request('http://harness' + route.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'id',
        method: 'skills-mcp-universal/info',
        payload: {},
      }),
    }),
  );
  assert.equal((await response.json()).result.error.message, 'configuration is corrupt');
});

test('JSON editing validates one library server and group activation cannot be bypassed', async () => {
  const saves: unknown[][] = [],
    probes: unknown[][] = [];
  const methods = createMethods(
    {} as Skills,
    {
      save: async (...args: [Server, string?, ScopeOptions?]) => {
        saves.push(args);
        return { name: args[0].name };
      },
      test: async (...args: [Server, AbortSignal?]) => {
        probes.push(args);
        return { ok: true, tools: [] };
      },
    } as unknown as ScopedMcp,
    { name: 'test', home: '/test' },
    {
      serverSave: async (...args: unknown[]) => {
        saves.push(args);
        return { name: (args[0] as Server).name };
      },
    } as unknown as GroupManager,
  );
  const payload = {
    json: JSON.stringify({
      mcpServers: {
        renamed: { command: 'node', args: ['server.js'], enabled: false, scope: 'workspace' },
      },
    }),
    previousName: 'original',
    originCwd: '/workspace',
  };
  assert.deepEqual(await methods.serverSaveJson(payload), { name: 'renamed' });
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0], [
    {
      name: 'renamed',
      transport: 'stdio',
      enabled: false,
      command: 'node',
      args: ['server.js'],
      env: {},
    },
    'original',
    '/workspace',
  ]);
  for (const json of [
    '{',
    JSON.stringify({ mcpServers: { first: { command: 'node' }, second: { command: 'node' } } }),
    JSON.stringify({ mcpServers: { invalid: { command: '' } } }),
  ]) {
    assert.throws(() => methods.serverSaveJson({ ...payload, json }));
    assert.throws(() => methods.serverTestJson({ json }));
  }
  assert.equal(saves.length, 1);
  assert.equal(probes.length, 0);
  for (const method of [
    'skillToggle',
    'serverToggle',
    'skillTransfer',
    'serverTransfer',
    'sceneApply',
  ])
    assert.equal(method in methods, false);
  const signal = new AbortController().signal;
  await methods.serverTestJson(
    { json: JSON.stringify({ name: 'remote', url: 'http://localhost:3000/mcp' }) },
    signal,
  );
  assert.deepEqual(probes[0], [
    {
      name: 'remote',
      transport: 'streamable-http',
      enabled: true,
      url: 'http://localhost:3000/mcp',
      headers: {},
    },
    signal,
  ]);
});
