import type {
  Server,
  McpData,
  Store,
  Agent,
  HostContext,
  RuntimeLoader,
  ProbeContext,
  ToolSchema,
  Fiber,
  NativeRuntime,
} from './types.js';
import { join } from 'node:path';
import { JsonStore, serial } from './storage.js';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function strings(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!record(value) || Object.values(value).some((item) => typeof item !== 'string'))
    throw new Error(`${field} must be an object of string values.`);
  return Object.fromEntries(Object.entries(value)) as Record<string, string>;
}
export function normalizeServer(value: unknown, name?: unknown): Server {
  if (!record(value)) throw new Error('Server must be an object.');
  const input = value;
  name ??= input.name;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name))
    throw new Error('Server name must contain 1–32 letters, numbers, underscores or hyphens.');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    throw new Error('enabled must be boolean.');
  const transport = input.transport ?? input.type ?? (input.command ? 'stdio' : 'streamable-http');
  const enabled = input.enabled !== false;
  if (transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command.trim())
      throw new Error('A stdio server requires a command.');
    if (
      input.args !== undefined &&
      (!Array.isArray(input.args) || input.args.some((item) => typeof item !== 'string'))
    )
      throw new Error('args must be an array of strings.');
    if (input.cwd !== undefined && typeof input.cwd !== 'string')
      throw new Error('cwd must be a string.');
    return {
      name,
      transport,
      enabled,
      command: input.command.trim(),
      args: (input.args ?? []) as string[],
      env: strings(input.env, 'env'),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
  }
  if (transport === 'streamable-http' || transport === 'http') {
    let url: URL;
    try {
      url = new URL(String(input.url));
    } catch {
      throw new Error('An HTTP server requires a valid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP(S) URL; put authentication in headers.');
    return {
      name,
      enabled,
      transport: 'streamable-http',
      url: url.href,
      headers: strings(input.headers, 'headers'),
    };
  }
  throw new Error('Supported transports: stdio and streamable-http.');
}
export function parseServers(value: unknown): Server[] {
  const candidate: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const parsed = record(candidate) ? candidate : {};
  let servers: Server[];
  if (record(parsed?.mcpServers))
    servers = Object.entries(parsed.mcpServers).map(([name, server]) =>
      normalizeServer(server, name),
    );
  else if (Array.isArray(parsed?.servers))
    servers = parsed.servers.map((server: unknown) => normalizeServer(server));
  else servers = [normalizeServer(candidate)];
  if (!servers.length) throw new Error('No servers found.');
  if (new Set(servers.map((server) => server.name)).size !== servers.length)
    throw new Error('Duplicate server names.');
  return servers;
}
export function nativeConfig(server: Server) {
  const { name, enabled, ...config } = server;
  return {
    ...config,
    serverName: name,
    toolCallTimeoutMs: 60000,
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  };
}
function describeError(error: unknown) {
  const messages = [];
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return [...new Set(messages)].join(': ');
}

export async function loadNativeRuntime(): Promise<NativeRuntime> {
  // Resolve from Harness's runtime, never install a second copy of core services.
  const [client, { Context }] = await Promise.all([
    import('@deepseek-ai/dsh-mcp-client'),
    import('@deepseek-ai/cordis'),
  ]);
  return { client, Context };
}

interface McpOptions {
  profileDir?: string;
  store?: Store<McpData>;
  scope?: Agent;
  onChange?: () => Promise<unknown>;
  loadRuntime?: RuntimeLoader;
}
interface LiveEntry {
  config: Server;
  fiber: Fiber;
  state: 'starting' | 'active';
}
export class Mcp {
  store: Store<McpData>;
  scope?: Agent;
  onChange?: () => Promise<unknown>;
  loadRuntime: RuntimeLoader;
  live = new Map<string, LiveEntry>();
  errors = new Map<string, string>();
  queue = serial();
  probes = serial();
  probeRoots = new Set<ProbeContext>();
  closed = false;
  disposal?: Promise<void>;
  constructor(
    public ctx: HostContext,
    { profileDir, store, scope, onChange, loadRuntime = loadNativeRuntime }: McpOptions,
  ) {
    this.ctx = ctx;
    this.store =
      store ??
      new JsonStore<McpData>(join(profileDir!, 'skills-mcp-universal.json'), {
        version: 1,
        servers: [],
      });
    this.scope = scope;
    this.onChange = onChange;
    this.loadRuntime = loadRuntime;
  }

  async read() {
    const data = await this.store.read();
    if (data.version !== 1 || !Array.isArray(data.servers))
      throw new Error('Unsupported or corrupt MCP configuration. The file was preserved.');
    const servers = data.servers.map((server) => normalizeServer(server));
    if (new Set(servers.map((item) => item.name)).size !== servers.length)
      throw new Error('Duplicate server names in configuration.');
    return servers;
  }

  async sync(servers: Server[]) {
    if (this.closed) return;
    const { client } = await this.loadRuntime();
    for (const [name, entry] of this.live) {
      const next = servers.find((server) => server.name === name && server.enabled);
      if (!next || JSON.stringify(next) !== JSON.stringify(entry.config)) {
        this.live.delete(name);
        await entry.fiber.dispose();
      }
    }
    for (const config of servers) {
      if (!config.enabled || this.live.has(config.name) || this.closed) continue;
      this.errors.delete(config.name);
      try {
        const fiber = this.ctx.plugin(client, nativeConfig(config));
        const entry: LiveEntry = { config, fiber, state: 'starting' };
        this.live.set(config.name, entry);
        Promise.resolve(fiber).then(
          () => {
            if (this.live.get(config.name) === entry) entry.state = 'active';
          },
          (error) => {
            if (this.live.get(config.name) === entry) {
              this.live.delete(config.name);
              this.errors.set(config.name, describeError(error));
            }
          },
        );
      } catch (error) {
        this.errors.set(config.name, describeError(error));
      }
    }
  }

