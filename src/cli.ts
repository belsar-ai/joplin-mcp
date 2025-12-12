#!/usr/bin/env node

import { JoplinServer } from './index.js';

// Use the static async factory method to create the server
JoplinServer.create()
  .then((server) => {
    return server.run();
  })
  .catch((error) => {
    console.error('[Fatal] Failed to start Joplin MCP server:', error);
    process.exit(1);
  });