/**
 * The eidet MCP server: create and edit decks and cards. See DESIGN.md §6.
 *
 * Speaks MCP over stdio, and eidet's own sync protocol over HTTP to the server
 * at `EIDET_URL` — the deployed instance by default. stdout is the MCP channel,
 * so anything meant for a human goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { EidetClient } from './client.ts'
import { registerTools } from './tools.ts'

const url = process.env.EIDET_URL ?? 'http://127.0.0.1:8091'
const server = new McpServer({ name: 'eidet', version: '0.1.0' })
registerTools(server, new EidetClient(url))
await server.connect(new StdioServerTransport())
console.error(`eidet mcp: syncing with ${url}`)
