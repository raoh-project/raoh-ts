#!/usr/bin/env bash
# Takes each path scripts/publish.sh can take, as a dry run, and holds each to what it is to do:
#
#   - a development version newest on develop is published under dev;
#   - one a later commit on develop has passed publishes nothing;
#   - a release that is the greatest tagged is published under latest;
#   - a release below one already tagged is published under release-X.Y.
#
# Whatever ref CI runs for and whichever version package.json holds, the same is asked: package.json
# is set as it is on develop and as a release sets it. A later commit and a greater tag are made here
# and taken away again, and package.json is put back as it was.
set -euo pipefail
cd "$(dirname "$0")/.."

held="$(jq -r .version package.json)"
release="${held%-dev}"
start="$(git rev-parse HEAD)"
branch="$(git symbolic-ref --quiet --short HEAD || true)"
greater="v999999.0.0"
cleanup() {
  git checkout --quiet "${branch:-$start}"
  git checkout --quiet -- package.json package-lock.json
  git tag --delete "$greater" > /dev/null 2>&1 || true
}
trap cleanup EXIT

expect() {
  local what="$1" output="$2" wanted="$3" unwanted="${4:-}"
  if ! grep -qF -- "$wanted" <<< "$output" || { [ -n "$unwanted" ] && grep -qF -- "$unwanted" <<< "$output"; }; then
    echo "$what: did not say \"$wanted\"${unwanted:+, or said \"$unwanted\"}:" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "$what: as it is to be"
}

npm version --no-git-tag-version --allow-same-version "$release-dev" > /dev/null
expect "a development version newest on develop" \
  "$(DEVELOP=HEAD scripts/publish.sh refs/heads/develop --dry-run 2>&1)" \
  "with tag dev"

git -c user.name=ci -c user.email=ci@localhost commit --quiet --allow-empty -m "a later commit"
later="$(git rev-parse HEAD)"
git checkout --quiet --detach "$start"
expect "a development version a later commit has passed" \
  "$(DEVELOP="$later" scripts/publish.sh refs/heads/develop --dry-run 2>&1)" \
  "nothing is published" "Publishing to"

npm version --no-git-tag-version --allow-same-version "$release" > /dev/null
expect "a release that is the greatest tagged" \
  "$(scripts/publish.sh "refs/tags/v$release" --dry-run 2>&1)" \
  "with tag latest"

git tag "$greater"
expect "a release below one already tagged" \
  "$(scripts/publish.sh "refs/tags/v$release" --dry-run 2>&1)" \
  "with tag release-${release%.*}"
