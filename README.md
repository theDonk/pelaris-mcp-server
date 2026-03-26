# Pelaris MCP Server

AI fitness coaching through any MCP-compatible AI assistant. Plan training, log workouts, track benchmarks, manage goals, and get coaching insights — all through natural conversation.

**[Website](https://pelaris.io)** · **[Integrations Guide](https://pelaris.io/integrations)** · **[How It Works](https://pelaris.io/how-it-works)** · **[Methodology](https://pelaris.io/methodology)**

## Connect

**MCP Server URL:** `https://api.pelaris.io/mcp`

### ChatGPT
Settings → Apps → Add → enter the MCP Server URL above

### Claude
Settings → Connectors → Add Custom → enter the MCP Server URL above → Advanced Settings → Client ID: `pelaris-claude`

### Any MCP Client
Connect to `https://api.pelaris.io/mcp` — supports OAuth 2.0 with PKCE and Dynamic Client Registration.

## Tools (21)

### Read Tools (9)
| Tool | Description |
|------|-------------|
| `get_training_overview` | View your training context, active programs, and recent sessions |
| `get_active_program` | View current program with phase, weekly structure, and session details |
| `get_session_details` | View a specific session's exercises, sets, targets, and feedback |
| `get_benchmarks` | View benchmark values, progress history, and trends |
| `get_body_analysis` | View body composition data and measurement trends |
| `search_training_resources` | Search curated training articles and resources |
| `get_coach_insight` | Get data-driven coaching insights based on your training |
| `get_onboarding_status` | Check profile setup completion status |
| `get_weekly_debrief` | View weekly training summary and coaching focus |

### Write Tools (12)
| Tool | Description |
|------|-------------|
| `create_planned_session` | Create a planned workout with exercises and targets |
| `log_workout` | Log a completed workout or mark a planned session as done |
| `swap_exercise` | Get alternative exercise suggestions |
| `modify_training_session` | Adjust session volume, intensity, or schedule |
| `record_injury` | Record an injury with body part, severity, and notes |
| `update_profile` | Update equipment, availability, and preferences |
| `send_feedback` | Submit coaching quality feedback |
| `generate_weekly_plan` | Generate a new training plan |
| `record_benchmark` | Record a benchmark value with history tracking |
| `daily_check_in` | Log daily readiness, soreness, and sleep quality |
| `manage_goals` | Create, update, complete, or list training goals |
| `manage_program` | View, archive, or manage training programs |

## Authentication

OAuth 2.0 with PKCE. The server supports:
- **Pre-registered clients** for ChatGPT and Claude
- **Dynamic Client Registration** for all other MCP clients

## Sports Supported

Strength · Running · Swimming · Cycling · Triathlon · CrossFit · General Fitness

[Pelaris](https://pelaris.io) implements 28 science-based training methodologies. [Learn more about our methodology](https://pelaris.io/methodology).

## Privacy

- Pseudonymous user IDs (Firebase UIDs are never exposed)
- PII scrubbing on all responses
- Granular OAuth scopes
- Users can disconnect anytime

[Privacy Policy](https://pelaris.io/privacy) · [Terms of Service](https://pelaris.io/terms)

## Built by

[Bradley Hunt](https://bradleyhunt.ai) · [About Pelaris](https://pelaris.io/about)
