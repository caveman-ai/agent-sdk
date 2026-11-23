"""Zero-dependency Python SDK for Caveman Cloud's local-first evals.

Supports:
  - Eval() for local-first & Cloud-synced BYO agent evaluation (with multi-trial pass@k / pass^k)
  - ComputerEval() for fanning out isolated computers on Caveman Cloud
  - wrap_openai() / wrap_anthropic() / traced() for zero-OTel inline span capture
  - Built-in scorer helpers (exact_match, contains, regex_match, tool_called, llm_judge)
"""

from __future__ import annotations

import asyncio
import contextvars
import dataclasses
import inspect
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

__all__ = [
    "ScoreResult",
    "Span",
    "EvalResult",
    "Eval",
    "ComputerEval",
    "rescore_experiment",
    "dataset",
    "traced",
    "wrap_openai",
    "wrap_anthropic",
    "wrap_agent",
    "exact_match",
    "contains",
    "regex_match",
    "tool_called",
    "llm_judge",
]

_current_spans: contextvars.ContextVar[list[dict[str, Any]] | None] = contextvars.ContextVar(
    "caveman_eval_spans", default=None
)
_current_parent_span: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "caveman_eval_parent_span", default=None
)


@dataclasses.dataclass
class ScoreResult:
    name: str
    value: float | None
    label: str | None = None
    rationale: str | None = None
    error: str | None = None
    source: str = "code"
    cost_usd: float | None = None
    metadata: dict[str, Any] = dataclasses.field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "name": self.name,
            "source": self.source,
            "value": self.value,
        }
        if self.label is not None:
            out["label"] = self.label
        if self.rationale is not None:
            out["rationale"] = self.rationale
        if self.error is not None:
            out["error"] = self.error
        if self.cost_usd is not None:
            out["cost_usd"] = self.cost_usd
        if self.metadata:
            out["metadata"] = self.metadata
        return out


@dataclasses.dataclass
class Span:
    span_id: str
    name: str
    kind: str
    started_at: str
    ended_at: str
    parent_id: str | None = None
    input: Any = None
    output: Any = None
    error: str | None = None
    metrics: dict[str, Any] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass
class EvalResult:
    experiment_name: str
    experiment_id: str | None
    summary: dict[str, Any]
    results: list[dict[str, Any]]
    console_url: str | None = None


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _record_span(
    name: str,
    kind: str,
    started_at: str,
    ended_at: str,
    span_id: str,
    parent_id: str | None = None,
    inp: Any = None,
    out: Any = None,
    error: str | None = None,
    metrics: dict[str, Any] | None = None,
) -> None:
    buf = _current_spans.get()
    if buf is None:
        return
    entry: dict[str, Any] = {
        "span_id": span_id,
        "name": name,
        "kind": kind,
        "started_at": started_at,
        "ended_at": ended_at,
    }
    if parent_id:
        entry["parent_id"] = parent_id
    if inp is not None:
        entry["input"] = inp
    if out is not None:
        entry["output"] = out
    if error:
        entry["error"] = error
    if metrics:
        entry["metrics"] = metrics
    buf.append(entry)


def traced(name: str, fn: Callable[..., Any], *args: Any, kind: str = "tool", **kwargs: Any) -> Any:
    """Wrap any sync or async tool/agent call so it records an inline span."""
    span_id = uuid.uuid4().hex[:16]
    parent_id = _current_parent_span.get()
    started = _iso_now()
    token = _current_parent_span.set(span_id)
    try:
        res = fn(*args, **kwargs)
        if inspect.isawaitable(res):
            async def _await_and_record() -> Any:
                try:
                    val = await res
                    _record_span(name, kind, started, _iso_now(), span_id, parent_id, {"args": args, "kwargs": kwargs}, val)
                    return val
                except Exception as exc:
                    _record_span(name, kind, started, _iso_now(), span_id, parent_id, {"args": args, "kwargs": kwargs}, error=str(exc))
                    raise
                finally:
                    _current_parent_span.reset(token)
            return _await_and_record()
        _record_span(name, kind, started, _iso_now(), span_id, parent_id, {"args": args, "kwargs": kwargs}, res)
        _current_parent_span.reset(token)
        return res
    except Exception as exc:
        _record_span(name, kind, started, _iso_now(), span_id, parent_id, {"args": args, "kwargs": kwargs}, error=str(exc))
        _current_parent_span.reset(token)
        raise


