#!/usr/bin/env node

import { JoplinServer, determineReadOnly } from './index.js';

const isReadOnly = determineReadOnly(process.argv, process.env);

const server = new JoplinServer({ readOnly: isReadOnly });

server.run().catch((error) => {
  console.error('[Fatal] Failed to start Joplin MCP server:', error);
  process.exit(1);
});