  start() {
    return this.queue(async () => this.sync(await this.read()));
  }

  publish() {
    return this.onChange ? this.onChange() : this.syncFromStore();
  }

  async syncFromStore() {
    return this.sync(await this.read());
  }

  async list() {
    const servers = await this.read();
    const schemas = this.ctx.tools.schemas(this.scope);
    return servers.map((server) => ({
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      target: server.transport === 'stdio' ? server.command : server.url,
      state: !server.enabled
        ? 'disabled'
        : this.errors.has(server.name)
          ? 'failed'
          : (this.live.get(server.name)?.state ?? 'starting'),
      error: this.errors.get(server.name),
      tools: schemas
        .filter((tool) => tool.name.startsWith(`mcp__${server.name}__`))
        .map((tool) => ({ name: tool.name, description: tool.description })),
    }));
  }

  async get(name: string) {
    const server = (await this.read()).find((item) => item.name === name);
    if (!server) throw new Error('Server not found.');
    return server;
  }

  save(input: unknown, previousName?: string) {
    const server = normalizeServer(input);
    return this.queue(async () => {
      await this.store.update!((data) => {
        if (data.version !== 1 || !Array.isArray(data.servers))
          throw new Error('Corrupt configuration was preserved.');
        if (previousName && !data.servers.some((item) => item.name === previousName))
          throw new Error('Server no longer exists. Refresh the page.');
        if (data.servers.some((item) => item.name === server.name && item.name !== previousName))
          throw new Error('A server with this name already exists.');
        data.servers = data.servers.filter((item) => item.name !== previousName);
        data.servers.push(server);
      });
      await this.publish();
      return { name: server.name };
    });
  }

  import(value: unknown) {
    const imported = parseServers(value);
    return this.queue(async () => {
      await this.store.update!((data) => {
        if (data.version !== 1 || !Array.isArray(data.servers))
          throw new Error('Corrupt configuration was preserved.');
        const duplicate = imported.find((server) =>
          data.servers.some((item) => item.name === server.name),
        );
        if (duplicate)
          throw new Error(`Server ${duplicate.name} already exists. Nothing was imported.`);
        data.servers.push(...imported);
      });
      await this.publish();
      return { count: imported.length };
    });
  }

  toggle(name: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean.');
    return this.queue(async () => {
      await this.store.update!((data) => {
        if (data.version !== 1 || !Array.isArray(data.servers))
          throw new Error('Corrupt configuration was preserved.');
        const server = data.servers.find((item) => item.name === name);
        if (!server) throw new Error('Server not found.');
        server.enabled = enabled;
      });
      await this.publish();
      return { name, enabled };
    });
  }

  batchSet(changes: { name: string; enabled: boolean }[]) {
    return this.queue(async () => {
      await this.store.update!((data) => {
        if (data.version !== 1 || !Array.isArray(data.servers))
          throw new Error('Corrupt configuration was preserved.');
        const servers = data.servers.map((server) => normalizeServer(server));
        for (const change of changes) {
          const server = servers.find((item) => item.name === change.name);
          if (!server) throw new Error('A group member no longer exists. Refresh the page.');
          server.enabled = change.enabled;
        }
        data.servers = servers;
      });
    });
  }

  remove(name: string) {
    return this.queue(async () => {
      await this.store.update!((data) => {
        if (data.version !== 1 || !Array.isArray(data.servers))
          throw new Error('Corrupt configuration was preserved.');
        data.servers = data.servers.filter((item) => item.name !== name);
      });
      await this.publish();
      this.errors.delete(name);
      return { name };
    });
  }

  restart(name: string) {
    return this.queue(async () => {
      const entry = this.live.get(name);
      if (entry) {
        this.live.delete(name);
        await entry.fiber.dispose();
      }
      await this.sync(await this.read());
      return { name };
    });
  }

  test(input: unknown, signal?: AbortSignal) {
    const server = normalizeServer(input);
    return this.probes(async () => {
      if (this.closed) throw new Error('The manager has been unloaded.');
      signal?.throwIfAborted();
      const { Context, client } = await this.loadRuntime();
      if (this.closed) throw new Error('The manager has been unloaded.');
      const probe = new Context();
      this.probeRoots.add(probe);
      const tools = new Map<string, ToolSchema>();
      probe.provide('tools', {
        register(definition) {
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const disposeOnAbort = () => {
        void probe.fiber.dispose().catch(() => {});
      };
      signal?.addEventListener('abort', disposeOnAbort, { once: true });
      try {
        const fiber = probe.plugin(client, {
          ...nativeConfig(server),
          reconnect: { enabled: false },
        });
        await Promise.race([
          Promise.resolve(fiber),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('MCP connection test timed out after 60 seconds.')),
              60000,
            );
          }),
        ]);
        signal?.throwIfAborted();
        return { ok: true as const, tools: [...tools.keys()] };
      } catch (error) {
        return { ok: false as const, error: describeError(error) };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', disposeOnAbort);
        try {
          await probe.fiber.dispose();
        } finally {
          this.probeRoots.delete(probe);
        }
      }
    });
  }

  dispose() {
    this.closed = true;
    return (this.disposal ??= (async () => {
      await Promise.all([...this.probeRoots].map((probe) => probe.fiber.dispose()));
      await this.probes(async () => {});
      await this.queue(async () => {
        const entries = [...this.live.values()];
        this.live.clear();
        await Promise.all(entries.map((entry) => entry.fiber.dispose()));
      });
    })());
  }
}
