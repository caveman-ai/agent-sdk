# `@caveman-ai/adapter-claude-agent-sdk`

**Observability adapter.** Records lifecycle and usage from a native Claude
Agent SDK loop; it does not run a Caveman agent. The unlocked `runClaudeAgent`
runner in this package is a separate surface, not that adapter.

Caveman adapter and unlocked Claude runner pinned to
`@anthropic-ai/claude-agent-sdk@0.3.220`.

Not yet published to npm; until it is, install it from this checkout.

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-claude-agent-sdk @anthropic-ai/claude-agent-sdk@0.3.220
```

```js
import { createAdapter, runClaudeAgent } from "@caveman-ai/adapter-claude-agent-sdk";
```

Claude execution remains unlocked and inferred. Compile capability stays
unsupported until source, budget, recovery, cache, and replay evidence closes.