def wrap_openai(client: Any) -> Any:
    """1-line wrapper for OpenAI Python clients to auto-capture chat completion spans."""
    orig_create = client.chat.completions.create

    def wrapped_create(*args: Any, **kwargs: Any) -> Any:
        span_id = uuid.uuid4().hex[:16]
        parent_id = _current_parent_span.get()
        started = _iso_now()
        model = kwargs.get("model", "")
        try:
            resp = orig_create(*args, **kwargs)
            usage = getattr(resp, "usage", None)
            metrics: dict[str, Any] = {"model": model}
            if usage is not None:
                metrics["input_tokens"] = getattr(usage, "prompt_tokens", 0)
                metrics["output_tokens"] = getattr(usage, "completion_tokens", 0)
            out_text = None
            choices = getattr(resp, "choices", None)
            if choices:
                msg = getattr(choices[0], "message", None)
                out_text = getattr(msg, "content", None)
            _record_span(f"openai:{model}", "llm", started, _iso_now(), span_id, parent_id, kwargs.get("messages"), out_text, metrics=metrics)
            return resp
        except Exception as exc:
            _record_span(f"openai:{model}", "llm", started, _iso_now(), span_id, parent_id, kwargs.get("messages"), error=str(exc), metrics={"model": model})
            raise

    client.chat.completions.create = wrapped_create
    return client


def wrap_anthropic(client: Any) -> Any:
    """1-line wrapper for Anthropic Python clients to auto-capture messages.create spans."""
    orig_create = client.messages.create

    def wrapped_create(*args: Any, **kwargs: Any) -> Any:
        span_id = uuid.uuid4().hex[:16]
        parent_id = _current_parent_span.get()
        started = _iso_now()
        model = kwargs.get("model", "")
        try:
            resp = orig_create(*args, **kwargs)
            usage = getattr(resp, "usage", None)
            metrics: dict[str, Any] = {"model": model}
            if usage is not None:
                metrics["input_tokens"] = getattr(usage, "input_tokens", 0)
                metrics["output_tokens"] = getattr(usage, "output_tokens", 0)
            content = getattr(resp, "content", None)
            out_val = [getattr(b, "text", str(b)) for b in content] if content else None
            _record_span(f"anthropic:{model}", "llm", started, _iso_now(), span_id, parent_id, kwargs.get("messages"), out_val, metrics=metrics)
            return resp
        except Exception as exc:
            _record_span(f"anthropic:{model}", "llm", started, _iso_now(), span_id, parent_id, kwargs.get("messages"), error=str(exc), metrics={"model": model})
            raise

    client.messages.create = wrapped_create
    return client


