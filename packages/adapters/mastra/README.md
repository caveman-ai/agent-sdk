# `@caveman-ai/adapter-mastra`

**Observability adapter.** Records lifecycle and usage from a native Mastra
loop; it does not run a Caveman agent.

Native Caveman `Processor` for exact `@mastra/core@1.63.2`. No wrapper agent,
second model loop, proxy, cache, retry engine, workflow runtime, memory layer, or
telemetry provider.

Not yet published to npm; until it is, install it from this checkout.

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-mastra @mastra/core@1.63.2
```

```ts
import { Agent } from "@mastra/core/agent";
import { createMastraAdapter } from "@caveman-ai/adapter-mastra";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";

const caveman = createMastraAdapter({
  modelBoundary: createModelBoundary([contextCompression]),
  onLifecycle: sendLifecycle,
  onModelUsage: sendUsage,
});

const agent = new Agent({
  id: "support",
  name: "Support",
  instructions: "Help customer.",
  model,
  inputProcessors: [caveman],
  outputProcessors: [caveman],
});
```

Same processor belongs in both arrays: Mastra exposes model-request hooks on
input processors and stream/tool/terminal hooks on output processors. Adapter
returns native prompt, chunk, and `MessageList` objects unchanged except prompt
transformations explicitly returned by supplied `ModelBoundary`.

V3 nested raw usage wins over V2 flattened usage. Missing cache-read,
cache-write, reasoning, or total evidence remains `null`, and incomplete usage
keeps cost unknown. Missing provider/model identity prevents accounting.
Adapter never creates token zeros or local cost claims.

Mastra response-cache hits remain host-owned and are not reported as provider
calls. Retryable model failures and terminal run failures lack complete
Processor callbacks in 1.63.2, so related lifecycle phases remain unsupported.
Host control chunks are passed through untouched and ignored.
