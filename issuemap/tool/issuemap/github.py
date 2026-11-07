"""Fetch a public GitHub issue (or PR) and all its comments via the REST API.

Standard library only. A token (GITHUB_TOKEN) is optional but raises the rate
limit from 60 to 5,000 requests an hour; a 1,000-comment thread needs ~11 calls.
"""
import json
import os
import re
import time
import urllib.request
import urllib.error

API = "https://api.github.com"
URL_RE = re.compile(r"github\.com/([^/]+)/([^/]+)/(?:issues|pull)/(\d+)")


def parse_issue_url(url):
    m = URL_RE.search(url)
    if not m:
        raise ValueError(f"Not a GitHub issue or PR URL: {url}")
    return m.group(1), m.group(2), int(m.group(3))


def _gh_available():
    import shutil
    import subprocess
    if not shutil.which("gh"):
        return False
    return subprocess.run(["gh", "auth", "status"], capture_output=True).returncode == 0


def _get_gh(url):
    """Use the GitHub CLI's own login; returns (json, link header)."""
    import subprocess
    path = url.replace(API + "/", "")
    out = subprocess.run(["gh", "api", "--include", path],
                         capture_output=True, text=True, check=True).stdout
    head, _, body = out.partition("\r\n\r\n")
    if not body:
        head, _, body = out.partition("\n\n")
    link = ""
    for line in head.splitlines():
        if line.lower().startswith("link:"):
            link = line.split(":", 1)[1].strip()
    return json.loads(body), link


USE_GH = None


def _get(url, token=None):
    global USE_GH
    if USE_GH is None:
        USE_GH = not token and _gh_available()
    if USE_GH:
        return _get_gh(url)
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "issuemap",
        **({"Authorization": f"Bearer {token}"} if token else {}),
    })
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r), r.headers.get("Link", "")
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) and e.headers.get("X-RateLimit-Remaining") == "0":
                reset = int(e.headers.get("X-RateLimit-Reset", time.time() + 60))
                raise SystemExit(
                    f"GitHub rate limit hit; resets at {time.ctime(reset)}. "
                    "Set GITHUB_TOKEN to raise the limit.") from e
            if e.code >= 500 and attempt < 4:
                time.sleep(2 ** attempt)
                continue
            raise


def _next_link(link_header):
    for part in link_header.split(","):
        if 'rel="next"' in part:
            return part[part.find("<") + 1:part.find(">")]
    return None


def fetch_thread(url, token=None):
    """Return {source, title, opened_by, comments:[{id, author, created_at, url, body}]}.

    The issue's opening post is included as the first comment with id "issue".
    """
    token = token or os.environ.get("GITHUB_TOKEN")
    owner, repo, num = parse_issue_url(url)
    issue, _ = _get(f"{API}/repos/{owner}/{repo}/issues/{num}", token)
    comments = [{
        "id": "issue",
        "author": issue["user"]["login"],
        "created_at": issue["created_at"],
        "url": issue["html_url"],
        "body": issue.get("body") or "",
    }]
    page = f"{API}/repos/{owner}/{repo}/issues/{num}/comments?per_page=100"
    while page:
        batch, link = _get(page, token)
        for c in batch:
            comments.append({
                "id": str(c["id"]),
                "author": (c.get("user") or {}).get("login", "ghost"),
                "created_at": c["created_at"],
                "url": c["html_url"],
                "body": c.get("body") or "",
            })
        page = _next_link(link)
    return {
        "source": issue["html_url"],
        "title": issue["title"],
        "opened_by": issue["user"]["login"],
        "comments": comments,
    }
