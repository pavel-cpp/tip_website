#!/bin/sh
# Human-readable build version from git tags (releases are tags vMAJOR.MINOR.PATCH, see release.sh):
#   0.2.0     the commit carries the tag v0.2.0
#   0.2.0+5   five commits after v0.2.0
#   0.0.0+42  no release tag yet (42 commits)
# The commit hash is reported separately. Needs the tags (checkout with fetch-depth: 0).
set -eu

if ! described=$(git describe --tags --match 'v[0-9]*' --long 2> /dev/null); then
    echo "0.0.0+$(git rev-list --count HEAD)"
    exit 0
fi

# described = <tag>-<commits since the tag>-g<hash>
rest=${described%-g*}
ahead=${rest##*-}
base=${rest%-*}
base=${base#v}

if [ "$ahead" = 0 ]; then
    echo "$base"
else
    echo "$base+$ahead"
fi
