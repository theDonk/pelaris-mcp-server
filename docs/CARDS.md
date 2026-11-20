# Cards

Cards are small interactive views a host draws under a tool result, built on the open
**MCP Apps** extension, so one card serves every host that supports it. A tool's text
reply never changes: hosts without card support, and the assistant itself, read exactly
what they read before.

## How it works here

- `src/cards/card_shell.ts` is the one shell every card goes through:
  - `registerCardResources` registers each card's `ui://` HTML resource
    (MIME `text/html;profile=mcp-app`, `_meta.ui.csp` with no outside origins, `prefersBorder`);
  - `cardToolMeta(card)` gives a tool definition `_meta.ui.resourceUri` (the nested key
    only: the flat `ui/resourceUri` key is deprecated in the spec, to be removed before GA,
    and neither Claude's nor ChatGPT's docs ask for it);
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
  Actions, each falling back to the ChatGPT runtime (`window.openai`, all of it in the
  bridge's one "Host section") and then to a plain result of `false` so the card can show
  a note:
  `sendMessage(text)` (`ui/message`), `openLink(url)` (`ui/open-link`),
  `callTool(name, args)` (`tools/call`; resolves to the tool's result, or `false`),
  `requestFullscreen()` and `requestInline()` (`ui/request-display-mode`), and
  `onContext(fn)` (host context on connect and on each change, for example `displayMode`).
- A tool a card calls itself spreads `cardCallableToolMeta()` into its `_meta`
  (`ui.visibility: ["model", "app"]`, plus the host's own keys from the host adapter, for
  ChatGPT `openai/widgetAccessible`). Its
  annotations stay as they are; a write keeps `readOnlyHint: false, destructiveHint: true`.
- `src/cards/registry.ts` lists every card; `src/index.ts` calls `registerCards(server)`.

### The host adapter

`src/cards/host.ts` turns what the request knows about the host into a `HostProfile`
(`supportsCards`, `name`, `source`, `uiDomain`, `appToolMeta`). Every card helper and every
mint of a card's signed link goes through `cardsOn(host)`: the switch is on AND the host
draws cards. A text-only host gets no `ui://` resources, no `_meta.ui` on tools (tools are
registered per request, and the spec lets a server register different tool variants per
host), no card data and no link written for a card nobody sees.

How the host is known: the transport is stateless (a new server per POST /mcp), so the
client's `initialize` capabilities and `clientInfo` reach only the server that answers
`initialize`, never the one answering `tools/list` or `tools/call`. Every request carries
the OAuth token, whose stored assistant class was set at consent from the validated
redirect host. So the adapter takes, in order: a declared
`extensions["io.modelcontextprotocol/ui"].mimeTypes` naming the card MIME type (when a
caller has it); else the host's name (the token's class, or `clientInfo.name`) on
`CARD_HOSTS`, the one allow-list (today `claude` and `chatgpt`); else no cards. Unknown
or missing means no card work. Admin-authed calls carry no token class and get no cards.

`ui.domain` is per host: Claude's is its documented rule (the first 32 hex characters of
the SHA-256 of the server URL, then `.claudemcpcontent.com`); ChatGPT gets none.

### The switch

`PELARIS_CARDS=off` (also `0`, `false`, `no`) turns every card off for every host: no
`ui://` resources, no `_meta.ui` on tools, no card data on results, no card links minted.
Unset means on. `PELARIS_CARDS_UI_DOMAIN` overrides every host's `ui.domain` (`none`
sends none).

## Cards today

