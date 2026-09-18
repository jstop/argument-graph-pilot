#!/usr/bin/env bash
# Rebuilds vendor/signify-ts-<version>-<commit>.tgz from source.
#
# The wallet pins signify-ts to a git commit on a branch that is in no npm
# release. Installing it straight from git works but (a) npm records a
# git+ssh URL, so `npm ci` needs GitHub SSH access, and (b) the build pulls
# signify's dev dependencies including a Chromium download. So we vendor
# the built package. This script is the provenance: same commit, plain
# build, dist + src packed.
set -euo pipefail
COMMIT="${1:-62a646f1eb67c30c8f1aecfe628d81dd693b60f2}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The commit is on no branch (a dangling branch in the upstream repo), so
# fetch it by SHA rather than cloning and checking out.
git init -q "$WORK/src"
git -C "$WORK/src" fetch -q --depth 1 https://github.com/WebOfTrust/signify-ts.git "$COMMIT"
git -C "$WORK/src" checkout -q FETCH_HEAD
(cd "$WORK/src" && PUPPETEER_SKIP_DOWNLOAD=true npm ci --ignore-scripts >/dev/null 2>&1 && npm run build >/dev/null 2>&1)

VERSION="$(jq -r .version "$WORK/src/package.json")-${COMMIT:0:7}"
mkdir -p "$WORK/package"
cp -R "$WORK/src/dist" "$WORK/src/src" "$WORK/src/README.md" "$WORK/src/LICENSE" "$WORK/package/"
jq --arg v "$VERSION" 'del(.scripts.prepare) | del(.devDependencies) | .version = $v' "$WORK/src/package.json" > "$WORK/package/package.json"
OUT="$HERE/signify-ts-$VERSION.tgz"
# Deterministic tarball (fixed mtime, sorted, no uid/gid), portable across BSD/GNU tar.
python3 - "$WORK" "$OUT" <<'PY'
import gzip, io, os, sys, tarfile
work, out = sys.argv[1], sys.argv[2]
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT) as tar:
    for root, dirs, files in os.walk(os.path.join(work, "package")):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            info = tar.gettarinfo(full, arcname=os.path.relpath(full, work))
            info.mtime, info.uid, info.gid, info.uname, info.gname = 946684800, 0, 0, "", ""
            with open(full, "rb") as f:
                tar.addfile(info, f)
with open(out, "wb") as f:
    with gzip.GzipFile(fileobj=f, mode="wb", mtime=0) as gz:
        gz.write(buf.getvalue())
PY
echo "$OUT"
shasum -a 256 "$OUT"
