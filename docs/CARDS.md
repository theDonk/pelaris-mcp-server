# Cards

## 1. What cards are

- A card is a small interactive view that an AI chat draws under a tool result.
- Cards use the open **MCP Apps** standard, so one card serves every host that supports it.
- The tool's text reply is always complete on its own. Cards add to it and never replace it.
- A host without card support, and the assistant itself, read exactly what they always read.
- There are four cards today: Week, Debrief, Body and Session.

## 2. Architecture

- **Shell** (`src/cards/card_shell.ts`): `defineCard` builds a card's page once and derives its `ui://` URI from the page content hash (`cardResourceUri`), so any change to the page, the shared CSS or the bridge gives a new URI. `cardToolMeta` links a tool to its card. `withCard`, `attachCard` (mints a signed link) and `attachCardNow` (no link) add the data to a result under `_meta["pelaris/card"]` as `{ card, v, data }`, keeping only allow-listed fields. The data rides in `_meta`, not `structuredContent`, so the model's view is unchanged.
- **Host adapter** (`src/cards/host.ts`): `HostProfile`, `CARD_HOSTS` (the one allow-list), `cardsOn(host)` (switch on AND host draws cards). A text-only host gets no `ui://` resources, no `_meta.ui` on tools, no card data and no signed link. Per-host extras live here: Claude's `ui.domain` (first 32 hex characters of the SHA-256 of the server URL, then `.claudemcpcontent.com`) and ChatGPT's `openai/widgetAccessible` on app-only tools.
- **Bridge** (`src/cards/templates.ts`): `renderCardPage` builds a dependency-free page (no CDN, no fonts, no network, a strict CSP meta, no inline handlers, data drawn with `textContent` only). `window.PelarisCard` speaks MCP Apps JSON-RPC over `postMessage` (`ui/initialize`, `ui/message`, `ui/open-link`, `tools/call`, `ui/request-display-mode`, size and context notifications). All ChatGPT-runtime code (`window.openai`) sits in the bridge's one "Host section", tried only when the standard path is absent.
- **No-resend rule:** the bridge tries another path only when there is no host connection or the host answers method-not-found (`-32601`). Never after a timeout or an error, because the first request may already have run. `callTool` resolves to the result, `false` (no path) or `"pending"` (no answer in time). `canFullscreen()` reads the host's `availableDisplayModes`.
- **Cards** (`src/cards/*_card.ts`): one page and one pure mapper each. `src/cards/format.ts` holds shared date helpers (UTC days, "Thu 26 Nov", weeks Monday to Sunday).
- **Registry** (`src/cards/registry.ts`): `CARDS` lists every card; `registerCards(server)` is called from `src/index.ts`.
- **App-only write tool:** `card_reschedule_session` (in `src/tools/user/modify_training_session.ts`, `registerCardRescheduleSession`). Meta from `cardCallableToolMeta()`: `ui.visibility: ["app"]` (the spec says a host MUST NOT offer it to the model) plus the host's own keys. Registered only for a host that draws cards.
- **Off switch:** `PELARIS_CARDS=off` (also `0`, `false`, `no`) turns every card off for every host. Unset means on. `PELARIS_CARDS_UI_DOMAIN` overrides every host's `ui.domain` (`none` sends none).

## 3. The four cards

