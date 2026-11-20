# Cards

Cards are small interactive views a host draws under a tool result, built on the open
**MCP Apps** extension, so one card serves every host that supports it. A tool's text
reply never changes: hosts without card support, and the assistant itself, read exactly
what they read before.

## How it works here

- `src/cards/card_shell.ts` is the one shell every card goes through:
  - `registerCardResources` registers each card's `ui://` HTML resource
    (MIME `text/html;profile=mcp-app`, `_meta.ui.csp` with no outside origins, `prefersBorder`);
  - `cardToolMeta(card)` gives a tool definition `_meta.ui.resourceUri` (plus the flat
    `ui/resourceUri` key the official SDK helper also writes);
  - `withCard(result, card, data)` adds the card's data to the result under
    `_meta["pelaris/card"]`, keeping only the fields in the card's allow-list (`fields`).
    The data rides in `_meta`, not `structuredContent`, because some hosts hand
    `structuredContent` to the model in place of the text, which would shrink what the
    assistant sees.
- `src/cards/templates.ts` holds the shared page (`renderCardPage`), styles and the host
  bridge (`window.PelarisCard`). No dependencies, no CDN, no fonts, no network; a page CSP
  meta (`default-src 'none'`, inline script and style only); no inline event handlers;
  card data is drawn with `textContent` only. Surround colours come from the host's
  standard style variables (`--color-background-primary` and so on) with light and dark
  fallbacks; the Pelaris accent is on buttons only; buttons are at least 44 px; the layout
  holds at 320 px.
