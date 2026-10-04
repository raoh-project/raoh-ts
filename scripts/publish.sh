#!/usr/bin/env bash
# Publishes the package from the commit checked out, as the version a git ref makes of it.
#
#     scripts/publish.sh <ref> --check     # say the version, and publish nothing
#     scripts/publish.sh <ref> --dry-run   # all of a publish but the upload, and the check of main
#     scripts/publish.sh <ref>             # publish
#
# Which dist-tag a version is published under is decided by what the versions are, and never by the
# order runs happen to run in: GitHub starts the runs of one concurrency group one at a time, in an
# order it does not promise, so a run may come after the run of a later commit or a newer release.
# One run publishes at a time, so nothing is published between a run's asking and its publishing.
#
# A tag vX.Y.Z is a release: package.json holds that version, and the commit is on main. It takes
# latest where it is newer than what latest names, and otherwise release-X.Y where it is newer than
# what that names; where it is newer than neither, as a patch whose run comes after a newer patch's,
# it moves neither, and is published under release-X.Y.Z, which names it and nothing else, since npm
# publishes nothing without a dist-tag. What each names is asked of the registry, which holds only
# what was published, so a tag whose run refused it or failed has no say. The dist-tags of a public
# package are read without logging in, so the workflow does nothing as the trusted publisher but
# publish. DIST_TAGS, where it is set, is taken for what the registry says, as JSON, as a dry run
# sets it.
#
# Any other ref is a development version under the dist-tag dev: package.json holds the next version
# as X.Y.Z-dev, and the version published is X.Y.Z-dev.N.YYYYMMDDHHMMSS.gHHHHHHHHHHHH. N is how many
# commits the commit holds, itself and every one before it, so a later commit on develop, which holds
# every one before it and itself, has the greater N, and SemVer orders the versions as develop does;
# the time of a commit and its name do not, as two commits can be made in one second, and a commit
# can be dated before its parent. The time says when, and the commit makes two commits two versions
# whatever else they share. A run again over one commit makes the version it made before, which is
# published already and is not published again. What dev names is the newest state of develop: just
# before it publishes, a run asks develop, as it is then, whether a later commit has reached it, and
# where one has, publishes nothing and leaves dev to that commit's run. Develop is origin/develop,
# fetched as the run asks, or what DEVELOP names.
#
# CI runs this with --dry-run on every pull request, on each path scripts/try-publish.sh names, so
# that each is taken before a push takes it. A dry run leaves out only the check that a release's
# commit is on main, which a pull request's commit is not yet.
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

# The dist-tags the registry has of the package, as JSON, and none where it has no such package.
# The registry answers a package it has not got as it answers one it will not say of to whoever has
# not logged in, so that answer is asked again of the package itself, which says plainly that it is
# not there. Anything else fails the publish: a release is not published on a guess.
published_tags() {
  local escaped="${1/\//%2f}" code tags
  tags=$(mktemp)
  code=$(curl --silent --show-error --output "$tags" --write-out '%{http_code}' \
    "https://registry.npmjs.org/-/package/$escaped/dist-tags") || { rm -f "$tags"; return 1; }
  case "$code" in
    200)
      cat "$tags"
      rm -f "$tags" ;;
    401|404)
      rm -f "$tags"
      code=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        "https://registry.npmjs.org/$escaped") || return 1
      if [ "$code" != 404 ]; then
        echo "the registry would not say what the dist-tags of $1 name: HTTP $code" >&2
        return 1
      fi
      echo "{}" ;;
    *)
      rm -f "$tags"
      echo "the registry would not say what the dist-tags of $1 name: HTTP $code" >&2
      return 1 ;;
  esac
}

# Whether `version` is newer than what `tag` names in `tags`, which it is where `tag` names nothing.
newer_than() {
  local named
  named=$(jq -r --arg tag "$3" '.[$tag] // empty' <<< "$2")
  [ -z "$named" ] || node scripts/newer.mjs "$1" "$named"
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
  echo "version=$version"
  if [ "$mode" = --check ]; then
    exit 0
  fi
  if [ -n "${DIST_TAGS+set}" ]; then
    tags="$DIST_TAGS"
  else
    tags=$(published_tags "$name") || exit 1
  fi
  line="release-${version%.*}"
  if newer_than "$version" "$tags" latest; then
    dist_tag=latest
  elif newer_than "$version" "$tags" "$line"; then
    dist_tag="$line"
  else
    dist_tag="release-$version"
  fi
else
  if ! [[ "$held" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev$ ]]; then
    echo "package.json holds $held, where a development version is made from X.Y.Z-dev" >&2
    exit 1
  fi
  count=$(git rev-list --count HEAD)
  time=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y%m%d%H%M%S)
  version="$held.$count.$time.g$(git rev-parse --short=12 HEAD)"
  echo "version=$version"
  if [ "$mode" = --check ]; then
    exit 0
  fi
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
  dist_tag=dev
fi
echo "dist-tag=$dist_tag"

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
