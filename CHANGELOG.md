# Changelog

## Unreleased
- Changed interactive startup without `--session` to create `default` only for empty projects and otherwise prompt for an existing or new session.
- Refined cache benchmarking to split real provider cost comparisons from deterministic adaptive controller cases, added `auto-frozen`, and changed default effective cost reporting to input-only.