- **Week** (`get_active_program`): seven Monday to Sunday tiles and a This week / Next week switch. Inline: Rearrange this week (full screen) and Open in Pelaris. Where the host offers no full screen, the first action is Move a session and the move view opens in the card. Full screen: day list, drag or a Move button. Write path: Confirm calls `card_reschedule_session` with `{ sessionId, newDate }`. A planned, not completed session dated today or later can move. No Skip.
- **Debrief** (`get_weekly_debrief`): "N of M sessions" with a plain bar, the bonus line, every new record as plain rows (the tool's order, no cap, no pick), next week's focus, the tagline. Inline: Save as image (a canvas picture; falls back to showing it, then Copy text) and Open in Pelaris. No full screen, no write. An empty week gets no card.
- **Body** (`get_body_analysis`): latest scan, waist, hips and shoulders with the change since the previous scan, and the estimate line. Inline: Compare scans (only where the host offers full screen) and Open in Pelaris (the tool's own `scanLink`). Full screen: a slider over scans in `history` and a plain schematic outline. No write. No usable measurements means no card.
- **Session** (`get_session_details`): title, date, length, warm-up line, main-set rows. Inline: Start in Pelaris (signed link, route `SESSION_CARD_START_ROUTE`) and Swap an exercise (sends a chat message on tap; the assistant runs `swap_exercise`, which asks before changing anything). No full screen, no write.

## 4. Add a card

1. Create `src/cards/<name>_card.ts`. Define a data interface, then `defineCard<Data>({ id, v, title, description, fields, page })`. Give a name only (`id`); never write a URI, it is derived from the page content hash.
2. `fields` must equal the data type's keys exactly: a scalar key is `true`, an object or array of objects carries its own nested list. A missing or extra key is a compile error. Arrays of plain scalars are not supported.
3. The payload envelope is `{ card, v, data }`. Start at `v: 1`. Bump `v` when the data's shape changes in a way an older page would draw wrongly: the page draws only the `v` it knows and shows a plain fallback line otherwise.
4. `page` is `{ title, css?, body, script, displayModes? }`. The body is static markup (ids and classes, no data, no `on*=` attributes). The script calls `window.PelarisCard.onData(draw)` and draws with `textContent`. At most two actions inline. Richer views ask for full screen (`displayModes: ["inline", "fullscreen"]`, `canFullscreen()`, `requestFullscreen()`). Wrap markup shown only in full screen in `<!--full-->` and `<!--/full-->`.
5. Export a pure mapper from the tool's reply to the card's data (see `buildWeekCardData`) and test it in `src/cards/__tests__/<name>_card.test.ts`.
6. Test the page with `openCardPage` from `card_dom_harness.ts` (see `week_card_page.test.ts`): draw sample data, tap each action, and check what the stub host receives.
7. Add the card to `CARDS` in `src/cards/registry.ts`.
8. In the tool, spread `...(cardToolMeta(CARD) ? { _meta: cardToolMeta(CARD) } : {})` into the config, then wrap the reply with `attachCard` (needs a signed link) or `attachCardNow`.
9. List the new test files in `scripts/run_tests.mjs`. `card_templates.test.ts` checks every registered card automatically (two inline actions at most, no inline handlers, no inline SVG except cards in `INLINE_SVG_CARDS`, today only Body).

## 5. Add a host

1. Confirm in that host's own docs, before any code: how it advertises MCP Apps support; the resource MIME type it expects (`text/html;profile=mcp-app`); which bridge methods it implements (`ui/message`, `ui/open-link`, `tools/call`, `ui/request-display-mode`); its display modes; the `ui.domain` format, if it needs one; how it treats app-only tools and whether it asks before a write; and how it opens links.
2. Add one entry to `CARD_HOSTS` in `src/cards/host.ts`, keyed by the host's assistant class: its `uiDomain` rule if it has one and any `appToolMeta` keys. Cite the doc in the comment above the list.
3. If the host needs bridge code the standard path lacks, add it to the bridge's "Host section" only.
4. Test: `host.test.ts` (profile for the new name, domain, tool meta), `card_shell.test.ts`, and `cards_off_parity.test.ts` (text reply unchanged). Then draw each card in the live host and record the result in the table in section 8.

## 6. Rules every card obeys

- The text reply is untouched.
- Allow-listed, versioned data only. Nothing private.
- No photos or image fields.
- A body number is never a record, best or win, and gets no red or green.
- No progress ring and no streak.
- At most two inline actions.
- Writes go only through a narrow app-only tool, behind a Confirm tap.
- Never resend a write after a timeout or an error.
- Never send a chat message without the person's tap.
- Code never picks a highlight: a list is shown whole or not at all.
- No em dashes. Dates like "Thu 26 Nov". Weeks run Monday to Sunday.

## 7. How the host is identified

The server is stateless: a new server answers each POST to `/mcp`. The client's `initialize` capabilities and `clientInfo` reach only the server that answers `initialize`, never the one answering `tools/list` or `tools/call`. Every request does carry the OAuth token, whose stored assistant class was set at consent from the validated redirect host. So the adapter takes, in order:

1. a declared `extensions["io.modelcontextprotocol/ui"].mimeTypes` naming the card MIME type, when a caller has it (a test, or a stateful transport);
2. else the host name (the token's class, or a matching `clientInfo.name`) on `CARD_HOSTS` (today `claude` and `chatgpt`);
3. else no cards. Unknown or missing hosts, and admin-authed calls, get plain tools.

## 8. What is verified

Read Fri 20 Nov 2026. **No card has been drawn inside a live ChatGPT or Claude chat yet.** What was checked: unit tests, the page harness, and (by hand, not committed) the pages in a local browser at 320 px, light and dark, with a stub host and sample data.

| Host | Verified against its docs | NOT yet verified in a live chat |
|---|---|---|
| ChatGPT | Standard `_meta.ui.resourceUri` and bridge ([Build the ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui.md), [UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines.md)); `tools/call` and `ui/message` on the bridge. | Any card drawn. Docs do not mention `ui/open-link` or `ui/request-display-mode`, nor whether result `_meta` reaches the card through the standard bridge; the `window.openai` fallbacks (`toolResponseMetadata`, `openExternal`, `sendFollowUpMessage`, `requestDisplayMode`) are unconfirmed on the current runtime. Whether `openai/widgetAccessible` is honoured on this server. Whether a write from a card asks the athlete first. |
| Claude | Resource shape, `ui.domain` rule, design guidance ([Get started](https://claude.com/docs/connectors/building/mcp-apps/getting-started.md), [Quickstart](https://claude.com/docs/connectors/building/mcp-apps/quickstart.md), [Design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md)). | Any card drawn. Whether the computed `ui.domain` works, or is needed at all (the docs tie it to apps with their own sign-in). Whether a one-tap link opens without a confirm prompt (needs the link origin declared in the directory listing). Whether a card may call `card_reschedule_session`. Whether a host reports `displayMode` back. Drag in a sandboxed frame on touch (the Move button does not need drag). |
| Muse (text only) | No primary Meta source found on whether Muse renders MCP Apps. It is not on `CARD_HOSTS`, so it gets the plain tool reply and no card work. | Nothing to verify until a source says it draws cards. |

Both hosts: neither's docs say whether the host declares the MCP Apps extension in `initialize`, and this stateless server could not see it on a tool call anyway, hence the allow-list. Spec: MCP Apps stable 2026-01-26 ([specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [SDK types](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/spec.types.ts), [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)). Also not verified: whether a host lets the Debrief card download its picture or write to the clipboard (the fallbacks are showing the picture and a select-to-copy note), and units (rows show kilograms and metric distances; the athlete's preference is not read).

## 9. Testing

- `npm run build`, then `npm test`. Tests run from `dist`, so build first; new test files must be listed in `scripts/run_tests.mjs`.
- `src/cards/__tests__/card_dom_harness.ts` runs a page's real scripts (bridge and card) in a Node `vm` context with a small fake DOM, a stub host that answers JSON-RPC the way a test says, and manual timers (a request can time out without waiting). No browser, no dependency. Layout, CSS and canvas are out of scope.
- Preview: no preview script or local viewer is committed. To look at a card, render its page (`CARD.html()`) to a file and open it in a browser with a stub host of your own.

## 10. Tool contract changes in this release

What the assistant reads is the same with cards on, off, or on a text-only host, except for these deliberate, additive changes (tested in `cards_off_parity.test.ts`):

- `get_body_analysis` returns `history`: recent scans, newest first, each with its date and weight, waist, hips and shoulders (numbers and dates only; null with one scan).
- `get_active_program` passes a session's stored `durationMinutes` through when it has one (never estimated).
- `modify_training_session` is now `idempotentHint: false`: reduceVolume and increaseIntensity scale the stored values, so a repeat compounds. It is not callable from a card.
- New app-only tool `card_reschedule_session` (input exactly `{ sessionId, newDate }`, strict), registered only for a card host. It uses the same reschedule path as `modify_training_session` and returns the same `moved` / `skipped` / `needsAthlete` / `failed` / `message` reply. Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` (a repeat finds the session already on that day).
