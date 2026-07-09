# Phone Push

The lightest possible remote awareness — push needs-you to your phone.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). **Runnable scaffold** — it loads, connects to the hub bus, and shows live activity; the real logic is stubbed with clear TODOs.

## What it does

On any needs-you `agent.state_changed` (approval/question/stopped), sends a push via ntfy / Pushover / a webhook so you know an agent is waiting even away from the machine.

## Bus wiring

- **Subscribes to:** `agent.state_changed`
- **Calls capabilities:** `notifications.post`
- **Emits:** —
- **Settings:**
- `provider` (select) — Push provider.
- `target` (string) — ntfy topic, Pushover user key, or webhook URL.

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/phone-push/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-phone-push`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Phone Push** pane from the command palette.

## Implement

Edit `server.js` → `onEvent(event)`. Subscribed topics arrive there; use `call('method', params)` for capabilities and `publish('command.x', data)` for commands. `settings` holds the host-injected config above.

## Layout

```
phone-push/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
