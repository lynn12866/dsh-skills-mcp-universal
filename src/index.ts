import type { HostContext, GroupMember } from './types.js';
import { GroupManager } from './group-manager.js';
import { Skills } from './skills.js';
import { ScopedMcp } from './scopes.js';
import { parseServers } from './mcp.js';
import { basename, dirname, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';

export const name = 'skills-mcp-universal';
export const inject = ['connection', 'tools', 'profileContext', 'agents'];
const namespace = 'skills-mcp-universal';
function singleServer(json: unknown) {
  const servers = parseServers(json);
  if (servers.length !== 1) throw new Error('Editing requires exactly one MCP server.');
  return servers[0];
}

export function createMethods(
  skills: Skills,
  mcp: ScopedMcp,
  profile: Pick<HostContext['profileContext'], 'name' | 'home' | 'cwd'>,
  manager: GroupManager,
) {
  const options = (cwd?: string) => (cwd ? { scope: 'workspace' as const, cwd } : {});
  return {
    info: async (_payload: Record<string, never> = {}) => ({
      profile: profile.name,
      home: profile.home,
      workspace: profile.cwd,
      storage: manager.store.file,
    }),
    skills: (_payload: Record<string, never> = {}) => manager.skillList(),
    skillRead: ({ path }: { path: string }) => manager.skillRead(path),
    skillRemove: ({ path }: { path: string }) => manager.skillRemove(path),
    skillScan: ({ directory }: { directory: string }) => manager.library.scan(directory),
    skillImport: (payload: { token: string; paths: string[] }) => manager.skillImport(payload),
    groups: ({ workspaces = [] }: { workspaces?: string[] } = {}) => manager.catalog(workspaces),
    groupSave: ({
      group,
    }: {
      group: { id?: string; name: string; members: GroupMember[]; workspaces: string[] };
    }) => manager.save(group),
    groupAssign: ({ id, workspaces }: { id: string; workspaces: string[] }) =>
      manager.assign(id, workspaces),
    groupRemove: ({ id }: { id: string }) => manager.remove(id),
    groupApply: ({ id, enabled }: { id: string; enabled: boolean }) => manager.toggle(id, enabled),
    directory: async ({ path }: { path?: string }) => {
      const directory = path || homedir();
      const entries = await readdir(directory, { withFileTypes: true });
      return {
        path: directory,
        parent: dirname(directory),
        name: basename(directory),
        entries: entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => ({ name: entry.name, path: join(directory, entry.name) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    servers: (_payload: Record<string, never> = {}) => manager.serverList(),
    serverRead: async ({ name, originCwd }: { name: string; originCwd?: string }) => {
      const { scope, workspace, ...server } = await mcp.get(name, options(originCwd));
      return server;
    },
    serverSaveJson: ({
      json,
      previousName,
      originCwd,
    }: {
      json: unknown;
      previousName: string;
      originCwd?: string;
    }) => manager.serverSave({ ...singleServer(json), enabled: false }, previousName, originCwd),
    serverRemove: ({ name, originCwd }: { name: string; originCwd?: string }) =>
      manager.serverRemove(name, originCwd),
    serverRestart: ({ name, originCwd }: { name: string; originCwd?: string }) =>
      mcp.restart(name, options(originCwd)),
    serverImport: ({ json }: { json: unknown }) =>
      mcp.import({ servers: parseServers(json).map((server) => ({ ...server, enabled: false })) }),
    serverTestJson: ({ json }: { json: unknown }, signal?: AbortSignal) =>
      mcp.test(singleServer(json), signal),
  };
}

export function rpcRoute<T extends object>(
  method: string,
  invoke: (payload: T, signal?: AbortSignal) => unknown,
) {
  const endpoint = `${namespace}/${method}`;
  return {
    path: `/api/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request) {
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return new Response('JSON required', { status: 415 });
      let message;
      try {
        const body = await request.text();
        if (body.length > 2 * 1024 * 1024) return new Response('Too large', { status: 413 });
        message = JSON.parse(body);
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      if (
        message?.type !== 'client-request' ||
        typeof message.rpcId !== 'string' ||
        message.method !== endpoint ||
        !message.payload ||
        typeof message.payload !== 'object' ||
        Array.isArray(message.payload)
      )
        return new Response('Invalid RPC envelope', { status: 400 });
      let result;
      try {
        result = { ok: true, value: await invoke(message.payload, request.signal) };
      } catch (error) {
        result = {
          ok: false,
          error: {
            code: 'skills-mcp/operation-failed',
            message: error.message ?? String(error),
            details: {},
          },
        };
      }
      return Response.json(
        { type: 'server-response', rpcId: message.rpcId, result },
        { headers: { 'cache-control': 'no-store' } },
      );
    },
  };
}

export async function apply(ctx: HostContext) {
  // Exact Fetch routes reuse browser-token authentication and the Desktop carrier.
  // No independent localhost server, Electron import or rpc.handle() channel.
  if (typeof ctx.connection.fetch?.register !== 'function')
    throw new Error(
      'Skills & MCP requires Harness 0.2.0-rc.2 or newer with Connection Fetch routes.',
    );
  const profile = ctx.profileContext;
  const skills = new Skills({ home: profile.home });
  const mcp = new ScopedMcp(ctx, { profileDir: profile.dir });
  const manager = new GroupManager(skills, mcp, profile.dir);
  ctx.effect(() => () => mcp.dispose(), 'skills-mcp-universal: connection lifecycle');
  ctx.on('agent/created', async ({ agent }) => {
    const cwd = agent.session?.header?.cwd;
    await manager.register(cwd ? [cwd] : []);
    await mcp.attach(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => mcp.detach(agent));
  for (const [method, invoke] of Object.entries(createMethods(skills, mcp, profile, manager))) {
    ctx.effect(
      () =>
        ctx.connection.fetch.register(
          rpcRoute(method, invoke as (payload: object, signal?: AbortSignal) => unknown),
        ),
      `skills-mcp-universal: ${method}`,
    );
  }
  // Keep the UI reachable if a preserved configuration needs repair.
  try {
    await manager.register([
      ...new Set(
        [profile.cwd, ...ctx.agents.list().map((agent) => agent.session?.header?.cwd)].filter(
          (cwd): cwd is string => !!cwd,
        ),
      ),
    ]);
    await mcp.start();
  } catch (error) {
    ctx.logger.error('Skills & MCP configuration could not load: ' + error.message);
  }
}

export type Api = ReturnType<typeof createMethods>;
export type ApiPayload<M extends keyof Api> = Parameters<Api[M]>[0];
export type ApiResult<M extends keyof Api> = Awaited<ReturnType<Api[M]>>;
