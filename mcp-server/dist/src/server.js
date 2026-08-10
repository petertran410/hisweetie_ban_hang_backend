import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/register.js';
export function createMcpServer() {
    const server = new McpServer({ name: 'hisweetie-pos-mcp-server', version: '0.1.0' });
    registerTools(server);
    return server;
}
//# sourceMappingURL=server.js.map