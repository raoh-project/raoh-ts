#!/usr/bin/env bash
# Publishes the package from the commit checked out, as the version a git ref makes of it.
#
#     scripts/publish.sh <ref> --check     # say the version and the dist-tag, and publish nothing
#     scripts/publish.sh <ref> --dry-run   # all of a publish but the upload, and the check of main
#     scripts/publish.sh <ref>             # publish
#
# A tag vX.Y.Z is a release: package.json holds that version, and the commit is on main. It is
# published under the dist-tag latest where it is the greatest release the repository has tagged,
# and under release-X.Y where it is not, so a release published after a greater one, as runs may be
# run in another order than their tags were pushed, never takes latest from it.
#
# Any other ref is a development version under the dist-tag dev: package.json holds the next version
# as X.Y.Z-dev, and the version published is that, the time of the commit and the commit,
# X.Y.Z-dev.YYYYMMDDHHMMSS.gHHHHHHHHHHHH. The commit makes two commits two versions, which the time
# alone does not, since two commits can be made in one second; the time puts the versions in the
# order the commits were made, as npm orders a version's prerelease fields; and a run again over one
# commit makes the version it made before, which npm refuses rather than publish twice. What dev
# names is the newest state of develop: just before it publishes, a run asks develop, as it is then,
# whether a later commit has reached it, and where one has, publishes nothing and leaves dev to that
# commit's run. One run publishes at a time, so a run that asks and finds itself newest publishes
# before any later commit's run asks, whatever order the runs were started in. Develop is
# origin/develop, fetched as the run asks, or what DEVELOP names.
#
# CI runs this with --dry-run on every pull request: for a development version newest on develop,
# for one a later commit has passed, and for a release, so that each path is taken before a push
# takes it. A dry run leaves out only the check that a release's commit is on main, which a pull
# request's commit is not yet.
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
  # The releases tagged, this one among them whether or not its tag is here yet, greatest last.
  greatest=$( { git tag --list 'v*' | sed 's/^v//'; echo "$version"; } \
    | grep -E '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' | sort -V | tail -n 1)
  if [ "$greatest" = "$version" ]; then
    dist_tag=latest
  else
    dist_tag="release-${version%.*}"
  fi
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

if [ "$dist_tag" = dev ]; then
  develop="${DEVELOP:-}"
  if [ -z "$develop" ]; then
    git fetch --quiet origin develop
    develop=FETCH_HEAD
  fi
  if ! git merge-base --is-ancestor HEAD "$develop"; then
    echo "$(git rev-parse --short=12 HEAD) is not on develop" >&2
    exit 1
  fi
  later=$(git rev-list -n 1 "HEAD..$develop")
  if [ -n "$later" ]; then
    echo "a later commit, $(git rev-parse --short=12 "$later"), has reached develop; nothing is published, and dev is left to its run"
    exit 0
  fi
fi

# A run again over a commit already published, as a run is re-run, has nothing to publish. Where the
# registry has not yet said it has the version, npm refuses to publish it twice all the same.
name=$(jq -r .name package.json)
if [ "$mode" != --dry-run ] && [ -n "$(npm view "$name@$version" version 2>/dev/null || true)" ]; then
  echo "$name@$version is published already; nothing is published"
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
