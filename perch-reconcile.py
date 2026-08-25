#!/usr/bin/env python3
"""Rebuild Perch turn history from provider-owned JSONL metadata.

The provider files are historical authority.  Perch hook events are only a
real-time coverage signal.  Every emitted turn is therefore explicitly marked
as reconstructed, and both output files are disposable derived caches.

This module deliberately ignores prompt and response bodies.  It consumes only
session, turn, lifecycle, timestamp, and cwd fields.
"""

from __future__ import annotations

import argparse
import base64
import bisect
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCHEMA_VERSION = 1
SOURCES = ("codex", "claude")
HOOK_TOLERANCE = timedelta(seconds=30)
MAX_PUBLISH_BYTES = 4 * 1024 * 1024
MAX_HOOK_SNAPSHOT_BYTES = 8 * 1024 * 1024
# File mtime is an I/O filter, never historical authority.  A one-day margin
# keeps clock corrections / copied files near the requested boundary from
# being skipped; records are still filtered by their own provider timestamp.
FILE_MTIME_MARGIN = timedelta(days=1)
# Resuming a Codex session opens a new rollout file and replays the whole prior
# conversation into it: the earlier session_meta rows come along, and every past
# turn is re-emitted carrying the instant of the replay instead of the instant
# it ran.  A file holding more than one session_meta is therefore a resume, and
# inside it a "turn" that begins and ends within one write burst is a copy of
# history, not work.  Measured over this machine's 204 rollouts: 74% of turns in
# resumed files are that degenerate, against 1.3% in single-session files.
REPLAY_BURST = timedelta(seconds=1)
CODEX_METADATA_LINE = re.compile(
    rb'^\{\s*"timestamp"\s*:\s*"[^"]+"\s*,\s*"type"\s*:\s*'
    rb'(?:(?:"session_meta"|"turn_context")|'
    rb'"event_msg"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*'
    rb'"(?:task_started|task_complete|turn_aborted)")'
)
CLAUDE_LIFECYCLE_LINE = re.compile(
    rb'^\{.{0,1024}?"type"\s*:\s*"(?:user|assistant)"', re.DOTALL)
CODEX_RG_PATTERN = (
    r'^\{\s*"timestamp"\s*:\s*"[^"]+"\s*,\s*"type"\s*:\s*'
    r'(("session_meta"|"turn_context")|'
    r'"event_msg"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*'
    r'"(task_started|task_complete|turn_aborted)")'
)
CLAUDE_RG_PATTERN = r'^\{.{0,1024}"type"\s*:\s*"(user|assistant)"'


def _find_rg():
    candidates = [shutil.which("rg"), "/opt/homebrew/bin/rg", "/usr/local/bin/rg"]
    return next((value for value in candidates if value and Path(value).is_file()), None)


RG = _find_rg()


def _codex_metadata_line(payload):
    return CODEX_METADATA_LINE.search(payload[:4096]) is not None


def _claude_lifecycle_line(payload):
    return CLAUDE_LIFECYCLE_LINE.search(payload[:2048]) is not None


JSON_STRING = rb'"((?:\\.|[^"\\])*)"'