- The bridge speaks MCP Apps JSON-RPC over `postMessage`: `ui/initialize`, then
  `ui/notifications/initialized`; it reads `ui/notifications/tool-result` and
  `ui/notifications/host-context-changed`, and reports `ui/notifications/size-changed`.
  Actions, each falling back to the ChatGPT runtime (`window.openai`) and then to a
  plain result of `false` so the card can show a note:
  `sendMessage(text)` (`ui/message`), `openLink(url)` (`ui/open-link`),
  `callTool(name, args)` (`tools/call`; resolves to the tool's result, or `false`),
  `requestFullscreen()` and `requestInline()` (`ui/request-display-mode`), and
  `onContext(fn)` (host context on connect and on each change, for example `displayMode`).
- A tool a card calls itself spreads `cardCallableToolMeta()` into its `_meta`
  (`ui.visibility: ["model", "app"]` and ChatGPT's `openai/widgetAccessible`). Its
  annotations stay as they are; a write keeps `readOnlyHint: false, destructiveHint: true`.
- `src/cards/registry.ts` lists every card; `src/index.ts` calls `registerCards(server)`.

### The switch

`PELARIS_CARDS=off` (also `0`, `false`, `no`) turns every card off: no `ui://` resources,
no `_meta.ui` on tools, no card data on results. Unset means on (tests run with it on).
Optional: `PELARIS_CARDS_UI_DOMAIN` sets `_meta.ui.domain` for hosts that need a fixed
sandbox origin. Each host has its own format (for Claude, the first 32 hex characters of
the SHA-256 of the server URL, then `.claudemcpcontent.com`), so it is unset by default.

## Cards today

| Card | Tool | Shows | Actions |
|---|---|---|---|
| Week (`ui://pelaris/cards/week-v1.html`) | `get_active_program` | the primary program's week as seven tiles, Monday to Sunday (the session's own `focus`, else `slotType`, cut short by CSS; minutes only when the server sent a stored `durationMinutes`), the date range, a This week / Next week switch when next-week sessions came back. Full screen: the days as a list; a planned session dated today or later and not completed moves by drag or by its Move button (a day picker); a confirm panel shows the session and both dates before anything is written. No Skip. | Rearrange this week (full screen; Confirm calls `modify_training_session` with `rescheduleSessions: [{ sessionId, newDate }]`, updates the tiles from `moved`, shows the reason or `message` otherwise, then sends the chat a one-line note; with no card tool call it sends the request as a chat message), Open in Pelaris (signed link, `program` route) |
| Session (`ui://pelaris/cards/session-v1.html`) | `get_session_details` | title, date, length, warm-up line (only blocks typed `warm_up`), main-set rows (sets x reps with load or RPE; cardio distance or time) | Start in Pelaris (signed one-tap link, route in `SESSION_CARD_START_ROUTE`), Swap an exercise (sends a chat message; the assistant runs `swap_exercise`, which asks before it changes anything) |

## Add a card

1. Create `src/cards/<name>_card.ts` exporting a `CardDefinition`: `id`, a versioned
   `resourceUri` (`ui://pelaris/cards/<name>-v1.html`; bump the version after a breaking
   change), `title`, `description`, the `fields` allow-list, and `html: () => renderCardPage({ title, body, script, displayModes? })`.
   The body is static markup (ids and classes, no data, no `on*=` attributes); the script
   calls `window.PelarisCard.onData(draw)` and draws with `textContent`. At most two
   actions inline; anything richer asks for full screen (`displayModes: ["inline", "fullscreen"]`
   and `PelarisCard.requestFullscreen()`).
2. Export a pure mapper from the tool's reply to the card's data, and test it.
3. Add the definition to `CARDS` in `src/cards/registry.ts`.
4. In the tool: spread `...(cardToolMeta(CARD) ? { _meta: cardToolMeta(CARD) } : {})` into
   the tool config, and return `withCard(reply, CARD, data)` on success.
5. List the new test files in `scripts/run_tests.mjs`. `card_templates.test.ts` checks
   every registered card's page automatically. Wrap markup shown only in full screen in
   `<!--full-->` and `<!--/full-->`: the two-action limit counts the inline markup only.

Never pass a card more than it shows, never send a body photo, never draw a progress ring
or streak, and keep the text reply complete on its own.

## Verified against (read Fri 20 Nov 2026)

- MCP Apps spec, stable 2026-01-26:
  [specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
  [SDK types](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/spec.types.ts)
  (`ui/message` content as a content-block array and `appInfo` in `ui/initialize` follow the SDK types),
  [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp).
- ChatGPT: [Build the ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui.md),
  [UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines.md).
- Claude: [Get started with MCP Apps](https://claude.com/docs/connectors/building/mcp-apps/getting-started.md),
  [Quickstart](https://claude.com/docs/connectors/building/mcp-apps/quickstart.md),
  [Design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md).

## Not verified

- **Every host:** no card has been drawn in a live host yet. Checked: unit tests, a
  static page check, and the page drawn in a local browser at 320 px, light and dark,
  with sample data.
- **ChatGPT:** its docs name `tools/call` and `ui/message` on the bridge but do not
  mention `ui/open-link` or `ui/request-display-mode`, nor whether result `_meta`
  reaches the card through the standard bridge. The bridge falls back to
  `window.openai` (`toolResponseMetadata`, `openExternal`, `sendFollowUpMessage`,
  `requestDisplayMode`), not confirmed on the current runtime.
- **Claude:** whether `ui.domain` is needed for this card (the docs tie it to apps that
  run their own sign-in), and whether a one-tap link opens without a confirm prompt
  (that needs the link origin declared in the directory listing).
- **Meta Muse:** no primary Meta source found on whether Muse renders MCP Apps. The tool
  reply reads as plain text there, unchanged.
- **Week card, every host:** checked in a local browser at 320 px, light and dark, with
  a stub host: full screen request, Move, day picker, confirm, the tool call's exact
  arguments, the tile update and the follow-up message. Not checked live: whether a
  host lets the card call `modify_training_session` (a write; Claude and ChatGPT may ask
  the athlete first), whether ChatGPT honours `openai/widgetAccessible` on this server,
  whether a host reports `displayMode` back, and drag in a host's sandboxed frame on
  touch (the Move button is the path that does not need drag).
- Units: rows show kilograms and metric distances; the athlete's preferred units are
  not read by this tool.
