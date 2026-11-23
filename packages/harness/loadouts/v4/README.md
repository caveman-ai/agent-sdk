# Harness v4 loadouts

The candidate v4 loadouts, each kept only after its step passed a pre-registered gate (`iters/v4-plan.md`):

- `v4-opus.json`: Claude Opus. The o16c behavior plus the 5-minute cache keep-alive (`wire.anthropic.keepalive_s`
  270), and the program tool when the run has MCP servers (`tools.program.exposure: "with_mcp"`, `mcp.exposure:
  "program"`). With no MCP servers its tools and system prompt are those of the keep-alive arm o20k.
- `v4-sol.json`: GPT-6.1 Sol. s16 plus MCP tools in exec cells as Codex gives them (`mcp.exposure: "program"`).

They live in this subdirectory so the R1/R2 arm-naming test (tests/arm-loadouts.test.ts) doesn't cover them.
