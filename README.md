# Phone Push

The lightest possible remote awareness — push needs-you moments to your phone.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). It connects to the hub bus, watches every agent, and fires a phone push the moment one needs you.

## What it does

Watches `agent.state_changed` and, whenever an agent enters a **needs-you** mode — `approval` (waiting on a tool permission), `question` (asked you something), or `stopped` (finished / session ended) — it sends a push to your phone via the configured provider (**ntfy**, **Pushover**, or a **webhook**).

The title/body are composed from the agent label (the cwd basename) plus what's needed, e.g. `myrepo needs approval`. A per-`(sessionId, mode)` **dedup** means a flapping state doesn't spam you — you only get pinged when an agent newly enters a needs-you mode. All network calls are guarded: a provider outage is logged, never crashes the sidecar.

## Notifications (v1.1)

Successful pushes raise **no** desktop notification — the app already surfaces
needs-you moments natively, and mirroring them just doubled the noise (the old
per-event `notifications.post` mirror was removed). The one thing that IS
surfaced in the workspacer notification center is a **failed push delivery**:
you think you're covered on your phone precisely when you're away, so a silent
delivery failure is the worst case.

- Push `POST` fails (non-2xx or network error) → `notifications.post` with
  `level: 'error'`, body naming the provider + HTTP status (e.g. `ntfy 502`)
  and which alert was dropped, `sessionId` of the affected agent (click focuses
  it), and **`key: 'phone-push:error'`** so repeated failures replace the
  previous entry instead of stacking.

### Providers

- **ntfy** — `POST https://ntfy.sh/<target>` with a plain-text body and a `Title` header. `target` = your ntfy topic. Subscribe to the same topic in the ntfy phone app.
- **pushover** — `POST https://api.pushover.net/1/messages.json` (form-encoded). `target` = your Pushover **user key**; `pushoverToken` = your Pushover **application API token** (create an app at pushover.net to get one). Both are required for this provider.
- **webhook** — `POST <target>` with JSON `{ title, body, sessionId, mode }`. `target` = your endpoint URL.

## Bus wiring

- **Subscribes to:** `agent.state_changed`
- **Calls capabilities:** `notifications.post` (delivery-failure alerts only)
- **Emits:** —
- **Settings:**
- `provider` (select: `ntfy` | `pushover` | `webhook`, default `ntfy`) — push provider.
- `target` (string) — ntfy topic, Pushover user key, or webhook URL.
- `pushoverToken` (string) — Pushover application API token (only used when `provider = pushover`).

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/phone-push/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-phone-push`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Phone Push** pane from the command palette.

## Implement

The logic lives in `server.js` → `onEvent(event)`: it filters `agent.state_changed` down to the needs-you modes, dedups per `(sessionId, mode)`, composes a title/body, and dispatches to the chosen provider via global `fetch`; a failed delivery goes through `notifyPushFailure()` → `notifications.post`. `settings` holds the host-injected config above (`provider`, `target`, `pushoverToken`).

## Layout

```
phone-push/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
