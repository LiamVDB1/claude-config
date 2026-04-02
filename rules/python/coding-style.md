---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with Python specific content.

## Virtual Environment

Always prefer `.venv` when present:

- Before running any Python command (`python`, `pip`, `pytest`, `ruff`, etc.), check if a `.venv` directory exists in the project root.
- If `.venv` exists, use `.venv/bin/python` (or `.venv/Scripts/python` on Windows) instead of the system `python`.
- Activate via `source .venv/bin/activate` or invoke binaries directly from `.venv/bin/`.

## Standards

- Follow **PEP 8** conventions
- Use **type annotations** on all function signatures

## Immutability

Prefer immutable data structures:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class User:
    name: str
    email: str

from typing import NamedTuple

class Point(NamedTuple):
    x: float
    y: float
```

## Formatting

- **black** for code formatting
- **isort** for import sorting
- **ruff** for linting

## Testing

Use **pytest** as the testing framework. Categorize with `pytest.mark` (unit, integration).
