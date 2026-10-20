export type Scope = 'global' | 'workspace';
export interface ScopeOptions {
  scope?: Scope;
  cwd?: string;
}
export interface SkillRoot {
  path: string;
  source: string;
  scope?: Scope;
  workspace?: string | null;
}
export interface SkillItem {
  name: string;
  path: string;
  description?: string;
  content?: string;
  whenToUse?: string;
  modelEnabled?: boolean;
  userEnabled?: boolean;
  source: string;
  scope?: Scope;
  workspace?: string | null;
  writable: boolean;
  error?: string;
  kind?: 'bundle' | 'file';
}
export interface ScannedSkill {
  name: string;
  path: string;
  sourcePath: string;
  kind: 'bundle' | 'file';
  description?: string;
}
export interface ScanResult {
  token: string;
  items: ScannedSkill[];
}
export interface ImportResult {
  name: string;
  ok: boolean;
  path?: string;
  error?: string;
}
export interface SkillImportPayload {
  token: string;
  paths: string[];
  scope?: 'user' | 'project';
  cwd?: string;
}
export type Server = { name: string; enabled: boolean } & (
  | {
      transport: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | { transport: 'streamable-http'; url: string; headers: Record<string, string> }
);
export interface McpData {
  version: number;
  servers: Server[];
}
export interface Store<T> {
  file: string;
  read(): Promise<T>;
  update?<R>(fn: (data: T) => R | Promise<R>): Promise<R>;
}
export type ScopedServer = Server & { scope: Scope; workspace: string | null };
export interface ToolSchema {
  name: string;
  description?: string;
}
export interface ServerSummary {
  name: string;
  scope: Scope;
  workspace: string | null;
  enabled: boolean;
  overridden: boolean;
  transport: Server['transport'];
  target: string;
  state: string;
  error?: string;
  tools: ToolSchema[];
}
export interface Fiber extends PromiseLike<unknown> {
  dispose(): Promise<unknown>;
}
export interface Agent {
  session?: { header?: { cwd?: string } };
  ctx: HostContext;
}
export interface HostContext {
  profileContext: { name: string; home: string; dir: string; cwd?: string };
  agents: { list(): Agent[] };
  tools: { schemas(scope?: Agent): ToolSchema[] };
  connection: { fetch: { register(route: unknown): () => void } };
  logger: { error(message: string): void; warn?(message: string): void };
  plugin(plugin: unknown, config: unknown): Fiber;
  effect(setup: () => (() => unknown) | void, label?: string): void;
  on(event: string, listener: (payload: { agent: Agent }) => unknown): void;
}
export interface ProbeContext {
  fiber: { dispose(): Promise<unknown> };
  provide(name: string, value: { register(definition: ToolSchema): () => boolean }): void;
  plugin(plugin: unknown, config: unknown): Fiber;
}
export interface NativeRuntime {
  client: unknown;
  Context: new () => ProbeContext;
}
export type RuntimeLoader = () => Promise<NativeRuntime>;
export type Member = { kind: 'skill'; path: string } | { kind: 'mcp'; name: string };
export interface Group {
  id: string;
  name: string;
  members: Member[];
}
export type GroupMember =
  { kind: 'skill'; path: string } | { kind: 'mcp'; name: string; cwd?: string };
export interface ManagedGroup {
  id: string;
  name: string;
  members: GroupMember[];
  workspaces: string[];
  enabled: boolean;
}
export interface ManagedGroupSummary extends ManagedGroup {
  missing: number;
}
export interface GroupState {
  version: 1;
  groups: ManagedGroup[];
  workspaces: string[];
  migrated: string[];
  copies: { path: string; source: string }[];
}
export interface GroupData {
  version: number;
  groups: Group[];
}
export interface GroupSummary extends Group {
  state: 'enabled' | 'disabled' | 'mixed';
  missing: number;
}
export interface DirectoryResult {
  path: string;
  parent: string;
  name: string;
  entries: { name: string; path: string }[];
}
export interface Info {
  profile: string;
  home: string;
  workspace?: string;
  storage: string;
}

export interface SceneRef {
  id: string;
  scope: Scope;
  cwd?: string;
}
export interface SceneAssignment extends SceneRef {
  workspaces: string[];
}
export interface SceneAssignmentData {
  version: number;
  entries: SceneAssignment[];
}
export interface SceneTarget {
  cwd: string;
  state: 'enabled' | 'disabled' | 'mixed' | 'pending';
  error?: string;
}
export interface SceneSummary extends GroupSummary {
  key: string;
  source: SceneRef;
  targets: SceneTarget[];
}
export interface SceneCatalog {
  items: SceneSummary[];
  errors: string[];
}
