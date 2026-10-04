#!/usr/bin/env bash
# Publishes the package from the commit checked out, as the version a git ref makes of it.
#
#     scripts/publish.sh <ref> --check     # say the version and the dist-tag, and publish nothing
#     scripts/publish.sh <ref> --dry-run   # all of a publish but the upload, and the check of main
#     scripts/publish.sh <ref>             # publish
#
# A tag vX.Y.Z is a release: package.json holds that version, and the commit is on main. It is
# published under the dist-tag latest where it is newer than what latest names as it is published,
# and under release-X.Y where it is not, so a release whose run comes after a newer one's never takes
# latest from it. What latest names is asked of the registry, which holds what was published: a tag
# whose run refused it or failed published nothing, and has no say. One run publishes at a time, so
# nothing is published between the asking and the publishing. The registry's dist-tags of a public
# package are read without logging in, so the workflow does nothing as the trusted publisher but
# publish. LATEST, where it is set, is taken for what the registry says, as a dry run sets it; a
# check, which decides nothing, names both dist-tags and asks neither.
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
# CI runs this with --dry-run on every pull request, on each path scripts/try-publish.sh names, so
# that each is taken before a push takes it. A dry run leaves out only the check that a release's commit is on main, which a pull
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
name=$(jq -r .name package.json)

# What latest names in the registry, or nothing where there is no latest or no such package. The
# registry answers a package it has not got as it answers one it will not say of to whoever has not
# logged in, so that answer is asked again of the package itself, which says plainly that it is not
# there. Anything else fails the publish: a release is not published on a guess.
latest_published() {
  local escaped="${1/\//%2f}" code tags
  tags=$(mktemp)
  code=$(curl --silent --show-error --output "$tags" --write-out '%{http_code}' \
    "https://registry.npmjs.org/-/package/$escaped/dist-tags") || { rm -f "$tags"; return 1; }
  case "$code" in
    200)
      jq -r '.latest // empty' "$tags"
      rm -f "$tags" ;;
    401|404)
      rm -f "$tags"
      code=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        "https://registry.npmjs.org/$escaped") || return 1
      if [ "$code" != 404 ]; then
        echo "the registry would not say what latest names of $1: HTTP $code" >&2
        return 1
      fi ;;
    *)
      rm -f "$tags"
      echo "the registry would not say what latest names of $1: HTTP $code" >&2
      return 1 ;;
  esac
}
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
  if [ "$mode" = --check ]; then
    current="unknown until it is published"
  elif [ -n "${LATEST+set}" ]; then
    current="$LATEST"
  else
    current=$(latest_published "$name") || exit 1
  fi
  # A package with no latest takes its release as latest, and so does one whose latest names a
  # development version of it, which SemVer orders below the release.
  if [ "$mode" = --check ]; then
    dist_tag="latest or release-${version%.*}"
  elif [ -z "$current" ] || node scripts/newer.mjs "$version" "$current"; then
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
