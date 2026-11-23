# caveman-evals

Zero-dependency Python SDK for Caveman Cloud's local-first evaluation platform.

- `Eval(...)`: Local-first, Cloud-synced BYO agent evaluation with multi-trial `pass@k` and `pass^k`.
- `ComputerEval(...)`: Fan out isolated computers running versioned Caveman agents with in-sandbox command verifiers and LLM judges.
- `wrap_openai()`, `wrap_anthropic()`, `traced()`: 1-line inline span capture with zero OpenTelemetry setup.
- Built-in scorer helpers: `exact_match`, `contains`, `regex_match`, `tool_called`, `llm_judge`.
