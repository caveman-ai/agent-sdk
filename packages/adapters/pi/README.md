# `@caveman-ai/adapter-pi`

**Observability adapter.** Records lifecycle and usage from a native Pi loop;
it does not run a Caveman agent. The separate exact-native Pi compiler target
and locked runner in this package are not that adapter.

Caveman Pi adapter plus exact-native Pi compiler target, pinned to
`@earendil-works/pi-agent-core@1.2.0`.

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-pi @earendil-works/pi-agent-core@1.2.0
```

```js
import {
  createAdapter,
  compileProfiledNativePi,
  nativePiCompilerTarget,
} from "@caveman-ai/adapter-pi";
```

Capabilities stay experimental until package conformance reports certify them.
Local optimization claims remain inferred.
