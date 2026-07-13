# Maintrail architecture

## Product invariant

Maintrail is an external thinking tree. A mainline is one piece of work; a
session is only a read-only source and a cursor into that tree. Killing a
session cannot kill its object. Starting a replacement session must not create
a replacement object.

The three-second contract is answered in this order:

1. **What needs me now?** The now bar exposes decisions, replies, blockers, and
   newly completed work before the map asks for navigation.
2. **Where was the thought?** Stable mainlines, dead attempts, close reasons,
   and cursors reconstruct the path without requiring recall.
3. **How do I get back?** Every session affordance either focuses a live
   terminal or resumes a closed one. Entries fade; they do not disappear.

## Authority split

The model owns open semantics: mainline assignment, structural change,
turning-point detection, and the meaning of an ask. Runtime code must never
replace those judgments with cwd, keywords, or regexes.

The runtime owns closed boundaries: ids, schema, subtree authorization,
single-writer serialization, offsets, atomic persistence, idempotency policy,
and every side effect. Model output is untrusted input.

## Persistence and delivery semantics

`state.json` contains both the thinking tree and transcript offsets. Every
write uses a private temporary file, `fsync`, and atomic rename. Corrupt files
are quarantined; repairable references are pruned without deleting surviving
objects.

Roll delivery is deliberately at-most-once. A valid model response is obtained,
then its source offset is committed, then operations are applied. A crash in
the narrow middle window can lose one structural increment; it cannot repeat a
non-idempotent `grow`.

## Bounded work

Each source read is capped at 4 MiB. Lines over 2 MiB are skipped. The semantic
delta is capped at 12 KiB, the current subtree at 120 lines, and a session rolls
at most once every 45 seconds. Only the 60 most recently active transcript
sessions are watched. Standard, environment-selected, and Orca-managed Codex
homes are deduplicated by provider and session id; a durable offset follows the
logical session when an identical WAL is mirrored under another path.

## Object permanence and archive

Resolved and dead nodes remain facts. Archive moves a mainline out of the
reading budget without stopping ingestion or deleting it. Session actions use
a deterministic fallback ladder: Orca terminal, native terminal focus, then a
new terminal running the provider's resume command.

## Local security boundary

The server binds only to `127.0.0.1`. Every API call requires a 0600 capability
token injected into the root page. State-changing requests additionally require
an allowed loopback origin, strict JSON media type, a 64 KiB content limit, and
an object body. Transcript files are never opened for writing.
