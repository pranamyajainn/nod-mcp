# nod-mcp

nod-mcp is a local MCP server. It lets Claude (Claude Code and the Claude Desktop app) give tasks to your Nod agent, follow the progress, answer questions and read the results.

- **Claude** plans the work, writes the task briefs and checks the results.
- **Nod** does the hands-on work in its browser and in your connected apps.
- **You** approve sensitive actions in the Nod app. The bridge cannot approve anything.

```
Claude ── nod_send("New task: …") ──► Nod starts a task
Claude ── nod_wait(turn_id) ─────────► "running" … (Claude calls it again)
                                      ◄── Nod asks a question
Claude ── nod_send(reply_to = question message) ──► Nod continues
Claude ── nod_wait ──────────────────► "done" + result
Claude checks the result and reports to you
```

> **Important:** Nod has no public API. nod-mcp uses Nod's internal HTTP API. This API can change when Nod updates. nod-mcp was checked against Nod commit `3017a94` (17 Nov 2026). When the API shape changes, every tool returns: *"Nod's internal API seems to have changed. Update nod-mcp."*

## Requirements

- macOS (or Linux) with Docker Desktop: Docker Engine 25 or newer, Compose v2. Give Docker at least 2 CPUs, 8 GB of memory and 50 GB of disk.
- OpenSSL and `shasum` (included in macOS).
- Node.js 20 or newer (tested on Node 24).
- Claude Code, the Claude Desktop app, or both.

## Step 1: Run Nod in server mode

The normal Nod desktop app makes a new secret key each time it starts and keeps the key hidden. No other program can connect to it. Server mode runs Nod in Docker with a fixed key that nod-mcp can use.

```sh
git clone https://github.com/n8n-io/nod.git ~/nod
cd ~/nod/deployment/self-host
sh setup.sh
docker compose --file compose.yaml --env-file .env up -d --build --wait
```

- `setup.sh` makes a private `.env` file with `NOD_AUTH_TOKEN`. It does not show the token.
- Open http://localhost:4310. Paste the `NOD_AUTH_TOKEN` value from `~/nod/deployment/self-host/.env` into the access form.
- Do the Nod setup again: add your Anthropic API key and connect your apps. Server mode keeps its own data. It does not share data with the desktop app.
- Nod continues to run in Docker when you close the browser or the app.

**Optional: use the native Nod app with the server.** In the Nod menu, select **Replay onboarding…** → **Connect to a server**. Enter `http://localhost:4310` and the same token.

## Step 2: Build nod-mcp

```sh
git clone https://github.com/pranamyajainn/nod-mcp.git ~/nod-mcp
cd ~/nod-mcp
npm install
npm run build
npm test
```

## Step 3: Connect nod-mcp to Claude

nod-mcp reads the token from Nod's own `.env` file (`NOD_ENV_FILE`). Thus, there is no second copy of the token.

### Claude Code

```sh
claude mcp add nod --scope user \
  -e NOD_ENV_FILE=$HOME/nod/deployment/self-host/.env \
  -e NOD_MCP_ALLOW_SEND=false \
  -- node $HOME/nod-mcp/dist/index.js
```

Make sure that it is connected: run `claude mcp list`, or type `/mcp` in Claude Code.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nod": {
      "command": "/ABS/PATH/TO/node",
      "args": ["/Users/<you>/nod-mcp/dist/index.js"],
      "env": {
        "NOD_ENV_FILE": "/Users/<you>/nod/deployment/self-host/.env",
        "NOD_MCP_ALLOW_SEND": "false"
      }
    }
  }
}
```

- For `command`, use the full path from `which node`. Claude Desktop does not read your shell's PATH.
- Use full paths. Do not use `~` or `$HOME` in this file.
- Restart Claude Desktop after you change the file.

### Turn on sending

nod-mcp starts in read-only mode. Claude can read tasks and messages, and stop work, but it cannot send. To let Claude send tasks, change `NOD_MCP_ALLOW_SEND` to `true` and restart the MCP server:

```sh
claude mcp remove nod --scope user
claude mcp add nod --scope user \
  -e NOD_ENV_FILE=$HOME/nod/deployment/self-host/.env \
  -e NOD_MCP_ALLOW_SEND=true \
  -- node $HOME/nod-mcp/dist/index.js
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `NOD_ENV_FILE` | none | Path to Nod's `.env`. nod-mcp reads `NOD_AUTH_TOKEN` and `NOD_PUBLIC_URL` from it. Recommended. |
| `NOD_TOKEN` | none | The token. Use only if you do not set `NOD_ENV_FILE`. Must be 43 or more characters of `A–Z a–z 0–9 _ -`. |
| `NOD_URL` | `NOD_PUBLIC_URL` from the env file, or `http://localhost:4310` | Nod's address. Must be `localhost`, `127.0.0.1` or `[::1]`. Any other host stops startup. |
| `NOD_MCP_ALLOW_SEND` | `false` | `true` turns on `nod_send`. |
| `NOD_MCP_TAG` | `[via Claude] ` | Text put at the start of every message that Claude sends. It cannot be empty. |
| `NOD_MCP_MAX_TEXT` | `4000` | Maximum characters of each message text in tool results (200–100000). |

