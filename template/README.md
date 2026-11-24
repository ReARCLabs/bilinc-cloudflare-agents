# Bilinc agent for Cloudflare

A chat agent built on Cloudflare's [Think](https://www.npmjs.com/package/@cloudflare/think) whose long-term memory is [Bilinc](https://bilinc.space/?utm_source=cloudflare&utm_medium=template&utm_campaign=bilinc-cloudflare-agents): versioned memory with history, checkpoints, diff and rollback. It uses the [`bilinc-cloudflare-agents`](https://www.npmjs.com/package/bilinc-cloudflare-agents) package.

Not affiliated with or endorsed by Cloudflare.

## Deploy

Deploying asks for two secrets:

- `BILINC_API_KEY`: Bilinc is free forever, with no card and 2,000 credits a month. Create a **dedicated Bilinc account** for this agent, never your main one: [sign up and create a key](https://bilinc.space/signup?next=/api-keys&utm_source=cloudflare&utm_medium=deploy&utm_campaign=bilinc-cloudflare-agents).
- `APP_ACCESS_TOKEN`: a passphrase you choose, at least 16 characters. Anyone who knows it can use this agent and its Bilinc key. Spaces or line breaks at either end are ignored, both in the secret and in what you type on the unlock screen, and do not count toward the 16.

The app shows an unlock screen first. After unlocking, the session lasts 7 days. Changing `APP_ACCESS_TOKEN` is the only way to end every session, and only a change to its trimmed value counts: adding or removing whitespace at either end ends none. Five wrong passphrases from one IP block that IP for up to 10 minutes (IPv6 addresses count per /64 network).

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
- **Tools.** The model sees nine tools: `search_context` and `set_context` (read and save memory) and seven Bilinc tools: `bilinc_checkpoint`, `bilinc_checkpoints`, `bilinc_diff`, `bilinc_history`, `bilinc_forget`, `bilinc_rollback_preview` and `bilinc_rollback`. Each tool call shows as a step in the chat. Forget and rollback stop at a step that asks you: click **Forget** or **Roll back** to run them, or **Reject**, with an optional reason that the agent sees before it answers. Rollback always shows a preview first.
- **Model selector.** The model menu in the message box lists the models in `MODELS`. Your choice, and the reasoning effort for models that take one, is stored with the next message you send and kept for that chat; a pick you have not sent yet is gone after a reload. An approval continues on the model the turn started with. The Worker checks both against `MODELS` on every turn and runs `MODEL` for anything else.
- **History.** The History button lists the newest 20 checkpoints and the current number of entries (free reads through `GET /api/checkpoints`). Picking one fills the message box with a diff request; nothing is sent until you press **Ask**.
- **Memory menu.** Type `/` in an empty message box, or click **Memory**, to pick Remember, Recall, Checkpoint, Compare or Roll back. It only fills the message box.
- **Automatic checkpoint.** Every new chat creates one checkpoint labelled `auto: chat start <date>` in the background, so an overwrite can be rolled back. It costs 2 credits per new chat and may finish a few seconds after the chat opens. If Bilinc did not answer clearly, the chat may have no automatic checkpoint; ask the agent to "checkpoint now" to create one.
- **Think's workspace file tools are hidden.** The allowlist in `src/constants.ts` (`ACTIVE_TOOLS`) controls what the model can call. If you add `write`, `edit` or `delete` to it, they run without approval.

## Configuration

Set in `wrangler.jsonc` under `vars`:

| Var | Default | Notes |
|---|---|---|
| `MODEL` | `@cf/openai/gpt-oss-120b` | The default model, and the one that runs for any choice outside `MODELS`. List it in `MODELS` to give it a label and reasoning levels. When `MODEL` is missing from `MODELS`, it is added first, with no reasoning control. |
| `MODELS` | `gpt-oss-120b` | The models the selector offers: a JSON array of `{ "id", "label", "note", "tag", "effort" }`. `id` must be a Workers AI id (`@cf/<author>/<model>`); other entries are ignored. `label`, `note` and `tag` are optional; `tag` is a short badge next to the model, and a model without one shows none. `effort` lists the reasoning levels a model takes (`["low", "medium", "high"]` for the gpt-oss models) or is `null`. Only `@cf/openai/gpt-oss-120b` passed the tool-calling test of the 0.1.1 gate (2026-11-24). `@cf/openai/gpt-oss-20b` is not listed: it called a malformed tool name and skipped the search and forget calls at the 0.1.1 gate. `@cf/meta/llama-4-scout-17b-16e-instruct` is not listed: it sent invalid input to `set_context` and proposed a rollback without a preview at the 0.1.1 gate. `@cf/zai-org/glm-4.7-flash` is not listed: it was too slow to answer a chat turn at the 0.1.0 gate. With `--var` or `.dev.vars`, pass the same array as a JSON string. |
| `BILINC_NAMESPACE` | `default` | 1–64 letters, digits, `_` or `-`. Changing it starts from an empty memory: entries under the old namespace stay in Bilinc but the agent no longer sees them. An invalid value stops the chat. |
| `AUTO_CHECKPOINT` | `true` | `"false"`, `"0"`, `"off"` or `"no"` (in any case, spaces at either end ignored) turns the automatic checkpoint off; any other value leaves it on. Then an overwrite made before a manual checkpoint cannot be rolled back. |

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

MIT, ReARC Labs Inc. Fonts (SIL Open Font License 1.1), icons (Phosphor, MIT) and design credits are listed in [NOTICE](NOTICE).
