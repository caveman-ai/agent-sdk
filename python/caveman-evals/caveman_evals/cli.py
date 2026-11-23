"""CLI entrypoint for `caveman-eval` (Python)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    files = [a for a in args if not a.startswith("--")]
    if not files:
        print("Usage: caveman-eval <file_eval.py...>", file=sys.stderr)
        return 2
    for file_path in files:
        path = Path(file_path).resolve()
        spec = importlib.util.spec_from_file_location(path.stem, path)
        if spec is None or spec.loader is None:
            print(f"Cannot load {file_path}", file=sys.stderr)
            return 2
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if hasattr(mod, "run") and callable(mod.run):
            res = mod.run()
            if getattr(res, "summary", None):
                print(f"\nCaveman Eval: {res.experiment_name}")
                for name, s in res.summary.get("scores", {}).items():
                    print(f"  {name:24s} mean={s['mean']*100:.1f}%  pass@k={s['pass_at_k']*100:.1f}%  pass^k={s['pass_pow_k']*100:.1f}%")
                if res.console_url:
                    print(f"  Diff -> {res.console_url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
