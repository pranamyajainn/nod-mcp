# nod-mcp build kit

This kit lets Claude Code build **nod-mcp**, a local bridge that lets Claude (Claude Code or the Claude Desktop app) give tasks to your **Nod** agent, follow their progress and read the results. Claude plans and checks the work, Nod does the clicking, and you approve anything sensitive in the Nod app.

| File | What it's for |
|---|---|
| `CLAUDE.md` | The full brief for Claude Code: research, Nod's internal API (checked against Nod's source), safety rules, tools and tests. Claude Code reads it automatically. |
| `KICKOFF_PROMPT.md` | The prompt to paste into Claude Code. It builds the bridge in phases and asks you before anything risky. |
| `README.md` | This file. |

## Before you start

**1. Nod has to run in "server mode."** The normal Nod desktop app makes a new secret key every time it starts and keeps it hidden, so no other program can connect to it. Server mode runs Nod in Docker on your Mac with a fixed key that the bridge can use.

You need **Docker Desktop** with at least 2 CPUs, 8 GB of memory and 50 GB of free disk. Then run:

```sh
git clone https://github.com/n8n-io/nod.git ~/nod
cd ~/nod/deployment/self-host
sh setup.sh                       # creates a private .env with your server token (it isn't printed)
docker compose up -d --build --wait
```

Open http://localhost:4310 and paste the `NOD_AUTH_TOKEN` value from `~/nod/deployment/self-host/.env` into the access form. Then go through setup again: add your Anthropic API key and reconnect your apps. Server mode keeps its own data, separate from the desktop app.

*Optional:* to keep using the native app, choose Nod menu → **Replay onboarding…** → **Connect to a server**, enter `http://localhost:4310` and paste the same token.

**2. Claude Code** must be installed.

## Build it

```sh
unzip nod-mcp.zip -d ~
cd ~/nod-mcp && claude
```

Then paste this into Claude Code:

> Read CLAUDE.md and KICKOFF_PROMPT.md in this folder completely, then follow KICKOFF_PROMPT.md phase by phase, starting with Phase 0. Ask me before running Docker, turning on sending, or sending any real message to Nod.

Claude Code will:

0. Re-check Nod's code to make sure nothing changed.
1. Build a read-only bridge.
2. Add sending and waiting, with safety checks.
3. Register the bridge and test it with you.

It will ask you before running Docker, turning on sending, or sending a real task.

## Using it afterwards

Example request to Claude:

> "Use Nod to compare the prices of the Sony WH-1000XM6 on Amazon.in and Flipkart and tell me which is cheaper. Don't buy anything."

Claude sends Nod a clear task brief, waits, answers Nod's questions when your instructions already cover them, and reports the result back to you.

## Safety features

- **Read-only to start.** Sending stays off until you set `NOD_MCP_ALLOW_SEND=true`.
- **Approvals stay with you.** The bridge can never click Approve, and it won't send anything while an approval, sign-in or code is waiting for you in Nod.
- **Messages are labeled.** Every message from Claude starts with `[via Claude]`, so you can see it in Nod's chat.
- **Your secrets stay out of reach.** The bridge never touches your Vault, API keys or app settings, and it only connects to `localhost`.
- **Your token isn't copied.** It's read from Nod's own `.env` file and never shown.

## Things to know

- **The bridge can break when Nod updates.** It uses Nod's internal API, which isn't documented, and Nod updates often. The bridge checks the API at startup and tells you if it changed.
- **To Nod, Claude's messages count as your messages.** Nod's memory may learn from them, so check **Settings → Memory** sometimes.
- **Server mode uses more resources** than the desktop app, because it runs Docker in the background.
