# mini-swe

[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)'s design on the
Caveman kernel: one `bash` tool, a fresh subshell per command, linear history,
and a one-line sandbox swap. `src/agent.ts` is the whole agent. What the kernel
adds without any code here: a USD budget the run cannot choose to exceed, a
model-call ceiling, a wall-clock deadline, loop breakers, a receipt for every
run, and durable runs that resume after a crash with their known spend.

No SWE-bench score is claimed in this repository. The runner below produces a
`preds.json` that the official SWE-bench harness scores; the number is whatever
that harness reports.

## Run it on a task

From the repository root, once:

```bash
npm ci
npm --prefix packages/agent run build
```

Then in this directory:

```bash
cp .env.example .env            # paste ANTHROPIC_API_KEY (or OPENAI_API_KEY)
cd /path/to/your/repo
npm --prefix /path/to/examples/mini-swe run mini -- "The parser drops trailing commas; fix it."
```

Commands run on your machine in that directory. Host execution is not
isolation. The run stops at $3 list price, 250 model calls, or 30 minutes,
whichever comes first, and prints its receipt.

## Run it on SWE-bench

Needs Docker. Each instance runs in the official `swebench/sweb.eval.x86_64.*`
image, in its own container, as its own durable run.

```bash
npm run swebench -- --subset verified --slice 0:5 --workers 2
npm run swebench -- --subset verified --filter '^django' --output runs/django
```

| flag | default | meaning |
|---|---|---|
| `--subset` | `verified` | `verified`, `lite`, `full`, or a Hugging Face dataset id |
| `--split` | `test` | dataset split |
| `--slice` | | `start:end` over the sorted instance ids |
| `--filter` | | regex over instance ids |
| `--workers` | `1` | concurrent instances |
| `--output` | `runs/swebench` | `preds.json`, one `*.traj.json` per instance, and the journals |
| `--redo` | off | rerun instances already in `preds.json` on a fresh journal |

Instances already in `preds.json` are skipped, so a killed batch continues
where it stopped. An instance killed mid-run resumes its own journal on the
next start instead of paying for the finished calls again, and its patch is
recovered from the journaled tool result. Ctrl-C removes the live containers.

Score with the official harness:

```bash
pip install swebench
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path runs/swebench/preds.json \
  --max_workers 4 --run_id mini-swe
```

## Test

```bash
npm test     # scripted provider turns and a fake backend; no network, no Docker
npm run build
```
