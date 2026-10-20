declare module '@deepseek-ai/dsh-mcp-client' {
  const client: unknown;
  export = client;
}
declare module '@deepseek-ai/cordis' {
  export const Context: import('./types.js').NativeRuntime['Context'];
}
