# `@caveman-ai/adapter-vercel-ai-sdk`

**Observability adapter.** Records lifecycle and usage from a native Vercel AI
SDK loop; it does not run a Caveman agent.

Native, exact-pinned adapter for `ai@7.0.84`. Vercel keeps its model, agent
loop, retries, tools, aborts, and streams. Adapter adds no proxy or replacement
runner.

Not yet published to npm; until it is, install it from this checkout.

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-vercel-ai-sdk ai@7.0.84
```

```ts
import { ToolLoopAgent, wrapLanguageModel } from "ai";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import {
  createVercelAISDKAdapter,
  type VercelModelRequest,
  type VercelModelResponse,
} from "@caveman-ai/adapter-vercel-ai-sdk";

const boundary = createModelBoundary<VercelModelRequest, VercelModelResponse>([]);
const caveman = createVercelAISDKAdapter({
  modelBoundary: boundary,
  onLifecycleEvent: event => record(event),
  onModelUsage: usage => record(usage),
});

const agent = new ToolLoopAgent({
  model: wrapLanguageModel({ model, middleware: caveman.middleware }),
  ...caveman.composeAgentCallbacks(existingCallbacks),
});
```

`composeAgentCallbacks` preserves existing callback return values and thrown
errors. Caveman observers are best-effort. Streaming remains pull-driven and
forwards cancellation to native stream.

Usage uses disjoint non-cached input, cache-read, cache-write, output, and
reasoning counts. Missing Vercel counts become `null`, never zero. Complete
counts are `unpriced`; incomplete counts are `unknown`.

Capabilities stay experimental. `run.error`, replay, durability, tracing, and
compilation remain unsupported because this native seam cannot prove them.
