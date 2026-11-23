import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from caveman_evals import (
    Eval,
    ScoreResult,
    contains,
    exact_match,
    tool_called,
    traced,
    wrap_agent,
    wrap_openai,
)


class FakeOpenAI:
    def __init__(self) -> None:
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self._create),
        )

    def _create(self, **kwargs):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="refund $12 processed"))],
            usage=SimpleNamespace(prompt_tokens=40, completion_tokens=10),
        )


class TestCavemanEvalsPy(unittest.TestCase):
    def test_local_eval_with_wrappers_and_trials(self) -> None:
        client = wrap_openai(FakeOpenAI())

        def task(inp):
            order = traced("lookup_order", lambda oid: {"id": oid, "amount": 12}, inp["order_id"])
            res = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": f"Refund {order['amount']}"}],
            )
            return res.choices[0].message.content

        with tempfile.TemporaryDirectory() as tmp:
            res = Eval(
                "support-py",
                data=[
                    {"item_key": "t1", "input": {"order_id": "o1"}, "expected": "refund $12 processed"},
                    {"item_key": "t2", "input": {"order_id": "o2"}, "expected": "refund $12 processed"},
                ],
                task=task,
                scorers=[
                    exact_match(),
                    contains(["$12"]),
                    tool_called(["lookup_order"]),
                ],
                trials=2,
                concurrency=2,
                local_cache_path=Path(tmp) / "last-run.json",
            )
            self.assertEqual(len(res.results), 4)
            self.assertEqual(res.summary["scores"]["exact_match"]["mean"], 1.0)
            self.assertEqual(res.summary["scores"]["tool_called"]["pass_pow_k"], 1.0)
            # Verify inline spans captured both lookup_order tool and openai LLM call
            kinds = [s["kind"] for s in res.results[0]["spans"]]
            self.assertIn("tool", kinds)
            self.assertIn("llm", kinds)
            self.assertEqual(res.results[0]["metrics"]["input_tokens"], 40)

    def test_wrap_agent_records_nested_agent_and_generator_spans(self) -> None:
        @lambda f: wrap_agent("stream_agent", f)
        def stream_agent(prompt: str):
            yield "hello "
            yield prompt

        with tempfile.TemporaryDirectory() as tmp:
            res = Eval(
                "agent-py",
                data=[{"item_key": "g1", "input": "world", "expected": "hello world"}],
                task=stream_agent,
                scorers=[exact_match()],
                local_cache_path=Path(tmp) / "last-run.json",
            )
            self.assertEqual(res.summary["scores"]["exact_match"]["mean"], 1.0)
            spans = res.results[0]["spans"]
            self.assertEqual(len(spans), 1)
            self.assertEqual(spans[0]["kind"], "agent")
            self.assertEqual(spans[0]["metrics"]["chunks"], 2)


if __name__ == "__main__":
    unittest.main()
