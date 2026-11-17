# `@caveman-ai/coding-agent`

Interactive coding product built on `@caveman-ai/agent`, shipped separately so
core framework stays small and coding UX can evolve on its own release cycle.
Not yet published to npm; until it is, run it from this checkout.

```bash
npm install @caveman-ai/agent @caveman-ai/coding-agent
npx -p @caveman-ai/coding-agent caveman-code --workspace .
```

Library use:

```js
import { createCodingAgent, runCodingSession } from "@caveman-ai/coding-agent";

const agent = createCodingAgent({ workspace: process.cwd() });
await runCodingSession({ agent });
```

Host sandbox means uncontained host execution. Tools stay confined to selected
workspace by path checks and subprocess environments use explicit allowlists.
Optimized mode requires local Cave runtime; fallback is loudly observe-only.
Local reductions remain inferred and never become verified savings.
