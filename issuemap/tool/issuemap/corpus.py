"""Clean and freeze a fetched thread so a run is reproducible and checkable.

Freezing writes the exact comments the pipeline will see, plus a SHA-256 of
them, so anyone can confirm later that nothing was changed after the fact.
"""
import hashlib
import json
import re

# Comments that summarise the debate are the answer key, not the debate.
# These heuristics only *suggest* exclusions; the user confirms them.
SUMMARY_HINTS = re.compile(
    r"\b(summary of (the )?(discussion|arguments|thread)|to summari[sz]e (the|this) "
    r"(discussion|thread)|recap of|here'?s where (things|we) stand|"
    r"(arguments|points) (made )?so far)\b", re.I)


def suggest_exclusions(thread, min_len=1500):
    """Long comments that read like summaries of the thread."""
    out = []
    for c in thread["comments"]:
        if len(c["body"]) >= min_len and SUMMARY_HINTS.search(c["body"]):
            out.append({"id": c["id"], "author": c["author"], "url": c["url"],
                        "preview": c["body"][:160].replace("\n", " ")})
    return out


def canonical_bytes(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":")).encode()


def freeze(thread, exclude_ids=(), exclude_reason=""):
    exclude_ids = set(map(str, exclude_ids))
    kept = [c for c in thread["comments"] if c["id"] not in exclude_ids]
    removed = [c["id"] for c in thread["comments"] if c["id"] in exclude_ids]
    missing = sorted(exclude_ids - set(removed))
    if missing:
        raise ValueError(f"Exclusion ids not found in thread: {missing}")
    body = {"source": thread["source"], "title": thread["title"], "comments": kept}
    digest = hashlib.sha256(canonical_bytes(body)).hexdigest()
    return {
        **body,
        "frozen": {
            "sha256": digest,
            "comment_count": len(kept),
            "excluded": removed,
            "excluded_reason": exclude_reason,
        },
    }


def verify_frozen(corpus):
    body = {k: corpus[k] for k in ("source", "title", "comments")}
    return hashlib.sha256(canonical_bytes(body)).hexdigest() == corpus["frozen"]["sha256"]
