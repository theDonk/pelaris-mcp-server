/**
 * First Light's entry links, the two the connector hands to an assistant.
 *
 * Programs are built in Pelaris, not in a chat (connector rev 2.1, Brad
 * 20/10/2026, BRAD_RETURN #46). The connector therefore answers "build me a
 * program" with a link that opens Pelaris at the right place. The tokens are
 * the route tokens of wayfinder's `config/entry_tokens.json` (the closed
 * list; this repo cannot import it, so the two strings live here, once):
 *
 * - `program`: signs the person in if needed and takes them to building their program.
 * - `train`: lands them on Today with the program they already hold (a paused
 *   program waits there with its Resume).
 *
 * A token retired later degrades to Today in the app, never an error, so a
 * stale link here is harmless.
 */

export const ENTRY_LINK_PROGRAM = "https://coach.pelaris.io/start/program";
export const ENTRY_LINK_TRAIN = "https://coach.pelaris.io/start/train";