| Card | Tool | Shows | Actions |
|---|---|---|---|
| Week (`ui://pelaris/cards/week-v1.html`) | `get_active_program` | the primary program's week as seven tiles, Monday to Sunday (the session's own `focus`, else `slotType`, cut short by CSS; minutes only when the server sent a stored `durationMinutes`), the date range, a This week / Next week switch when next-week sessions came back. Full screen: the days as a list; a planned session dated today or later and not completed moves by drag or by its Move button (a day picker); a confirm panel shows the session and both dates before anything is written. No Skip. | Rearrange this week (full screen; Confirm calls `modify_training_session` with `rescheduleSessions: [{ sessionId, newDate }]`, updates the tiles from `moved`, shows the reason or `message` otherwise, then sends the chat a one-line note; with no card tool call it sends the request as a chat message), Open in Pelaris (signed link, `program` route) |
| Debrief (`ui://pelaris/cards/debrief-v1.html`) | `get_weekly_debrief` | week label, "N of M sessions" with a plain bar, the bonus line, a record line only when `newPrs` has exactly one entry (stated as data, no unit: the tool gives none), next week's focus, the tagline. No headline win or watch line is picked in code (a judgement: the assistant's message carries it). An empty week gets no card. | Save as image (a square canvas picture: week, sessions, the record line, focus, tagline; no name, no account details; then shown in the card, and the action becomes Copy text), Open in Pelaris (signed link, `program` route) |
| Body (`ui://pelaris/cards/body-v1.html`) | `get_body_analysis` | the latest scan's date; waist, hips and shoulders with the change since the previous scan (plain signed numbers with the unit); shoulder to waist when returned; "Measurements are estimates from the scan, not exact." Full screen: a slider with one stop per scan in `history` (newest at the right), or two stops from the latest values and `comparisonToPrevious` (the earlier one is the latest minus the change); rows for waist, hips, shoulders and weight (when present) with the change since the first stop; a plain schematic outline in inline SVG whose shoulder, waist and hip widths follow the numbers (clamped), the first stop dashed behind it. No photo, ever; no red or green; nothing called a record or a best. Centimetres and kilograms (the tool carries no unit preference). No analysis, or none of waist, hips and shoulders (a profile weight only), means no card. | Compare scans (full screen; hidden with a single scan), Open in Pelaris (the tool's own signed `scanLink`; no link, no button) |
| Session (`ui://pelaris/cards/session-v1.html`) | `get_session_details` | title, date, length, warm-up line (only blocks typed `warm_up`), main-set rows (sets x reps with load or RPE; cardio distance or time) | Start in Pelaris (signed one-tap link, route in `SESSION_CARD_START_ROUTE`), Swap an exercise (sends a chat message; the assistant runs `swap_exercise`, which asks before it changes anything) |

## Tool contract changes on this branch

What the assistant reads is the same with cards on, off, or on a text-only host, except
for these deliberate, additive changes (tested in `cards_off_parity.test.ts`):

- `get_body_analysis` returns `history`: recent scans, newest first, each with its date
  and weight, waist, hips and shoulders (numbers and dates only; null with one scan).
- `get_active_program` passes a session's stored `durationMinutes` through when it has
  one (never estimated).
- `modify_training_session` is now `idempotentHint: false`: reduceVolume and
  increaseIntensity scale the stored values, so a repeat compounds.

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
or streak, and keep the text reply complete on its own. Inline SVG is allowed only for the
cards named in `INLINE_SVG_CARDS` in `card_templates.test.ts` (today the Body card's
outline): one `<svg>` of plain `path` and `circle` shapes, no links, no `xmlns`, no images.

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
- **Meta Muse:** no primary Meta source found on whether Muse renders MCP Apps. It is not
  on `CARD_HOSTS`, so it gets no card work and the plain tool reply.
- **Host capability:** neither Claude's nor ChatGPT's docs say whether the host declares
  the MCP Apps extension in `initialize` (and this stateless server could not see it on a
  tool call anyway), hence the allow-list. Claude's computed `ui.domain` is not yet
  checked in a live Claude chat.
- **Week card, every host:** checked in a local browser at 320 px, light and dark, with
  a stub host: full screen request, Move, day picker, confirm, the tool call's exact
  arguments, the tile update and the follow-up message. Not checked live: whether a
  host lets the card call `modify_training_session` (a write; Claude and ChatGPT may ask
  the athlete first), whether ChatGPT honours `openai/widgetAccessible` on this server,
  whether a host reports `displayMode` back, and drag in a host's sandboxed frame on
  touch (the Move button is the path that does not need drag).
- **Debrief card:** drawn in a local browser at 320 px, light and dark, with a stub host
  and sample data: the card, Save as image (the picture shown in the card, the action
  becoming Copy text, the fallback note). Not verified: whether any host
  lets the sandboxed card download the picture (not claimed for ChatGPT), and whether
  clipboard writes work there; the fallbacks are the picture shown in the card and a
  select-to-copy note.
- **Body card:** drawn in a local browser at 320 px, light and dark, with a stub host and
  sample data (three scans): inline rows and changes, the full screen request, the slider
  and the Earlier and Later buttons at each stop, the outline and the rows. Not checked
  live: whether a host shows full screen for it, the range input under touch inside a
  host's sandboxed frame (the Earlier and Later buttons do not need it), and whether
  the scan link opens without a confirm prompt. With real data the outline moves by a
  few pixels for a change of a few centimetres: honest, and small.
- Units: rows show kilograms and metric distances; the athlete's preferred units are
  not read by this tool.
