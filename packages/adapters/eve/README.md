# `@caveman-ai/adapter-eve`

**Observability adapter.** Records lifecycle and usage from a native Eve loop;
it does not run a Caveman agent.

Exact-pinned Caveman adapter for `eve@0.29.2` `ClientSession`. Requires Node 24+.

Not yet published to npm; until it is, install it from this checkout.

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-eve eve@0.29.2
```

```js
import { createAdapter } from "@caveman-ai/adapter-eve";
```

Adapter checks session runtime identity and aggregates durable
`step.completed` usage. Eve lane currently refuses reasoning plans because
upstream usage lacks reasoning-token evidence.
