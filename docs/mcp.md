# Recommended MCP servers

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers give an AI coding
assistant live access to documentation and tools. This page comes from the EPICS Nuxt
template. Nothing in the app depends on it: it only helps when you work on this repository
with such an assistant. The three servers below cover the frameworks the app is built on.

| Server          | URL                                                          | What it is for               |
| --------------- | ------------------------------------------------------------ | ---------------------------- |
| **Nuxt**        | `https://nuxt.com/mcp`                                       | Nuxt framework docs and APIs |
| **Nuxt UI**     | `https://ui.nuxt.com/mcp`                                    | Nuxt UI component docs       |
| **Better Auth** | `https://mcp.chonkie.ai/better-auth/better-auth-builder/mcp` | Better Auth docs and setup   |

All three are remote (HTTP) servers: there is nothing to install, each tool only needs the
URL.

**Checked on 2026-11-19:** the Nuxt and the Nuxt UI server answered. The Better Auth server
did not pass its TLS check (its certificate was reported as expired). Check a URL before you
add it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://nuxt.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}'
```

`200` means the server answers. A TLS error means: do not use it until it is fixed. Better
Auth's own documentation is at <https://www.better-auth.com/docs>, and
[better_auth.md](better_auth.md) describes how this app uses it.

## Why this is a page and not a committed config file

There is no single MCP config file that every tool reads. Each assistant has its own config
path, and the format is almost, but not quite, the same across them. Rather than commit one
file per tool, the servers are listed here so you can add them to whatever you use. (A
[universal config standard](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2218)
has been proposed but is not adopted yet.)

## Add them to your tool

Most tools use a `mcpServers` object; VS Code is the exception (it uses `servers`). The
field for a remote server also varies slightly by tool. Add only the servers you want. The
snippets come from the template and were not tried again for this repository: if one does
not work, the tool's own documentation wins.

### Claude Code: `.mcp.json` (project root) or `~/.claude.json` (user)

```json
{
  "mcpServers": {
    "nuxt": { "type": "http", "url": "https://nuxt.com/mcp" },
    "nuxt-ui": { "type": "http", "url": "https://ui.nuxt.com/mcp" },
    "better-auth": {
      "type": "http",
      "url": "https://mcp.chonkie.ai/better-auth/better-auth-builder/mcp"
    }
  }
}
```

Or with the command line:

```bash
claude mcp add --transport http nuxt https://nuxt.com/mcp
claude mcp add --transport http nuxt-ui https://ui.nuxt.com/mcp
claude mcp add --transport http better-auth https://mcp.chonkie.ai/better-auth/better-auth-builder/mcp
```

### Cursor: `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

```json
{
  "mcpServers": {
    "nuxt": { "url": "https://nuxt.com/mcp" },
    "nuxt-ui": { "url": "https://ui.nuxt.com/mcp" },
    "better-auth": { "url": "https://mcp.chonkie.ai/better-auth/better-auth-builder/mcp" }
  }
}
```

### VS Code (Copilot): `.vscode/mcp.json` (the root key is `servers`)

```json
{
  "servers": {
    "nuxt": { "type": "http", "url": "https://nuxt.com/mcp" },
    "nuxt-ui": { "type": "http", "url": "https://ui.nuxt.com/mcp" },
    "better-auth": {
      "type": "http",
      "url": "https://mcp.chonkie.ai/better-auth/better-auth-builder/mcp"
    }
  }
}
```

### Gemini CLI: `.gemini/settings.json` (uses `httpUrl`)

```json
{
  "mcpServers": {
    "nuxt": { "httpUrl": "https://nuxt.com/mcp" },
    "nuxt-ui": { "httpUrl": "https://ui.nuxt.com/mcp" },
    "better-auth": { "httpUrl": "https://mcp.chonkie.ai/better-auth/better-auth-builder/mcp" }
  }
}
```

Another assistant (Windsurf, Zed, Continue, Claude Desktop and others) almost certainly
supports MCP too. Check its documentation for the config path; the server URLs are the same.

## Notes

- These are third-party services. They receive the questions your assistant sends them.
  **Never put call data, a database, a connection string or anything else from the line
  into a prompt**, with or without these servers.
- Tool-specific MCP config files are not committed to this repository. Add them locally,
  and add them to `.gitignore` if your tool writes them into the project folder.