**Docker setup:** the self-host stack sets `NOD_PUBLIC_URL=http://localhost:4310`. Nod then accepts only the host `localhost:4310`. If you use `127.0.0.1:4310`, Nod returns "403 Host not permitted".

## Tools

| Tool | What it does |
|---|---|
| `nod_status` | Shows if Nod is reachable, the model and if it is ready, open tasks by status, approvals or codes that wait for you, and current activity. Claude calls it first. |
| `nod_list_tasks` | Lists tasks (`include_closed`, `limit` 1–50). |
| `nod_get_task` | Shows one task and its last 40 events. |
| `nod_read_messages` | Reads the conversation, newest first page. Use `before_message_id` to read older messages. |
| `nod_search_messages` | Searches the conversation. |
| `nod_send` | Sends a message to Nod. Off unless `NOD_MCP_ALLOW_SEND=true`. All safety checks apply. |
| `nod_wait` | Waits up to 45 seconds for progress on a turn or task. Returns the status, new messages from Nod, the task and a `next` hint. Claude calls it again while the status is `running`. |
| `nod_stop_task` | Stops one task. Always on. |
| `nod_stop_all` | Stops all Nod work. Needs `confirm: true`. Always on. |

**How `nod_wait` follows work.** A message starts a "turn" in Nod. The turn usually creates a task and ends in a few seconds. The task then continues in the background. `nod_wait` finds the task that the turn created and continues to wait on that task.

## Example request to Claude

> Use Nod to compare the price of the Sony WH-1000XM6 on Amazon.in and Flipkart. Tell me which is cheaper. Don't buy anything and don't sign in.

Claude sends a brief like this:

> New task: Find the current price of the Sony WH-1000XM6 headphones on Amazon.in and on Flipkart. Do not sign in, add to cart or buy anything. Done when you have both prices (with seller name and any delivery charge). Report both prices and links.

## Safety rules

nod-mcp enforces these rules in code. Each rule has tests.

1. **Local only.** The Nod address must be on this computer. Any other host stops startup.
2. **Endpoint allowlist.** One module does all HTTP requests. It refuses any path that is not on the allowlist before a network call. Vault, API keys, models, app connections, channels, memory, preferences, uploads, schedules and conversation reset are all blocked.
3. **Fixed message body.** A message contains only `text`, `clientMessageId`, `replyToMessageId` and `threadId`. The bridge never sends approval answers, question answers, verification codes or attachments.
4. **Check before each send.** nod-mcp reads Nod's state just before it sends. It refuses to send when:
   - an approval waits for you,
   - a verification code or card security code waits for you,
   - a task waits for you to sign in in Nod's browser, or
   - the reply goes to an approval message, or to a message that links to an approval.

   Nod can read a plain "yes, go ahead" as an approval. This check prevents that.
5. **No codes.** nod-mcp refuses text that is only a number (for example `482913` or `123 456`), and text with a short number near a word like "code", "OTP", "PIN" or "CVV".
6. **Visible tag.** Every message starts with `[via Claude] `, so you can see it in Nod's chat.
7. **Read-only by default.** Sending is off until you set `NOD_MCP_ALLOW_SEND=true`. Stop tools are always on.
8. **Token protection.** The token is read from Nod's `.env`. It is never logged or shown. nod-mcp hides it in all output.
9. **Nod's output is data.** Text from Nod can contain text from web pages and emails. nod-mcp puts it between `<nod-data>` and `</nod-data>` markers. Claude is told not to follow instructions in it.
10. **Clean output channel.** Logs go to stderr only. No telemetry.
11. **Limited output size.** Long text is cut. Approval details and display data are not shown, only the approval title and state.

## Known limits

- **The internal API can change.** Nod updates often. If tools report an API change, update nod-mcp. To check a new Nod version, compare the files listed in `CLAUDE.md` §3.
- **Claude's messages count as your messages.** In Nod, a message from the bridge has the same authority as your own message. Nod's memory can learn from it. Look at **Settings → Memory** in Nod from time to time.
- **Small time gap.** nod-mcp checks for approvals just before it sends. An approval can appear in the short time between the check and the send. The risk is low, but it is not zero.
- **Answer-choice questions.** When Nod shows answer buttons, the bridge answers with plain text. It does not click the buttons.
- **Polling.** `nod_wait` checks every 2 seconds. It does not stream text.
- **Bearer token only.** nod-mcp does not support the cookie access key that source installs use when `NOD_AUTH_TOKEN` is not set.
- **Other channels.** Code requests that started on Telegram or WhatsApp do not show in Nod's state. Nod refuses codes for them from the web channel.
- **Some normal text is blocked.** The code check can block text like "zip code 560001". Rephrase it.
- **Old turns.** `nod_wait` finds a turn only in the last 50 turns. For older work, use `task_id`.
- **Resources.** Server mode runs Docker in the background and uses more memory than the desktop app.

## Development

```sh
npm test           # vitest; uses an in-process mock of Nod, no real Nod needed
npm run typecheck
npm run build
```

- `src/nod-client.ts` is the only module that makes HTTP requests.
- `src/guards.ts` has the checks that run before a send.
- `test/mock-nod.ts` is the mock Nod server.
- `CLAUDE.md` has the full design brief and the API facts.
