#!/usr/bin/env node
import "../src/shared/quiet.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLarkitServer } from "../src/mcp/server.js";

const server = createLarkitServer();
const transport = new StdioServerTransport();
await server.connect(transport);
