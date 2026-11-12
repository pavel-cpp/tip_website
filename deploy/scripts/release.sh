#!/bin/sh
# Cuts a release: tags the current tip of origin/main as vX.Y.Z, pushes the tag and creates a GitHub release
# with notes generated from the commits. Pushing the tag starts the cd workflow, which builds and deploys that
# exact commit under the clean version number (see docs/08-ci-cd.md).
#
# Usage: deploy/scripts/release.sh patch|minor|major|X.Y.Z
set -eu

bump=${1:?usage: release.sh patch|minor|major|X.Y.Z}
cd "$(git rev-parse --show-toplevel)"
git fetch -q origin main --tags

last=$(git describe --tags --match 'v[0-9]*' --abbrev=0 origin/main 2> /dev/null || echo v0.0.0)
IFS=. read -r major minor patch << EOF
${last#v}
EOF

case $bump in
    major) major=$((major + 1)) minor=0 patch=0 ;;
    minor) minor=$((minor + 1)) patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    [0-9]*.[0-9]*.[0-9]*)
        IFS=. read -r major minor patch << EOF
$bump
EOF
        ;;
    *)
        echo "unknown bump '$bump' (want patch, minor, major or X.Y.Z)" >&2
        exit 2
        ;;
esac
next="$major.$minor.$patch"

if git rev-parse -q --verify "refs/tags/v$next" > /dev/null; then
    echo "tag v$next already exists" >&2
    exit 1
fi
if released=$(git describe --tags --match 'v[0-9]*' --exact-match origin/main 2> /dev/null); then
    echo "origin/main is already released as $released" >&2
    exit 1
fi

echo "releasing $next (previous: ${last#v}) at $(git rev-parse --short origin/main)"
git tag -a "v$next" -m "Release $next" origin/main
git push -q origin "v$next"

if command -v gh > /dev/null 2>&1; then
    gh release create "v$next" --verify-tag --generate-notes --title "$next"
else
    echo "gh is not installed: the tag is pushed, create the GitHub release by hand"
fi
echo "tag v$next pushed; follow the deploy with: gh run watch"
