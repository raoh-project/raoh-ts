#!/usr/bin/env bash
# Publishes the package from the commit checked out, as the version a git ref makes of it.
#
#     scripts/publish.sh <ref> --check     # say the version and the dist-tag, and publish nothing
#     scripts/publish.sh <ref> --dry-run   # all of a publish but the upload, and the check of main
#     scripts/publish.sh <ref>             # publish
#
# A tag vX.Y.Z is the release X.Y.Z under the dist-tag latest: package.json holds that version,
# and the commit is on main. Any other ref is a development version under the dist-tag dev:
# package.json holds the next version as X.Y.Z-dev, and the version published is that, the time of
# the commit and the commit, X.Y.Z-dev.YYYYMMDDHHMMSS.gHHHHHHHHHHHH. The commit makes two commits
# two versions, which the time alone does not, since two commits can be made in one second; the
# time puts the versions in the order the commits were made, as npm orders a version's prerelease
# fields; and a run again over one commit makes the version it made before, which npm refuses
# rather than publish twice.
#
# CI runs this with --dry-run for a development version and for a release on every pull request,
# so that the path a tag takes is taken before a tag is pushed. A dry run leaves out only the check
# that the commit is on main, which a pull request's commit is not yet.
set -euo pipefail
cd "$(dirname "$0")/.."

ref="${1:?usage: $0 <ref> [--check|--dry-run]}"
mode="${2:-publish}"
case "$mode" in
  --check|--dry-run|publish) ;;
  *) echo "usage: $0 <ref> [--check|--dry-run]" >&2; exit 2 ;;
esac

held=$(jq -r .version package.json)
if [[ "$ref" == refs/tags/v* ]]; then
  version="${ref#refs/tags/v}"
  if ! [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "${ref#refs/tags/} is not vX.Y.Z" >&2
    exit 1
  fi
  if [ "$held" != "$version" ]; then
    echo "the tag is v$version, and package.json holds $held" >&2
    exit 1
  fi
  if [ "$mode" != --dry-run ] && ! git merge-base --is-ancestor HEAD origin/main; then
    echo "v$version names a commit that is not on main" >&2
    exit 1
  fi
  dist_tag=latest
else
  if ! [[ "$held" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev$ ]]; then
    echo "package.json holds $held, where a development version is made from X.Y.Z-dev" >&2
    exit 1
  fi
  time=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y%m%d%H%M%S)
  version="$held.$time.g$(git rev-parse --short=12 HEAD)"
  dist_tag=dev
fi
echo "version=$version"
echo "dist-tag=$dist_tag"
if [ "$mode" = --check ]; then
  exit 0
fi

# A release publishes the version package.json holds; a development version is written into it
# for the publish, and a dry run puts package.json back as it was.
if [ "$version" != "$held" ]; then
  if [ "$mode" = --dry-run ]; then
    trap 'git checkout --quiet -- package.json package-lock.json' EXIT
  fi
  npm version --no-git-tag-version "$version" > /dev/null
fi
if [ "$mode" = --dry-run ]; then
  npm publish --tag "$dist_tag" --dry-run
else
  npm publish --tag "$dist_tag"
fi
