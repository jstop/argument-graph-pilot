"""Mechanical provenance check: does each claim's quote really appear in its comment?

No model involved. Matching ignores whitespace, case, markdown emphasis and
quote-style differences, but nothing else, so a paraphrase fails.
"""
import re

_TRANS = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"',
                        "–": "-", "—": "-", "*": "", "_": "", "`": ""})


def normalise(s):
    return re.sub(r"\s+", " ", s.translate(_TRANS)).strip().lower()


def check_claims(claims, corpus):
    bodies = {c["id"]: normalise(c["body"]) for c in corpus["comments"]}
    verified = failed = 0
    for cl in claims:
        q = normalise(cl.get("quote", ""))
        ok = bool(q) and len(q) >= 8 and q in bodies.get(cl["comment_id"], "")
        cl["quote_verified"] = ok
        verified += ok
        failed += not ok
    return claims, {"verified": verified, "failed": failed,
                    "failed_ids": [c["id"] for c in claims if not c["quote_verified"]]}
