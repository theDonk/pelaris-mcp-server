<!-- pelaris-shared-public:start -->
## Pelaris: who we are and how we build

**Pelaris** is a privacy-first AI fitness coach. It plans, adapts and explains training around the athlete's goals, history and life. Tagline: "Stop tracking. Start navigating." This repo is its public MCP server, so any MCP-compatible assistant can plan training, log workouts and get coaching through Pelaris.

**Mottos**
- Development: *Build on the foundations we have, lay strong foundations for the future.*
- Design: *To swim across the ocean, you start at the beach, and aim for the horizon.*

**Before you act, ask the four principle questions**
1. **AI-first:** is this a judgement call? Then the AI decides. Code only executes. No keyword, regex or threshold gates for understanding.
2. **Improve and enhance:** what existing thing am I extending? Name it before writing anything new, and don't rebuild.
3. **End-to-end:** have I traced the whole path, from the tool call, through the server, to what the athlete sees?
4. **Basics brilliantly:** is it verified with evidence (a command log, a test run, a CI link), not "should work"?

**Push back.** If a request conflicts with the mottos, an existing rule or the evidence, say so in one line and offer the better option before acting.

**Validation ladder:**
- Rung 0 is a self-check (copy, small fixes, research).
- Rung 1 is one fresh reviewer (features, tool contracts).
- Rung 2 is two lenses (architecture, public or security-facing work).
- Every rung ends in evidence.

**Never, without the maintainer's explicit yes:**
- deleting or retiring a tool, file or behaviour (prefer keep-and-deprecate)
- anything involving money or live AI runs
- production data
<!-- pelaris-shared-public:end -->

## pelaris-mcp-server: commands and rules

TypeScript MCP server (OAuth 2.0 with PKCE and dynamic client registration). Tools are listed in `README.md`.
- **Commands:** `npm ci`, `npx tsc --noEmit`, `npm run build`, `npm test`. Run every `.github/workflows/ci.yml` step before a merge. Deploys go through the pipeline, never by hand.
- **This repo is PUBLIC.** Code, commit messages, PR titles and bodies, comments, test fixtures and Actions logs are all world-readable. Never put any of these anywhere in it:
  - emails, account, profile or user ids, or real names
  - production logs, counts, latency, user or revenue numbers
  - internal URLs, project details, ticket links or local paths
  - secrets, keys, tokens or `.env` values
  - security reasoning (residual risks, bypass conditions, review findings)
- **Keep PR text short and plain.** Detailed reasoning stays in private notes; a public PR says "see internal design notes".
- **Fixtures use obviously fake data.**
- **CI stays safe for forks:** `pull_request`, never `pull_request_target` with PR code; least-privilege `permissions:`; SHA-pinned actions; no branch names interpolated in `run:`; no secrets reachable from fork PRs.
- **Tool descriptions are product copy.** Plain words, no em dashes, uplifting, never guilt.