def wrap_agent(name: str, fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap any sync, async, or generator custom agent loop to emit a nested 'agent' span."""

    def wrapped(*args: Any, **kwargs: Any) -> Any:
        span_id = uuid.uuid4().hex[:16]
        parent_id = _current_parent_span.get()
        started = _iso_now()
        inp = args[0] if len(args) == 1 and not kwargs else {"args": args, "kwargs": kwargs}
        token = _current_parent_span.set(span_id)
        try:
            res = fn(*args, **kwargs)
            if inspect.isawaitable(res):
                async def _await_agent() -> Any:
                    try:
                        val = await res
                        _record_span(name, "agent", started, _iso_now(), span_id, parent_id, inp, val)
                        return val
                    except Exception as exc:
                        _record_span(name, "agent", started, _iso_now(), span_id, parent_id, inp, error=str(exc))
                        raise
                    finally:
                        _current_parent_span.reset(token)
                return _await_agent()
            if inspect.isgenerator(res):
                chunks = list(res)
                combined: Any = "".join(chunks) if all(isinstance(c, str) for c in chunks) else chunks
                _record_span(name, "agent", started, _iso_now(), span_id, parent_id, inp, combined, metrics={"chunks": len(chunks)})
                _current_parent_span.reset(token)
                return combined
            _record_span(name, "agent", started, _iso_now(), span_id, parent_id, inp, res)
            _current_parent_span.reset(token)
            return res
        except Exception as exc:
            _record_span(name, "agent", started, _iso_now(), span_id, parent_id, inp, error=str(exc))
            _current_parent_span.reset(token)
            raise

    return wrapped


# ---- Built-in lightweight scorer helpers -----------------------------------

def exact_match(name: str = "exact_match", ignore_case: bool = False) -> Callable[..., ScoreResult]:
    def _score(output: Any, expected: Any = None, **_: Any) -> ScoreResult:
        if expected is None:
            return ScoreResult(name=name, value=None, label="N/A", rationale="no expected value")
        a, b = str(output).strip(), str(expected).strip()
        if ignore_case:
            a, b = a.lower(), b.lower()
        ok = a == b
        return ScoreResult(name=name, value=1.0 if ok else 0.0, label="Pass" if ok else "Fail")
    return _score


def contains(substrings: Sequence[str], name: str = "contains", ignore_case: bool = True) -> Callable[..., ScoreResult]:
    def _score(output: Any, **_: Any) -> ScoreResult:
        text = str(output)
        hay = text.lower() if ignore_case else text
        missing = [s for s in substrings if (s.lower() if ignore_case else s) not in hay]
        ok = len(missing) == 0
        return ScoreResult(
            name=name,
            value=1.0 if ok else 0.0,
            label="Pass" if ok else "Fail",
            rationale=None if ok else f"missing: {', '.join(missing)}",
        )
    return _score


def regex_match(pattern: str, name: str = "regex_match") -> Callable[..., ScoreResult]:
    compiled = re.compile(pattern)

    def _score(output: Any, **_: Any) -> ScoreResult:
        ok = compiled.search(str(output)) is not None
        return ScoreResult(name=name, value=1.0 if ok else 0.0, label="Pass" if ok else "Fail")
    return _score


def tool_called(tools: Sequence[str], name: str = "tool_called") -> Callable[..., ScoreResult]:
    want = list(tools)

    def _score(spans: Sequence[dict[str, Any]] | None = None, output: Any = None, **_: Any) -> ScoreResult:
        called = {s.get("name") for s in (spans or []) if s.get("kind") == "tool"}
        if isinstance(output, dict) and isinstance(output.get("tool_calls"), list):
            for tc in output["tool_calls"]:
                if isinstance(tc, dict) and tc.get("name"):
                    called.add(tc["name"])
        missing = [t for t in want if t not in called]
        ok = len(missing) == 0
        return ScoreResult(
            name=name,
            value=1.0 if ok else 0.0,
            label="Pass" if ok else "Fail",
            rationale=None if ok else f"tools not called: {', '.join(missing)}",
        )
    return _score


def llm_judge(
    *,
    name: str,
    model: str,
    prompt: str,
    choices: Sequence[dict[str, Any]] | None = None,
    use_cot: bool = True,
    gateway_url: str | None = None,
    api_key: str | None = None,
) -> Callable[..., ScoreResult]:
    rubric = list(choices or [{"label": "Pass", "value": 1.0}, {"label": "Fail", "value": 0.0}])
    by_lower = {c["label"].strip().lower(): c for c in rubric}

    def _score(input: Any = None, output: Any = None, expected: Any = None, **_: Any) -> ScoreResult:
        base = (gateway_url or os.environ.get("CAVEMAN_GATEWAY_URL") or os.environ.get("OPENAI_BASE_URL") or "").rstrip("/")
        key = api_key or os.environ.get("CAVEMAN_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
        if not base:
            return ScoreResult(name=name, value=None, source="llm", error="CAVEMAN_GATEWAY_URL not set for llm_judge")
        labels = [c["label"] for c in rubric]
        body = {
            "model": model,
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": 'Return JSON {"rationale":"...","choice":"<label>"} with no markdown.' if use_cot else 'Return JSON {"choice":"<label>","rationale":"..."}.',
                },
                {
                    "role": "user",
                    "content": f"Criteria: {prompt}\nAllowed choices: {json.dumps(rubric)}\nInput: {json.dumps(input)}\nOutput: {json.dumps(output)}\nExpected: {json.dumps(expected)}",
                },
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "caveman_eval_judge",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "rationale": {"type": "string"},
                            "choice": {"type": "string", "enum": labels},
                        },
                        "required": ["rationale", "choice"],
                        "additionalProperties": False,
                    },
                },
            },
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}", "x-cave-optimize": "off"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                cost_hdr = resp.headers.get("x-cave-cost-usd")
                cost = float(cost_hdr) if cost_hdr else None
        except Exception as exc:
            return ScoreResult(name=name, value=None, source="llm", error=str(exc))
        try:
            content = data["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            choice = by_lower[parsed["choice"].strip().lower()]
            return ScoreResult(
                name=name,
                value=float(choice["value"]),
                label=choice["label"],
                rationale=parsed.get("rationale"),
                source="llm",
                cost_usd=cost,
            )
        except Exception as exc:
            return ScoreResult(name=name, value=None, source="llm", error=f"invalid judge output: {exc}")

    return _score


# ---- Cloud API helper & dataset loader -------------------------------------

class _CloudClient:
    def __init__(self, api_url: str, api_key: str, project_id: str | None = None) -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.prefix = f"/api/v1/projects/{project_id}/evals" if project_id else "/api/v1/evals"

    def request(self, method: str, path: str, body: Any = None) -> Any:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            f"{self.api_url}{self.prefix}{path}",
            data=data,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Caveman API {method} {path} failed ({exc.code}): {detail}") from exc


def dataset(name: str, *, version: int | None = None) -> dict[str, Any]:
    """Reference a named dataset in Caveman Cloud."""
    return {"__caveman_dataset__": True, "name": name, "version": version}


def _git_info() -> dict[str, str]:
    info: dict[str, str] = {}
    for key, cmd in (("git_sha", ["git", "rev-parse", "--short", "HEAD"]), ("git_branch", ["git", "rev-parse", "--abbrev-ref", "HEAD"])):
        try:
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True).strip()
            if out:
                info[key] = out
        except Exception:
            pass
    return info


def _compute_local_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    per_scorer_items: dict[str, dict[str, list[float]]] = {}
    per_scorer_all: dict[str, list[float]] = {}
    for r in results:
        for s in r.get("scores", []):
            v = s.get("value")
            if v is None:
                continue
            name = s["name"]
            per_scorer_all.setdefault(name, []).append(float(v))
            per_scorer_items.setdefault(name, {}).setdefault(r["item_key"], []).append(float(v))
    scores_summary: dict[str, Any] = {}
    for name, vals in per_scorer_all.items():
        by_item = per_scorer_items[name]
        pass_at_k = sum(1 for tv in by_item.values() if any(x >= 0.5 for x in tv)) / len(by_item)
        pass_pow_k = sum(1 for tv in by_item.values() if all(x >= 0.5 for x in tv)) / len(by_item)
        scores_summary[name] = {
            "mean": sum(vals) / len(vals),
            "pass_at_k": pass_at_k,
            "pass_pow_k": pass_pow_k,
            "count": len(vals),
        }
    return {"total_trials": len(results), "scores": scores_summary}


def _coerce_scores(raw: Any) -> list[ScoreResult]:
    if raw is None:
        return []
    if isinstance(raw, ScoreResult):
        return [raw]
    if isinstance(raw, dict):
        return [ScoreResult(**raw)]
    if isinstance(raw, (list, tuple)):
        out: list[ScoreResult] = []
        for x in raw:
            out.extend(_coerce_scores(x))
        return out
    raise TypeError(f"Unsupported score return type: {type(raw)}")


def _run_maybe_async(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    res = fn(*args, **kwargs)
    if inspect.isawaitable(res):
        return asyncio.run(res)
    return res


def Eval(
    name: str,
    *,
    data: Iterable[dict[str, Any]] | dict[str, Any],
    task: Callable[..., Any],
    scorers: Sequence[Callable[..., Any]] = (),
    trials: int = 1,
    concurrency: int = 5,
    baseline: str | None = None,
    metadata: dict[str, Any] | None = None,
    api_url: str | None = None,
    api_key: str | None = None,
    project_id: str | None = None,
    local_cache_path: str | Path = ".caveman/last-run.json",
) -> EvalResult:
    """Run a local-first, Cloud-synced evaluation experiment."""
    key = api_key or os.environ.get("CAVEMAN_API_KEY", "")
    url = api_url or os.environ.get("CAVEMAN_API_URL", "https://api.caveman.so")
    proj = project_id or os.environ.get("CAVEMAN_PROJECT_ID")
    cloud = _CloudClient(url, key, proj) if key else None

    dataset_id: str | None = None
    dataset_version: int | None = None
    rows: list[dict[str, Any]]
    if isinstance(data, dict) and data.get("__caveman_dataset__"):
        if cloud is None:
            raise RuntimeError("CAVEMAN_API_KEY is required to load a Cloud dataset.")
        ds_list = cloud.request("GET", "/datasets").get("datasets", [])
        match = next((d for d in ds_list if d["name"] == data["name"]), None)
        if match is None:
            raise RuntimeError(f"Dataset {data['name']!r} not found.")
        dataset_id = match["id"]
        q = f"?version={data['version']}" if data.get("version") else ""
        items_resp = cloud.request("GET", f"/datasets/{dataset_id}/items{q}")
        dataset_version = items_resp.get("version")
        rows = items_resp.get("items", [])
    else:
        rows = list(data)

    exp_id: str | None = None
    if cloud is not None:
        exp_payload: dict[str, Any] = {
            "name": name,
            "mode": "sdk",
            "trials": trials,
            "concurrency": concurrency,
            "target": _git_info(),
            "metadata": metadata or {},
        }
        if dataset_id:
            exp_payload["dataset_id"] = dataset_id
        if dataset_version:
            exp_payload["dataset_version"] = dataset_version
        created = cloud.request("POST", "/experiments", exp_payload)
        exp_id = created["id"]

    work: list[tuple[str, int, dict[str, Any]]] = []
    for idx, row in enumerate(rows):
        item_key = str(row.get("item_key") or row.get("id") or f"case-{idx + 1}")
        for t in range(1, trials + 1):
            work.append((item_key, t, row))

    def _run_one(item_key: str, trial: int, row: dict[str, Any]) -> dict[str, Any]:
        inp = row.get("input", row)
        expected = row.get("expected")
        spans_buf: list[dict[str, Any]] = []
        tok_s = _current_spans.set(spans_buf)
        tok_p = _current_parent_span.set(None)
        t0 = time.perf_counter()
        output = None
        err_msg: str | None = None
        try:
            output = _run_maybe_async(task, inp)
        except Exception as exc:
            err_msg = str(exc)
        finally:
            _current_spans.reset(tok_s)
            _current_parent_span.reset(tok_p)
        duration_ms = int((time.perf_counter() - t0) * 1000)

        scored: list[dict[str, Any]] = []
        if err_msg is None:
            for sc_fn in scorers:
                try:
                    raw = _run_maybe_async(sc_fn, input=inp, output=output, expected=expected, spans=spans_buf, metadata=row.get("metadata", {}))
                    for sr in _coerce_scores(raw):
                        scored.append(sr.to_dict())
                except Exception as exc:
                    scored.append(ScoreResult(name=getattr(sc_fn, "__name__", "scorer"), value=None, error=str(exc)).to_dict())

        in_tok = sum(int(s.get("metrics", {}).get("input_tokens", 0)) for s in spans_buf)
        out_tok = sum(int(s.get("metrics", {}).get("output_tokens", 0)) for s in spans_buf)
        return {
            "item_key": item_key,
            "trial": trial,
            "status": "error" if err_msg else "completed",
            "input": inp,
            "output": output,
            "expected": expected,
            "error": err_msg,
            "spans": spans_buf,
            "metrics": {"duration_ms": duration_ms, "input_tokens": in_tok, "output_tokens": out_tok},
            "scores": scored,
        }

    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        futs = [pool.submit(_run_one, k, tr, rw) for k, tr, rw in work]
        for fut in as_completed(futs):
            results.append(fut.result())
    results.sort(key=lambda r: (r["item_key"], r["trial"]))

    summary = _compute_local_summary(results)
    console_url: str | None = None
    if cloud is not None and exp_id is not None:
        for i in range(0, len(results), 50):
            cloud.request("POST", f"/experiments/{exp_id}/results", {"results": results[i : i + 50]})
        comp_body: dict[str, Any] = {}
        if baseline:
            comp_body["baseline"] = baseline
        completed = cloud.request("POST", f"/experiments/{exp_id}/complete", comp_body)
        summary = completed.get("experiment", {}).get("summary", summary)
        console_url = f"{url.replace('api.', 'app.')}/experiments/runs/{exp_id}"

    # Persist local last-run snapshot for offline diffs.
    try:
        cache_file = Path(local_cache_path)
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps({"name": name, "summary": summary, "results": results}, indent=2))
    except Exception:
        pass

    return EvalResult(experiment_name=name, experiment_id=exp_id, summary=summary, results=results, console_url=console_url)


def ComputerEval(
    name: str,
    *,
    dataset_name: str,
    target: dict[str, Any],
    scorer_ids: Sequence[str] = (),
    trials: int = 1,
    concurrency: int = 5,
    item_keys: Sequence[str] | None = None,
    tags: Sequence[str] | None = None,
    baseline: str | None = None,
    wait: bool = True,
    poll_interval_s: float = 3.0,
    api_url: str | None = None,
    api_key: str | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    """Launch a hosted isolated-computer agent experiment on Caveman Cloud."""
    key = api_key or os.environ.get("CAVEMAN_API_KEY", "")
    if not key:
        raise RuntimeError("CAVEMAN_API_KEY is required for ComputerEval().")
    url = api_url or os.environ.get("CAVEMAN_API_URL", "https://api.caveman.so")
    proj = project_id or os.environ.get("CAVEMAN_PROJECT_ID")
    cloud = _CloudClient(url, key, proj)

    ds_list = cloud.request("GET", "/datasets").get("datasets", [])
    match = next((d for d in ds_list if d["name"] == dataset_name), None)
    if match is None:
        raise RuntimeError(f"Dataset {dataset_name!r} not found.")

    payload: dict[str, Any] = {
        "name": name,
        "mode": "computer",
        "dataset_id": match["id"],
        "trials": trials,
        "concurrency": concurrency,
        "scorer_ids": list(scorer_ids),
        "target": {**_git_info(), **target},
    }
    if item_keys:
        payload["item_keys"] = list(item_keys)
    if tags:
        payload["tags"] = list(tags)
    if baseline:
        payload["baseline_experiment_id"] = baseline

    exp = cloud.request("POST", "/experiments", payload)
    if not wait:
        return exp
    while exp.get("status") in ("queued", "running"):
        time.sleep(poll_interval_s)
        exp = cloud.request("GET", f"/experiments/{exp['id']}")
    return exp


def rescore_experiment(
    experiment_id: str,
    *,
    scorer_ids: Sequence[str],
    api_url: str | None = None,
    api_key: str | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    """Re-score an existing experiment with saved LLM judges without re-running agents."""
    key = api_key or os.environ.get("CAVEMAN_API_KEY", "")
    if not key:
        raise RuntimeError("CAVEMAN_API_KEY is required for rescore_experiment().")
    url = api_url or os.environ.get("CAVEMAN_API_URL", "https://api.caveman.so")
    proj = project_id or os.environ.get("CAVEMAN_PROJECT_ID")
    cloud = _CloudClient(url, key, proj)
    return cloud.request("POST", f"/experiments/{experiment_id}/rescore", {"scorer_ids": list(scorer_ids)})
