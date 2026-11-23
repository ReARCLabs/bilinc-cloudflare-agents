# Bilinc agent for Cloudflare

A chat agent built on Cloudflare's [Think](https://www.npmjs.com/package/@cloudflare/think) whose long-term memory is [Bilinc](https://bilinc.space/?utm_source=cloudflare&utm_medium=template&utm_campaign=bilinc-cloudflare-agents): versioned memory with history, checkpoints, diff and rollback. It uses the [`bilinc-cloudflare-agents`](https://www.npmjs.com/package/bilinc-cloudflare-agents) package.

Not affiliated with or endorsed by Cloudflare.

## Deploy

Deploying asks for two secrets:

- `BILINC_API_KEY`: Bilinc is free forever, with no card and 2,000 credits a month. Create a **dedicated Bilinc account** for this agent, never your main one: [sign up and create a key](https://bilinc.space/signup?next=/api-keys&utm_source=cloudflare&utm_medium=deploy&utm_campaign=bilinc-cloudflare-agents).
- `APP_ACCESS_TOKEN`: a passphrase you choose, at least 16 characters. Anyone who knows it can use this agent and its Bilinc key. Spaces or line breaks at either end are ignored, both in the secret and in what you type on the unlock screen, and do not count toward the 16.

The app shows an unlock screen first. After unlocking, the session lasts 7 days. Changing `APP_ACCESS_TOKEN` is the only way to end every session. Five wrong passphrases from one IP block that IP for up to 10 minutes (IPv6 addresses count per /64 network).

## Run locally

Local development needs a Cloudflare login (`npx wrangler login`), because Workers AI always runs on Cloudflare.

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in both values
npm run dev
```

## How it works

- **One chat is one Durable Object.** Its id is the `#chat=<uuid>` part of the URL, so reloading or bookmarking returns to the same chat. Opening the bare URL returns to the last chat in this browser. **New chat** starts a fresh one. There is no list of past chats.
- **Memory is shared by every chat** of the deployment. Entries are stored under `cf.<BILINC_NAMESPACE>.` in your Bilinc project.
- **Tools.** The model sees nine tools: `search_context` and `set_context` (read and save memory) and seven Bilinc tools: `bilinc_checkpoint`, `bilinc_checkpoints`, `bilinc_diff`, `bilinc_history`, `bilinc_forget`, `bilinc_rollback_preview` and `bilinc_rollback`. Forget and rollback run only after you click **Approve**. **Reject** takes an optional reason, which the agent sees before it answers. Rollback always shows a preview first.
- **Automatic checkpoint.** Every new chat creates one checkpoint labelled `auto: chat start <date>` in the background, so an overwrite can be rolled back. It costs 2 credits per new chat and may finish a few seconds after the chat opens. If Bilinc did not answer clearly, the chat may have no automatic checkpoint; ask the agent to "checkpoint now" to create one.
- **Think's workspace file tools are hidden.** The allowlist in `src/constants.ts` (`ACTIVE_TOOLS`) controls what the model can call. If you add `write`, `edit` or `delete` to it, they run without approval.

## Configuration

Set in `wrangler.jsonc` under `vars`:

| Var | Default | Notes |
|---|---|---|
| `MODEL` | `@cf/zai-org/glm-4.7-flash` | Any Workers AI model with function calling. Fallbacks: `@cf/meta/llama-4-scout-17b-16e-instruct`, `@cf/openai/gpt-oss-120b`. |
| `BILINC_NAMESPACE` | `default` | 1–64 letters, digits, `_` or `-`. Changing it starts from an empty memory: entries under the old namespace stay in Bilinc but the agent no longer sees them. An invalid value stops the chat. |
| `AUTO_CHECKPOINT` | `true` | `"false"` turns the automatic checkpoint off. Then an overwrite made before a manual checkpoint cannot be rolled back. |

## Credits and limits

- Bilinc credits: search 1, save 1, forget 1, checkpoint 2, rollback 2. Listing checkpoints, history, diff and the rollback preview are free. The free plan has 2,000 credits a month.
- Workers AI gives 10,000 neurons a day for free ([Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)).
- Each chat may make at most 20 billable Bilinc calls a minute.

## Single-tenant only

One deployment serves one person or one team that trusts each other, on one dedicated Bilinc account. Search, checkpoints and rollback cover the whole Bilinc project, and everyone with the passphrase can open any chat whose link they have.

## Tests

Tests need Node.js 24 or later.

```sh
npm test
```

The tests use an in-memory Bilinc and a scripted model, so they need no keys and spend no credits or neurons.

## License

MIT, ReARC Labs Inc.