def _field_string(payload, name):
    match = re.search(rb'"' + name.encode("ascii") + rb'"\s*:\s*' + JSON_STRING, payload)
    if match is None:
        return None
    try:
        return json.loads((b'"' + match.group(1) + b'"').decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("invalid JSON string field %s" % name)


def _edge_field(head, tail, name):
    return _field_string(head, name) or _field_string(tail, name)


def _last_field_string(payload, name):
    matches = list(re.finditer(
        rb'"' + name.encode("ascii") + rb'"\s*:\s*' + JSON_STRING, payload))
    if not matches:
        return None
    try:
        return json.loads((b'"' + matches[-1].group(1) + b'"').decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("invalid JSON string field %s" % name)


def _parse_codex_metadata(payload):
    head = payload[:4096]
    record_type = _field_string(head, "type")
    timestamp = _field_string(head, "timestamp")
    if record_type in ("session_meta", "turn_context"):
        body = head[head.find(b'"payload"'):]
        fields = {}
        if record_type == "session_meta":
            fields["id"] = _field_string(body, "id")
        else:
            fields["turn_id"] = _field_string(body, "turn_id")
        fields["cwd"] = _field_string(body, "cwd")
        return {"timestamp": timestamp, "type": record_type, "payload": fields}
    if record_type == "event_msg":
        body = head[head.find(b'"payload"'):]
        marker = _field_string(body, "type")
        if marker not in ("task_started", "task_complete", "turn_aborted"):
            raise ValueError("unexpected Codex event marker")
        fields = {
            "type": marker,
            "turn_id": _field_string(body, "turn_id"),
            "reason": _field_string(body, "reason"),
        }
        return {"timestamp": timestamp, "type": record_type, "payload": fields}
    raise ValueError("unsupported Codex lifecycle row")


def _parse_claude_lifecycle(payload):
    # Top-level identity fields sit before the potentially huge message body;
    # stop_reason / cwd / error flags sit near its end. Searching a bounded
    # head+tail keeps the parser metadata-only and avoids allocating the body.
    head = payload[:8192]
    tail = payload[-8192:]
    record_type = _field_string(head, "type")
    if record_type not in ("user", "assistant"):
        record_type = _last_field_string(tail, "type")
    if record_type not in ("user", "assistant"):
        # The rg pattern can see a nested assistant/user type inside a different
        # top-level record. It is an irrelevant false positive, not provider
        # corruption; return an empty record for the reducer to ignore.
        return {}
    record = {
        "type": record_type,
        "sessionId": _edge_field(head, tail, "sessionId"),
        "promptId": _edge_field(head, tail, "promptId"),
        "uuid": _edge_field(head, tail, "uuid"),
        "timestamp": _edge_field(head, tail, "timestamp"),
        "cwd": _edge_field(head, tail, "cwd"),
        "isMeta": (b'"isMeta":true' in head or b'"isMeta": true' in head
                   or b'"isMeta":true' in tail or b'"isMeta": true' in tail),
        "isSidechain": (
            b'"isSidechain":true' in head or b'"isSidechain": true' in head),
        "sourceToolAssistantUUID": _edge_field(head, tail, "sourceToolAssistantUUID"),
        "isApiErrorMessage": (
            b'"isApiErrorMessage":true' in tail or b'"isApiErrorMessage": true' in tail),
    }
    if b'"toolUseResult"' in head or b'"toolUseResult"' in tail:
        record["toolUseResult"] = True

    if record_type == "user":
        content = re.search(
            rb'"message"\s*:\s*\{.{0,2048}?"content"\s*:\s*(["\[])',
            head, re.DOTALL)
        if content is None:
            raise ValueError("Claude user row has no message content")
        if content.group(1) == b'"':
            message_content = "present"
        else:
            kinds = [
                value.decode("ascii")
                for value in re.findall(rb'"type"\s*:\s*"(text|image|tool_result)"', head)
            ]
            message_content = [{"type": value} for value in kinds]
        record["message"] = {"content": message_content}
    else:
        record["message"] = {"stop_reason": _field_string(tail, "stop_reason")}
    return record


def _parse_timestamp(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _timestamp_text(value, fallback=None):
    parsed = _parse_timestamp(value)
    if parsed is None:
        parsed = _parse_timestamp(fallback)
    if parsed is None:
        return None
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _stable_unknown_id(path):
    digest = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:16]
    return "unknown-" + digest


def _normalise_project(value):
    if not value:
        return "unknown"
    return os.path.normpath(str(value))


def _jsonl_paths(root, codex=False):
    root = Path(root)
    if not root.exists():
        return []
    pattern = "rollout-*.jsonl" if codex else "*.jsonl"
    return sorted(path for path in root.rglob(pattern) if path.is_file())


def _paths_for_window(root, codex=False, modified_since=None):
    available = _jsonl_paths(root, codex=codex)
    threshold = _parse_timestamp(modified_since)
    if threshold is None:
        return available, available
    cutoff = (threshold - FILE_MTIME_MARGIN).timestamp()
    selected = []
    for path in available:
        try:
            modified_at = path.stat().st_mtime
        except OSError:
            # The file disappeared between discovery and stat.  The read pass
            # would be unable to consume it anyway; the next periodic rebuild
            # rediscovers from scratch.
            continue
        if modified_at >= cutoff:
            selected.append(path)
    return available, selected


def _unterminated_tail(path):
    """Return the final non-newline-terminated row without reading the file."""
    with Path(path).open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        end = handle.tell()
        if end == 0:
            return None
        handle.seek(end - 1)
        if handle.read(1) in (b"\n", b"\r"):
            return None
        chunks = []
        cursor = end
        while cursor > 0:
            size = min(65536, cursor)
            cursor -= size
            handle.seek(cursor)
            chunk = handle.read(size)
            at = max(chunk.rfind(b"\n"), chunk.rfind(b"\r"))
            if at >= 0:
                chunks.append(chunk[at + 1:])
                break
            chunks.append(chunk)
        return b"".join(reversed(chunks))


def _candidate_lines(path, rg_pattern=None):
    if rg_pattern is None or RG is None:
        with Path(path).open("rb") as handle:
            yield from handle
        return
    with subprocess.Popen(
        [RG, "--no-filename", "-N", "--color", "never", "-e", rg_pattern, str(path)],
        stdout=subprocess.PIPE,
    ) as process:
        assert process.stdout is not None
        yield from process.stdout
        code = process.wait()
        if code not in (0, 1):
            raise OSError("ripgrep prefilter failed for %s (exit %d)" % (path, code))


def _read_jsonl(path, include_line=None, rg_pattern=None, parse_line=None):
    """Return complete JSON records plus explicit corruption diagnostics.

    A valid last line is accepted even without a newline.  An invalid last
    line without a newline is assumed to be an in-progress append and deferred;
    malformed complete or middle lines count as parse errors.
    """

    records = []
    parse_errors = 0
    partial_lines = 0
    partial_payload = _unterminated_tail(path)
    if partial_payload:
        try:
            json.loads(partial_payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            partial_lines = 1

    lines = iter(_candidate_lines(path, rg_pattern=rg_pattern))
    try:
        previous = next(lines, None)
        while previous is not None:
            raw = previous
            previous = next(lines, None)
            is_last = previous is None
            terminated = raw.endswith(b"\n") or raw.endswith(b"\r")
            payload = raw.rstrip(b"\r\n")
            if not payload.strip():
                continue
            # Provider JSONL rows can carry megabytes of response body. The
            # lifecycle reducer has no business decoding those rows: stream
            # the file and JSON-decode only lines that can contain a marker we
            # consume. False positives are harmless (the reducer ignores them);
            # the regex permits normal JSON whitespace so pretty/compact
            # encoders have the same contract.
            included = include_line is None or include_line(payload)
            if (not included
                    and not (is_last and not terminated)):
                continue
            try:
                record = (parse_line(payload) if parse_line is not None
                          else json.loads(payload.decode("utf-8")))
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                if partial_payload is not None and payload == partial_payload:
                    partial_lines = 1
                else:
                    parse_errors += 1
                continue
            if not included:
                # A complete, valid but irrelevant final row was parsed only to
                # distinguish it from an in-progress append. It remains outside
                # the lifecycle reducer.
                continue
            if isinstance(record, dict):
                records.append(record)
            else:
                parse_errors += 1
    finally:
        close = getattr(lines, "close", None)
        if close is not None:
            close()
    return records, parse_errors, partial_lines


def _merge_provenance(turn, path):
    paths = turn["provenance"]["paths"]
    text = str(path)
    if text not in paths:
        paths.append(text)
        paths.sort()


def _new_turn(source, session_id, turn_id, project, started_at, kind, path):
    return {
        "schema_version": SCHEMA_VERSION,
        "record_kind": "turn",
        "record_id": "%s:%s:%s" % (source, session_id, turn_id),
        "source": source,
        "session_id": session_id,
        "turn_id": turn_id,
        "project": _normalise_project(project),
        "started_at": started_at,
        "ended_at": None,
        "outcome": "open",
        "reconstructed": True,
        "provenance": {"kind": kind, "paths": [str(path)]},
    }


def _merge_turn(existing, incoming):
    if existing is None:
        return incoming
    if incoming.get("started_at") and (
        not existing.get("started_at") or incoming["started_at"] < existing["started_at"]
    ):
        existing["started_at"] = incoming["started_at"]
    if existing.get("project") == "unknown" and incoming.get("project") != "unknown":
        existing["project"] = incoming["project"]
    incoming_end = incoming.get("ended_at")
    if incoming_end and (not existing.get("ended_at") or incoming_end >= existing["ended_at"]):
        existing["ended_at"] = incoming_end
        existing["outcome"] = incoming["outcome"]
    for path in incoming["provenance"]["paths"]:
        _merge_provenance(existing, path)
    return existing


def _is_replayed_turn(turn):
    """True when a turn began and ended inside one write burst.

    Only meaningful inside a resumed rollout (see REPLAY_BURST).  A turn still
    waiting for its terminal event is NOT judged here: an open turn carries no
    span to measure, and guessing would be the invented end this whole change
    exists to remove."""
    started = _parse_timestamp(turn.get("started_at"))
    ended = _parse_timestamp(turn.get("ended_at"))
    if started is None or ended is None:
        return False
    return ended - started < REPLAY_BURST


def scan_codex(root, modified_since=None):
    """Reconstruct turns from Codex ``rollout-*.jsonl`` files without reading conversation bodies.

    A missing ``root`` returns an empty result. ``modified_since`` uses file
    modification times only to prune the scan; an unparseable value is treated
    as no boundary. The caller still decides whether turns fall inside its
    settlement window using provider timestamps. Replayed turns in a resumed
    session must not overwrite their original end times, and turns without a
    terminal event remain ``open`` rather than receiving an inferred end.

    Returns a turn mapping keyed by stable ``record_id`` plus scan diagnostics.
    Complete malformed rows count as ``parse_errors``; an incomplete tail still
    being appended counts only as ``partial_lines``.
    """
    turns = {}
    available, selected = _paths_for_window(root, codex=True, modified_since=modified_since)
    diagnostics = {
        "files_available": len(available),
        "files_scanned": 0,
        "parse_errors": 0,
        "partial_lines": 0,
        "replayed_turns_skipped": 0,
    }
    for path in selected:
        records, errors, partials = _read_jsonl(
            path,
            include_line=_codex_metadata_line,
            rg_pattern=CODEX_RG_PATTERN,
            parse_line=_parse_codex_metadata,
        )
        diagnostics["files_scanned"] += 1
        diagnostics["parse_errors"] += errors
        diagnostics["partial_lines"] += partials

        session_id = None
        session_project = "unknown"
        session_meta_rows = 0
        projects_by_turn = {}
        for record in records:
            if record.get("type") == "session_meta":
                payload = record.get("payload") or {}
                session_meta_rows += 1
                # The FIRST row is the file's own identity; later ones were
                # replayed in from the sessions this one resumed.  Reading the
                # last row filed a resumed file under someone else's session id,
                # which is how replayed turns collided with the originals.
                if session_id is None:
                    session_id = payload.get("id") or payload.get("session_id")
                    session_project = payload.get("cwd") or session_project
            elif record.get("type") == "turn_context":
                payload = record.get("payload") or {}
                turn_id = payload.get("turn_id")
                if turn_id and payload.get("cwd"):
                    projects_by_turn[turn_id] = payload["cwd"]

        if not session_id:
            session_id = _stable_unknown_id(path)

        file_turns = {}
        for record in records:
            if record.get("type") != "event_msg":
                continue
            payload = record.get("payload") or {}
            marker = payload.get("type")
            if marker not in ("task_started", "task_complete", "turn_aborted"):
                continue
            turn_id = payload.get("turn_id")
            if not turn_id:
                diagnostics["parse_errors"] += 1
                continue
            project = projects_by_turn.get(turn_id, session_project)
            key = "codex:%s:%s" % (session_id, turn_id)
            started_at = _timestamp_text(record.get("timestamp"), payload.get("started_at"))
            incoming = _new_turn(
                "codex", session_id, turn_id, project, started_at, "codex_rollout", path
            )
            if marker in ("task_complete", "turn_aborted"):
                incoming["ended_at"] = _timestamp_text(
                    record.get("timestamp"), payload.get("completed_at")
                )
                if marker == "task_complete":
                    incoming["outcome"] = "completed"
                elif payload.get("reason") == "interrupted":
                    incoming["outcome"] = "interrupted"
                else:
                    incoming["outcome"] = "failed"
            file_turns[key] = _merge_turn(file_turns.get(key), incoming)

        for key, turn in file_turns.items():
            if session_meta_rows > 1 and _is_replayed_turn(turn):
                diagnostics["replayed_turns_skipped"] += 1
                continue
            turns[key] = _merge_turn(turns.get(key), turn)

    return turns, diagnostics


def _is_claude_prompt(record):
    if record.get("type") != "user" or record.get("isMeta") is True:
        return False
    if record.get("toolUseResult") is not None or record.get("sourceToolAssistantUUID"):
        return False
    message = record.get("message") or {}
    if not isinstance(message, dict):
        return False
    content = message.get("content")
    if isinstance(content, str):
        has_human_input = True
    elif isinstance(content, list):
        kinds = {
            item.get("type")
            for item in content
            if isinstance(item, dict) and item.get("type")
        }
        has_human_input = bool(kinds.intersection(("text", "image")))
    else:
        has_human_input = False
    return has_human_input and bool(record.get("promptId") or record.get("uuid"))


def scan_claude(root, modified_since=None):
    """Reconstruct human-initiated turns from Claude transcript JSONL metadata.

    A missing ``root`` returns an empty result. ``modified_since`` uses file
    modification times only to prune the scan; an unparseable value is treated
    as no boundary and does not replace the caller's provider-timestamp filter.
    Meta messages, tool results, and tool-generated user rows do not start
    turns. ``end_turn`` settles a turn as ``completed`` and an API error as
    ``failed``. Within one transcript file, the next human prompt in the same
    session interrupts the preceding unsettled turn. Each turn also records
    whether it belongs to the root conversation or a sidechain.

    Returns a turn mapping keyed by stable ``record_id`` plus scan diagnostics.
    Complete malformed rows and an incomplete tail still being appended are
    counted separately so an ordinary in-progress write is not reported as
    source corruption.
    """
    turns = {}
    available, selected = _paths_for_window(root, codex=False, modified_since=modified_since)
    diagnostics = {
        "files_available": len(available),
        "files_scanned": 0,
        "parse_errors": 0,
        "partial_lines": 0,
    }
    for path in selected:
        records, errors, partials = _read_jsonl(
            path,
            include_line=_claude_lifecycle_line,
            rg_pattern=CLAUDE_RG_PATTERN,
            parse_line=_parse_claude_lifecycle,
        )
        diagnostics["files_scanned"] += 1
        diagnostics["parse_errors"] += errors
        diagnostics["partial_lines"] += partials
        open_by_session = {}
        seen_prompts = set()

        for record in records:
            session_id = record.get("sessionId")
            if not session_id:
                continue
            timestamp = _timestamp_text(record.get("timestamp"))
            if _is_claude_prompt(record):
                turn_id = record.get("promptId") or record.get("uuid")
                prompt_key = (session_id, turn_id)
                if prompt_key in seen_prompts:
                    continue
                seen_prompts.add(prompt_key)

                previous_key = open_by_session.get(session_id)
                if previous_key:
                    previous = turns[previous_key]
                    if previous["outcome"] == "open":
                        previous["outcome"] = "interrupted"
                        previous["ended_at"] = timestamp

                key = "claude:%s:%s" % (session_id, turn_id)
                incoming = _new_turn(
                    "claude",
                    session_id,
                    turn_id,
                    record.get("cwd"),
                    timestamp,
                    "claude_transcript",
                    path,
                )
                incoming["provider_scope"] = (
                    "sidechain" if record.get("isSidechain") is True else "root")
                turns[key] = _merge_turn(turns.get(key), incoming)
                if turns[key]["outcome"] == "open":
                    open_by_session[session_id] = key
                continue

            key = open_by_session.get(session_id)
            if not key:
                continue
            if record.get("type") == "assistant":
                message = record.get("message") or {}
                stop_reason = message.get("stop_reason") if isinstance(message, dict) else None
                if record.get("isApiErrorMessage") is True:
                    turns[key]["outcome"] = "failed"
                    turns[key]["ended_at"] = timestamp
                    open_by_session.pop(session_id, None)
                elif stop_reason == "end_turn":
                    turns[key]["outcome"] = "completed"
                    turns[key]["ended_at"] = timestamp
                    open_by_session.pop(session_id, None)

    return turns, diagnostics


def _filter_turns(turns, window_start=None, window_end=None):
    start = _parse_timestamp(window_start)
    end = _parse_timestamp(window_end)
    result = []
    for turn in turns.values():
        turn_start = _parse_timestamp(turn.get("started_at"))
        if turn_start is None:
            continue
        if start is not None and turn_start < start:
            continue
        if end is not None and turn_start >= end:
            continue
        result.append(turn)
    return sorted(result, key=lambda turn: (turn["started_at"], turn["record_id"]))


def _hook_paths(inputs):
    result = []
    for item in inputs or []:
        path = Path(item)
        if path.is_dir():
            result.extend(sorted(candidate for candidate in path.rglob("*.jsonl") if candidate.is_file()))
        elif path.is_file():
            result.append(path)
    return result


def read_hook_events(inputs, window_start=None, window_end=None):
    events = []
    diagnostics = {"files_scanned": 0, "parse_errors": 0, "partial_lines": 0}
    start = _parse_timestamp(window_start)
    end = _parse_timestamp(window_end)
    for path in _hook_paths(inputs):
        records, errors, partials = _read_jsonl(path)
        diagnostics["files_scanned"] += 1
        diagnostics["parse_errors"] += errors
        diagnostics["partial_lines"] += partials
        for record in records:
            source = str(record.get("source", "")).lower()
            timestamp = _parse_timestamp(record.get("t"))
            if source not in SOURCES or timestamp is None:
                continue
            if start is not None and timestamp < start:
                continue
            if end is not None and timestamp >= end:
                continue
            events.append(
                {
                    "source": source,
                    "timestamp": timestamp,
                    "event": str(record.get("event", "")).lower(),
                    "project": _normalise_project(record.get("project")),
                }
            )
    events.sort(key=lambda event: (event["timestamp"], event["source"], event["project"]))
    return events, diagnostics


def _hook_coverage_index(hook_events):
    index = {}
    for event in hook_events:
        if event["event"] not in ("working", "waiting", "complete"):
            continue
        key = (event["source"], event["project"])
        index.setdefault(key, []).append(event["timestamp"])
    for timestamps in index.values():
        timestamps.sort()
    return index


def _turn_is_covered(turn, hook_index):
    start = _parse_timestamp(turn.get("started_at"))
    end = _parse_timestamp(turn.get("ended_at")) or start
    if start is None or end is None:
        return False
    candidates = hook_index.get(
        (turn["source"], _normalise_project(turn["project"])), ())
    left = bisect.bisect_left(candidates, start - HOOK_TOLERANCE)
    right = bisect.bisect_right(candidates, end + HOOK_TOLERANCE)
    # Coverage answers only whether the real-time channel was observable while
    # the native turn existed.  It must not demand a hook `complete`: Codex can
    # expose many native turns under one outer hook lifecycle, and Claude
    # interrupt / StopFailure intentionally have no Stop hook.  Native history,
    # not the auxiliary hook, owns the terminal outcome.
    return left < right


def build_source_health(turns, hook_events, diagnostics, generated_at):
    """Compare provider-native turns with Perch hooks to build per-source health.

    ``turns`` and ``hook_events`` must already cover the same time window;
    ``diagnostics`` supplies available and scanned file counts plus parse errors
    for Codex and Claude. A hook proves only that the real-time channel was
    visible while a native turn existed; it does not own the turn's outcome.

    Each source is classified as ``missing``, ``healthy``,
    ``recovered_with_gap``, or ``degraded``; any provider parse error forces a
    degraded result. The snapshot also preserves coverage gaps, freshness,
    incomplete tails, and replay counts. ``generated_at`` labels only when the
    snapshot was produced.
    """
    sources = {}
    alerts = []
    hook_index = _hook_coverage_index(hook_events)
    for source in SOURCES:
        native = [turn for turn in turns if turn["source"] == source]
        hooks = [event for event in hook_events if event["source"] == source]
        uncovered = [turn for turn in native if not _turn_is_covered(turn, hook_index)]
        activity_times = [
            _parse_timestamp(turn.get("ended_at")) or _parse_timestamp(turn.get("started_at"))
            for turn in native
        ]
        activity_times = [value for value in activity_times if value is not None]
        start_times = [_parse_timestamp(turn.get("started_at")) for turn in native]
        start_times = [value for value in start_times if value is not None]
        hook_times = [event["timestamp"] for event in hooks]
        uncovered_times = [_parse_timestamp(turn["started_at"]) for turn in uncovered]
        uncovered_times = [value for value in uncovered_times if value is not None]

        if not native:
            status = "missing"
        elif not uncovered:
            status = "healthy"
        else:
            latest_uncovered = max(
                _parse_timestamp(turn.get("ended_at")) or _parse_timestamp(turn.get("started_at"))
                for turn in uncovered
            )
            if hook_times and max(hook_times) > latest_uncovered:
                status = "recovered_with_gap"
            else:
                status = "degraded"

        source_diagnostics = diagnostics.get(source, {})
        files_available = source_diagnostics.get("files_available", 0)
        files_scanned = source_diagnostics.get("files_scanned", 0)
        parse_errors = source_diagnostics.get("parse_errors", 0)
        if parse_errors:
            status = "degraded"
        if not native:
            freshness_status = "unknown"
            freshness_lag_seconds = None
        elif not hook_times:
            freshness_status = "missing"
            freshness_lag_seconds = None
        else:
            freshness_lag = max(start_times) - max(hook_times)
            freshness_lag_seconds = max(0, int(freshness_lag.total_seconds()))
            freshness_status = (
                "lagging" if freshness_lag > HOOK_TOLERANCE else "current"
            )
        health = {
            "status": status,
            "freshness_status": freshness_status,
            "freshness_lag_seconds": freshness_lag_seconds,
            "files_available": files_available,
            "files_scanned": files_scanned,
            "native_turns": len(native),
            "settled_turns": sum(1 for turn in native if turn["outcome"] != "open"),
            "uncovered_turns": len(uncovered),
            "parse_errors": parse_errors,
            "partial_lines": source_diagnostics.get("partial_lines", 0),
            "replayed_turns_skipped": source_diagnostics.get("replayed_turns_skipped", 0),
            "latest_native_at": _timestamp_text(max(activity_times)) if activity_times else None,
            "latest_hook_at": _timestamp_text(max(hook_times)) if hook_times else None,
            "coverage_start": _timestamp_text(min(activity_times)) if activity_times else None,
            "coverage_end": _timestamp_text(max(activity_times)) if activity_times else None,
        }
        sources[source] = health
        if files_available == 0:
            alerts.append(
                {
                    "source": source,
                    "kind": "native_source_missing",
                    "count": 0,
                    "first_at": None,
                    "last_at": None,
                }
            )
        if parse_errors:
            alerts.append(
                {
                    "source": source,
                    "kind": "native_parse_error",
                    "count": parse_errors,
                    "first_at": None,
                    "last_at": None,
                }
            )
        if uncovered:
            alerts.append(
                {
                    "source": source,
                    "kind": "coverage_gap_recovered" if status == "recovered_with_gap" else "coverage_gap",
                    "count": len(uncovered),
                    "first_at": _timestamp_text(min(uncovered_times)),
                    "last_at": _timestamp_text(max(uncovered_times)),
                }
            )

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _timestamp_text(generated_at) or str(generated_at),
        "sources": sources,
        "alerts": alerts,
    }


def _atomic_write(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".%s." % path.name, dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def atomic_write_jsonl(path, records):
    body = b"".join(
        (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        for record in records
    )
    _atomic_write(path, body)


def atomic_write_json(path, value):
    body = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")
    _atomic_write(path, body)


def publish_reconciliation(socket_path, health, canonical):
    """Hand derived files to the entitled Perch app for App Group publication.

    A plain LaunchAgent is allowed to read the existing group ledger on current
    macOS, but TCC rejects creating or atomically replacing files there.  The
    app already owns an AF_UNIX bridge in that container, so the unprivileged
    scanner sends bounded derived bytes to the signed app instead of pretending
    a successful terminal write proves the background path.
    """
    message = b"\t".join((
        b"reconciliation",
        base64.b64encode(health),
        base64.b64encode(canonical),
        b"reconciler",
    ))
    if len(message) > MAX_PUBLISH_BYTES:
        raise ValueError(
            "reconciliation payload is %d bytes; limit is %d"
            % (len(message), MAX_PUBLISH_BYTES)
        )
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(10)
        connection.connect(str(socket_path))
        connection.sendall(message)
        connection.shutdown(socket.SHUT_WR)


def request_hook_snapshot(socket_path, lookback_days, attempts=30, sleep=time.sleep):
    """Ask the entitled app for its recent raw hook lifecycle ledger."""
    request = (
        "hook-ledger-request\t%d\t0\treconciler" % lookback_days
    ).encode("ascii")
    last_error = None
    for attempt in range(attempts):
        response = bytearray()
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(10)
                connection.connect(str(socket_path))
                connection.sendall(request)
                connection.shutdown(socket.SHUT_WR)
                while len(response) <= MAX_HOOK_SNAPSHOT_BYTES + 64:
                    chunk = connection.recv(65536)
                    if not chunk:
                        break
                    response.extend(chunk)
            break
        except OSError as error:
            last_error = error
            if attempt + 1 == attempts:
                raise
            sleep(0.5)
    else:  # pragma: no cover - defensive; the loop either breaks or raises.
        raise last_error or RuntimeError("Perch bridge was unavailable")
    if len(response) > MAX_HOOK_SNAPSHOT_BYTES + 64:
        raise ValueError("hook ledger response exceeds the 8 MiB limit")
    if not response.startswith(b"OK\n"):
        detail = bytes(response[:256]).decode("utf-8", errors="replace")
        raise RuntimeError("Perch could not export hook ledger: %s" % detail)
    return bytes(response[3:])


def reconcile(
    codex_root,
    claude_root,
    hook_ledgers,
    out_dir=None,
    generated_at=None,
    window_start=None,
    window_end=None,
):
    """Rebuild the turn ledger for a time window and assess real-time hook coverage.

    ``codex_root`` and ``claude_root`` contain provider-native JSONL files;
    ``hook_ledgers`` may contain files or directories. Turns are selected by
    start time in the half-open interval ``[window_start, window_end)``, and
    hooks use the same window. A missing or unparseable boundary leaves that
    side unbounded. Every call rebuilds from the selected provider files rather
    than trusting a prior derived cache or incremental cursor.

    Returns sorted ``turns``, ``health``, and hook scan diagnostics. Supplying
    ``out_dir`` writes ``canonical-turns.jsonl`` and ``source-health.json``;
    otherwise the result stays in memory. Each file is replaced atomically, but
    the pair is not a cross-file transaction. Read or write failures propagate
    to the caller.
    """
    # The provider timestamp remains the record filter.  Passing the same lower
    # boundary to the scanners only avoids opening files whose last append was
    # safely before it; every run still rebuilds from selected source files and
    # never trusts an old cache/cursor for correctness.
    codex_turns, codex_diagnostics = scan_codex(codex_root, modified_since=window_start)
    claude_turns, claude_diagnostics = scan_claude(claude_root, modified_since=window_start)
    combined = dict(codex_turns)
    for key, turn in claude_turns.items():
        combined[key] = _merge_turn(combined.get(key), turn)
    turns = _filter_turns(combined, window_start=window_start, window_end=window_end)
    hook_events, hook_diagnostics = read_hook_events(
        hook_ledgers, window_start=window_start, window_end=window_end
    )
    if generated_at is None:
        generated_at = datetime.now(timezone.utc)
    health = build_source_health(
        turns,
        hook_events,
        {"codex": codex_diagnostics, "claude": claude_diagnostics, "hooks": hook_diagnostics},
        generated_at,
    )
    if out_dir is not None:
        output = Path(out_dir)
        atomic_write_jsonl(output / "canonical-turns.jsonl", turns)
        atomic_write_json(output / "source-health.json", health)
    return {"turns": turns, "health": health, "hook_diagnostics": hook_diagnostics}


def _summary(result):
    return {
        "turns": len(result["turns"]),
        "sources": {
            source: {
                "status": result["health"]["sources"][source]["status"],
                "native_turns": result["health"]["sources"][source]["native_turns"],
                "uncovered_turns": result["health"]["sources"][source]["uncovered_turns"],
            }
            for source in SOURCES
        },
        "alerts": len(result["health"]["alerts"]),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-root", type=Path, default=Path.home() / ".codex" / "sessions")
    parser.add_argument("--claude-root", type=Path, default=Path.home() / ".claude" / "projects")
    parser.add_argument("--hook-ledger", action="append", type=Path, default=[])
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument("--bridge-socket", type=Path)
    parser.add_argument("--window-start")
    parser.add_argument("--window-end")
    parser.add_argument("--lookback-days", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--fail-on-alert", action="store_true")
    args = parser.parse_args(argv)
    if not args.dry_run and args.out_dir is None:
        parser.error("--out-dir is required unless --dry-run is used")
    if args.bridge_socket is not None and args.out_dir is None:
        parser.error("--bridge-socket requires --out-dir")
    if args.bridge_socket is not None and args.lookback_days is None:
        parser.error("--bridge-socket requires --lookback-days")
    if args.lookback_days is not None and args.window_start is not None:
        parser.error("--lookback-days and --window-start are mutually exclusive")
    if args.lookback_days is not None and args.lookback_days <= 0:
        parser.error("--lookback-days must be greater than zero")

    generated_at = datetime.now(timezone.utc)
    window_start = args.window_start
    if args.lookback_days is not None:
        window_start = _timestamp_text(generated_at - timedelta(days=args.lookback_days))

    hook_ledgers = list(args.hook_ledger)
    if args.bridge_socket is not None:
        snapshot_path = args.out_dir / "hook-ledger-snapshot.jsonl"
        _atomic_write(
            snapshot_path,
            request_hook_snapshot(args.bridge_socket, args.lookback_days),
        )
        hook_ledgers.append(snapshot_path)

    result = reconcile(
        codex_root=args.codex_root,
        claude_root=args.claude_root,
        hook_ledgers=hook_ledgers,
        out_dir=None if args.dry_run else args.out_dir,
        generated_at=generated_at,
        window_start=window_start,
        window_end=args.window_end,
    )
    if args.bridge_socket is not None:
        publish_reconciliation(
            args.bridge_socket,
            (args.out_dir / "source-health.json").read_bytes(),
            (args.out_dir / "canonical-turns.jsonl").read_bytes(),
        )
    print(json.dumps(_summary(result), sort_keys=True))
    if args.fail_on_alert and result["health"]["alerts"]:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
