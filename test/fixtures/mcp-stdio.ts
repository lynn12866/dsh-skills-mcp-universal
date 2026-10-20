// A real JSON-RPC MCP server for transport tests. No external dependencies or model calls.
import { appendFileSync } from 'node:fs';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line) as {
      id?: number | string;
      method: string;
      params: { protocolVersion: string; arguments: { message: string } };
    };
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize')
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'universal-fixture', version: '1.0.0' },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'echo',
            description: 'Echo a message',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
              additionalProperties: false,
            },
          },
        ],
      };
    else if (message.method === 'tools/call') {
      if (process.env.CALL_LOG)
        appendFileSync(process.env.CALL_LOG, JSON.stringify(message.params) + '\n');
      result = { content: [{ type: 'text', text: message.params.arguments.message }] };
    } else result = {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  }
});
