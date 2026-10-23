# Foundry MCP Live

An MCP server plus a Foundry VTT module that put a **running** world in front of
an AI client — Claude Desktop, Claude Code, Codex CLI, Gemini CLI, or anything
else that speaks MCP. Actors, compendiums, scenes, combat, chat, console errors
and the live game API, queried while the game is open. No copy-pasted
statblocks, no API keys, no cloud hop: your client ↔ a local server ↔ your
Foundry browser tab.

This wiki covers the three things you configure by hand: **setting it up**,
**the settings themselves**, and **the agent skills** that teach a client how to
use the tools once they are connected.

The [README](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/README.md)
is the quickstart. [server/TOOLS.md](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/server/TOOLS.md)
is the per-tool schema reference.

---

## Start here

1. **[Installation & Setup](Installation-and-Setup)** — the module, the server,
   a client, and how to prove the chain works before you trust it.
2. **[Settings Reference](Settings-Reference)** — every Foundry module setting
   and server environment variable, with its real default and what it changes.
3. **[Skills](Skills)** — the three skills the Claude Code plugin installs, what
   each one is for, and when it loads.
4. **[Hosting & Networking](Hosting-and-Networking)** — the AI stays local;
   Foundry can be local, on the LAN, or hosted on The Forge. Which side dials
   what, and when you need the relay.

---

## How the pieces fit

```
Claude Desktop ─(stdio)─► proxy.mjs ──┐
Claude Code    ────────(HTTP)────────►├──► MCP server        ──(WS:3001)──► Foundry
Codex CLI      ────────(HTTP)────────►│    HTTP:3000/mcp                   browser
Gemini CLI     ────────(HTTP)────────►┘
```

| Piece | Runs where | Job |
|---|---|---|
| MCP server (`server/`) | your machine, Node | Serves `/mcp` on `127.0.0.1:3000` and the Foundry bridge on `ws://127.0.0.1:3001` |
| Foundry module (`module/`) | the Foundry browser tab | Dials the bridge on world load and executes tool calls against `game` |
| Client config | your machine | Points an MCP client at the server, over HTTP or through `proxy.mjs` |

The server must be running **before** the client connects, and the Foundry world
must be open with the module enabled — the module connects on world load, not on
the join screen.

---

## Reference

| Page | What it covers |
|---|---|
| [Settings Reference](Settings-Reference) | Module settings and environment variables, their defaults, and how the two write gates stack |
| [Hosting & Networking](Hosting-and-Networking) | Local, LAN or hosted Foundry (Forge); the loopback rule, the token/origin rule, and the relay |
| [Skills](Skills) | `foundry-live`, `foundry-test`, `foundry-v14`; plugin install and connection variables |
| [Tool reference](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/server/TOOLS.md) | Every tool, its `action` values and its arguments |
| [Security model](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/SECURITY.md) | Threat model, why `evaluate` is on by default, token auth, residual risks |
| [Agent setup](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/AGENTS.md) | The first-message protocol, multi-GM routing, mutation caution |
| [Error catalogue](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/docs/errors.md) | `FML-####` codes: what happened, why, and the fix |
| [Debugging recipes](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/docs/debugging-recipes.md) | Tracing hooks, effects, workflows and module behaviour in a live world |
| [Updating the server](https://github.com/DimitroffVodka/foundry-mcp-live/blob/main/docs/updating-the-server.md) | What hot-reloads, what needs a restart, and the failure symptoms |

---

## Two things worth knowing up front

**Writes are gated twice, and the server gate starts closed.** World-authoring
tools are not registered unless the server has `FOUNDRY_MCP_ALLOW_WRITE=1`, and
even then the world setting **Allow AI to modify the world** can refuse them
without a restart. A missing write tool is a configuration answer, not a bug —
see [Settings Reference](Settings-Reference).

**`evaluate` is on by default.** Both ports bind to loopback and the client is
one you configured, so arbitrary JS in your own Foundry tab was judged worth more
than the friction of an opt-in. Set `FOUNDRY_MCP_ALLOW_EVAL=0` to drop it. That
is separate from the relay's own **Allow `evaluate` over the relay** setting,
which is off and stays off unless a GM turns it on in the world.
