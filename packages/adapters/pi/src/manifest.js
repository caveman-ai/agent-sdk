export const adapterManifest = Object.freeze({
  schemaVersion: 1,
  id: "pi",
  packageName: "@caveman-ai/adapter-pi",
  adapterVersion: "0.1.0",
  upstream: Object.freeze({ package: "@earendil-works/pi-agent-core", version: "1.0.0" }),
  capabilities: Object.freeze({
    run: "experimental",
    stream: "unsupported",
    tools: "experimental",
    usage: "experimental",
    abort: "experimental",
    durable: "experimental",
    compile: "experimental",
  }),
  certifications: Object.freeze({}),
});
