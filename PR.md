### Overview
This PR refactors the Joplin MCP server to use a single, powerful `execute_joplin_script` tool, moving away from numerous granular tools.

### Key Benefits
-   **Enhanced Flexibility:** Enables complex, agentic workflows through direct JavaScript/TypeScript interaction with the Joplin API.
-   **Improved Efficiency:** Reduces API call overhead and allows multi-step operations within a single tool execution.
-   **Simplified Interface:** Consolidates all Joplin operations under one scriptable entry point.

### Changes
-   Introduced `src/mcp/script-executor.ts` for secure VM execution.
-   Updated `src/index.ts` to expose only `execute_joplin_script`.
-   Revised `README.md` to document the new architecture and available script API.
-   Addressed minor fixes and cleaned up unused dependencies.
