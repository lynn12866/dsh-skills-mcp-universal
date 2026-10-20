import type {
  Agent,
  HostContext,
  RuntimeLoader,
  ScopedServer,
  ScopeOptions,
  ServerSummary,
  ToolSchema,
} from './types.js';
import { isAbsolute, join } from 'node:path';
import { realpath, stat, readFile, rm } from 'node:fs/promises';
import { Mcp, loadNativeRuntime } from './mcp.js';
import { projectRoot } from './skills.js';
import { serial, atomicWrite, fileLock } from './storage.js';

export async function workspaceRoot(cwd: string) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd))
    throw new Error('Select an absolute workspace directory.');
  const path = await realpath(cwd);
  if (!(await stat(path)).isDirectory()) throw new Error('Workspace must be a directory.');
  return projectRoot(path);
}

// Configuration is global or workspace-local. Connections and tools are owned
// by each Agent's native scope, so workspace tools never enter another Agent.
interface WorkerEntry {
  workspace: string | null;
  effective: ScopedServer[];
  worker: Mcp;
}
export class ScopedMcp {
  profileDir: string;
  loadRuntime: RuntimeLoader;
  queue = serial();
  transferQueue = serial();
  owners = new Map<string, Mcp>();
  workers = new Map<Agent, WorkerEntry>();
  closed = false;
  global: Mcp;
  store: Mcp['store'];
  disposal?: Promise<void>;
  resolveServers?: (cwd?: string | null) => Promise<ScopedServer[]>;
  constructor(
    public ctx: HostContext,
    {
      profileDir,
      loadRuntime = loadNativeRuntime,
    }: { profileDir: string; loadRuntime?: RuntimeLoader },
  ) {
    this.ctx = ctx;
    this.profileDir = profileDir;
    this.loadRuntime = loadRuntime;

    this.global = this.records(profileDir);
    this.store = this.global.store;
  }

  records(dir: string) {
    return new Mcp(this.ctx, {
      profileDir: dir,
      loadRuntime: this.loadRuntime,
      onChange: () => this.refresh(),
    });
  }

  async owner({ scope = 'global', cwd }: ScopeOptions = {}) {
    if (scope === 'global') return { manager: this.global, scope, workspace: null };
    if (scope !== 'workspace') throw new Error('Invalid MCP scope.');
    const workspace = await workspaceRoot(cwd!);
    if (!this.owners.has(workspace))
      this.owners.set(workspace, this.records(join(workspace, '.dsh')));
    return { manager: this.owners.get(workspace)!, scope, workspace };
  }

  async effective(cwd?: string | null): Promise<ScopedServer[]> {
    if (this.resolveServers) return this.resolveServers(cwd);
    const global = (await this.global.read()).map((server) => ({
      ...server,
      scope: 'global' as const,
      workspace: null,
    }));
    if (!cwd) return global;
    const { manager, workspace } = await this.owner({ scope: 'workspace', cwd });
    const local = (await manager.read()).map((server) => ({
      ...server,
      scope: 'workspace' as const,
      workspace,
    }));
    const names = new Set(local.map((server) => server.name));
    return [...global.filter((server) => !names.has(server.name)), ...local];
  }

  async reconcile(agent: Agent) {
    if (this.closed) return;
    const cwd = agent.session?.header?.cwd;
    let workspace: string | null, effective: ScopedServer[];
    try {
      workspace = cwd ? await workspaceRoot(cwd) : null;
      effective = await this.effective(workspace);
    } catch (error) {
      const previous = this.workers.get(agent);
      this.workers.delete(agent);
      if (previous) await previous.worker.dispose();
      throw error;
    }
    if (this.closed) return;
    let entry = this.workers.get(agent);
    if (!entry) {
      const created: WorkerEntry = { workspace, effective: [], worker: undefined! };
      const store = {
        file: '',
        read: async () => ({
          version: 1,
          servers: created.effective.map(({ scope, workspace, ...server }) => server),
        }),
      };
      created.worker = new Mcp(agent.ctx, { store, scope: agent, loadRuntime: this.loadRuntime });
      this.workers.set(agent, created);
      entry = created;
    }
    entry.workspace = workspace;
    entry.effective = effective;
    await entry.worker.sync(await entry.worker.read());
    return entry;
  }

  async attach(agent: Agent) {
    const entry = await this.queue(async () => {
      if (this.closed) return;
      return this.reconcile(agent);
    });
    if (!entry) return;
    // Await first discovery for this Agent without holding the manager's queue:
    // a user must still be able to switch off a server while it is starting.
    await Promise.allSettled(
      [...entry.worker.live.values()].map((value) => Promise.resolve(value.fiber)),
    );
  }

  detach(agent: Agent) {
    return this.queue(async () => {
      const entry = this.workers.get(agent);
      this.workers.delete(agent);
      if (entry) await entry.worker.dispose();
    });
  }

  refresh() {
    return this.queue(async () => {
      if (this.closed) return;
      const agents = this.ctx.agents.list();
      for (const agent of agents) {
        try {
          await this.reconcile(agent);
        } catch (error) {
          this.ctx.logger?.warn?.('MCP workspace configuration could not load: ' + error.message);
        }
      }
      for (const [agent, entry] of this.workers) {
        if (!agents.includes(agent)) {
          this.workers.delete(agent);
          await entry.worker.dispose();
        }
      }
    });
  }

  start() {
    return this.refresh();
  }

