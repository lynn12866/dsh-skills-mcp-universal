import type { HostContext, NativeRuntime, ProbeContext, Fiber } from '../src/types.js';

export function host(overrides: Partial<HostContext> = {}): HostContext {
  return {
    profileContext: { name: 'test', home: '', dir: '' },
    agents: { list: () => [] },
    tools: { schemas: () => [] },
    connection: { fetch: { register: () => () => {} } },
    logger: { error() {}, warn() {} },
    effect() {},
    on() {},
    plugin() {
      throw new Error('Unexpected native connection in test.');
    },
    ...overrides,
  };
}
export class DummyContext implements ProbeContext {
  fiber = { dispose: async () => {} };
  provide() {}
  plugin(): Fiber {
    throw new Error('Unexpected probe in test.');
  }
}
export const runtime = async (): Promise<NativeRuntime> => ({ client: {}, Context: DummyContext });