  async list(cwd?: string): Promise<ServerSummary[]> {
    await this.refresh();
    const global = (await this.global.read()).map((server) => ({
      ...server,
      scope: 'global' as const,
      workspace: null,
    }));
    const localOwner = cwd ? await this.owner({ scope: 'workspace', cwd }) : null;
    const local = localOwner
      ? (await localOwner.manager.read()).map((server) => ({
          ...server,
          scope: 'workspace' as const,
          workspace: localOwner.workspace,
        }))
      : [];
    const localNames = new Set(local.map((server) => server.name));
    return [...global, ...local].map((server) => {
      const overridden = server.scope === 'global' && localNames.has(server.name);
      const sessions = [...this.workers.entries()].filter(
        ([, entry]) =>
          (!localOwner || entry.workspace === localOwner.workspace) &&
          entry.effective.some(
            (item) =>
              item.name === server.name &&
              item.scope === server.scope &&
              item.workspace === server.workspace,
          ),
      );
      const states = sessions.map(([, entry]) => entry.worker.live.get(server.name)?.state);
      const error = sessions.map(([, entry]) => entry.worker.errors.get(server.name)).find(Boolean);
      const tools = new Map<string, ToolSchema>();
      for (const [agent, entry] of sessions) {
        if (entry.worker.live.get(server.name)?.state !== 'active') continue;
        for (const tool of agent.ctx.tools.schemas(agent))
          if (tool.name.startsWith(`mcp__${server.name}__`))
            tools.set(tool.name, { name: tool.name, description: tool.description });
      }
      return {
        name: server.name,
        scope: server.scope,
        workspace: server.workspace,
        enabled: server.enabled,
        overridden,
        transport: server.transport,
        target: server.transport === 'stdio' ? server.command : server.url,
        state: !server.enabled
          ? 'disabled'
          : overridden
            ? 'overridden'
            : states.includes('active')
              ? 'active'
              : error
                ? 'failed'
                : states.includes('starting')
                  ? 'starting'
                  : 'idle',
        error,
        tools: [...tools.values()],
      };
    });
  }

  async get(name: string, options?: ScopeOptions) {
    const owner = await this.owner(options);
    return { ...(await owner.manager.get(name)), scope: owner.scope, workspace: owner.workspace };
  }

  async save(server: unknown, previousName?: string, options?: ScopeOptions) {
    return (await this.owner(options)).manager.save(server, previousName);
  }

  async import(json: unknown, options?: ScopeOptions) {
    return (await this.owner(options)).manager.import(json);
  }

  async toggle(name: string, enabled: boolean, options?: ScopeOptions) {
    return (await this.owner(options)).manager.toggle(name, enabled);
  }

  async remove(name: string, options?: ScopeOptions) {
    return (await this.owner(options)).manager.remove(name);
  }

  async restart(name: string, options?: ScopeOptions) {
    const owner = await this.owner(options);
    await owner.manager.get(name);
    await this.queue(async () => {
      for (const entry of this.workers.values()) {
        if (
          !entry.effective.some(
            (item) =>
              item.name === name &&
              item.scope === owner.scope &&
              item.workspace === owner.workspace,
          )
        )
          continue;
        const live = entry.worker.live.get(name);
        entry.worker.live.delete(name);
        if (live) await live.fiber.dispose();
      }
    });
    await this.refresh();
    return { name };
  }

  async transfer(name: string, destinationCwd: string, mode: 'copy' | 'move' = 'copy') {
    if (!['copy', 'move'].includes(mode)) throw new Error('Invalid transfer mode.');
    const target = (await this.owner({ scope: 'workspace', cwd: destinationCwd })).manager;
    return this.transferQueue(async () => {
      const files = [...new Set([this.global.store.file, target.store.file])].sort();
      const lock = async (index: number): Promise<{ name: string; mode: string }> => {
        if (index < files.length) return fileLock(files[index], () => lock(index + 1));
        const source = await this.global.read();
        const server = source.find((item) => item.name === name);
        if (!server) throw new Error('Global server no longer exists.');
        const destination = await target.read();
        if (destination.some((item) => item.name === name))
          throw new Error('A workspace MCP with this name already exists. Nothing was changed.');
        const sourceRaw = await readFile(this.global.store.file, 'utf8');
        const targetRaw = await readFile(target.store.file, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        try {
          await atomicWrite(
            target.store.file,
            JSON.stringify({ version: 1, servers: [...destination, server] }, null, 2) + '\n',
          );
          if (mode === 'move')
            await atomicWrite(
              this.global.store.file,
              JSON.stringify(
                { version: 1, servers: source.filter((item) => item.name !== name) },
                null,
                2,
              ) + '\n',
            );
        } catch (error) {
          if (targetRaw === null) await rm(target.store.file, { force: true });
          else await atomicWrite(target.store.file, targetRaw);
          if (mode === 'move') await atomicWrite(this.global.store.file, sourceRaw);
          throw error;
        }
        return { name, mode };
      };
      const result = await lock(0);
      await this.refresh();
      return result;
    });
  }

  test(server: unknown, signal?: AbortSignal) {
    return this.global.test(server, signal);
  }

  dispose() {
    this.closed = true;
    return (this.disposal ??= (async () => {
      await this.global.dispose();
      await this.queue(async () => {
        await Promise.all([...this.workers.values()].map((entry) => entry.worker.dispose()));
        this.workers.clear();
      });
      await Promise.all([...this.owners.values()].map((owner) => owner.dispose()));
    })());
  }
}
