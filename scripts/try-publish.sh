#!/usr/bin/env bash
# Takes each path scripts/publish.sh can take, as a dry run, and holds each to what it is to do:
#
#   - a development version newest on develop is published under dev, and one a later commit on
#     develop has passed publishes nothing;
#   - a later commit's development version is newer than an earlier one's, as SemVer orders them,
#     where the later is dated before the earlier and where the two are dated the same second;
#   - a release newer than what latest names is published under latest: where nothing is published,
#     where latest names a development version of it, and beside a greater tag that published
#     nothing;
#   - a release older than latest is published under release-X.Y.Z, which names it alone, whether
#     latest is of another line or of its own;
#   - a release is not published where the registry's answer is not an object of dist-tags, or a
#     dist-tag names what is no version, and each answer the registry can give is read as the
#     publish reads it: dist-tags, what is not JSON, no such package, a refusal, and a failure.
#
# Whatever ref CI runs for and whichever version package.json holds, the same is asked: package.json
# is set as it is on develop and as a release sets it, and what the registry says the dist-tags name
# is set for each. Later commits and a greater tag are made here and taken away again, and
# package.json is put back as it was.
set -euo pipefail
cd "$(dirname "$0")/.."

held="$(jq -r .version package.json)"
release="${held%-dev}"
line="${release%.*}"
patch="${release##*.}"
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

# A commit on top of what is checked out, dated `date`, which leaves package.json as it is.
commit_dated() {
  GIT_COMMITTER_DATE="$1" git -c user.name=ci -c user.email=ci@localhost \
    commit --quiet --allow-empty --date "$1" -m "a later commit"
  git rev-parse HEAD
}

# The development version a commit makes.
version_of() {
  git checkout --quiet --detach "$1"
  scripts/publish.sh refs/heads/develop --check | sed -n 's/^version=//p'
}

npm version --no-git-tag-version --allow-same-version "$release-dev" > /dev/null
expect "a development version newest on develop" \
  "$(DEVELOP=HEAD scripts/publish.sh refs/heads/develop --dry-run 2>&1)" \
  "with tag dev"

later="$(commit_dated "2030-01-01T00:00:00Z")"
git checkout --quiet --detach "$start"
expect "a development version a later commit has passed" \
  "$(DEVELOP="$later" scripts/publish.sh refs/heads/develop --dry-run 2>&1)" \
  "nothing is published" "Publishing to"

# Dated before its parent, and then dated the same second as it.
git checkout --quiet --detach "$later"
earlier="$(commit_dated "2001-01-01T00:00:00Z")"
same="$(commit_dated "2001-01-01T00:00:00Z")"
for pair in "$later $earlier dated-before" "$earlier $same dated-the-same-second-as"; do
  read -r parent child how <<< "$pair"
  if node scripts/newer.mjs "$(version_of "$child")" "$(version_of "$parent")"; then
    echo "a later commit ${how//-/ } its parent: as it is to be"
  else
    echo "a later commit ${how//-/ } its parent makes $(version_of "$child"), not newer than $(version_of "$parent")" >&2
    exit 1
  fi
done
git checkout --quiet --detach "$start"

npm version --no-git-tag-version --allow-same-version "$release" > /dev/null
# What the registry says the dist-tags name, as JSON, from pairs of a dist-tag and a version: made
# by jq, so that nothing in it is read by the shell on the way.
registry() {
  jq -cn '$ARGS.positional | [range(0; length; 2) as $i | {(.[$i]): .[$i + 1]}] | add // {}' --args "$@"
}
publish_release() {
  DIST_TAGS="$(registry "$@")" scripts/publish.sh "refs/tags/v$release" --dry-run 2>&1
}
expect "a release, with nothing published" \
  "$(publish_release)" "with tag latest"
expect "a release, where latest names a development version of it" \
  "$(publish_release latest "$release-dev.1.20260101000000.g000000000000")" "with tag latest"
expect "a release older than a latest of another line" \
  "$(publish_release latest 999999.0.0)" "with tag release-$release "
expect "a release older than a latest of its own line" \
  "$(publish_release latest "$line.$((patch + 1))")" "with tag release-$release "

# What cannot be answered is not answered: the dist-tags not an object, and a dist-tag naming what
# is no version, stop the publish.
expect "a release, where the registry's answer is not an object of dist-tags" \
  "$(DIST_TAGS='<html>' scripts/publish.sh "refs/tags/v$release" --dry-run 2>&1)" \
  "is not an object of them" "Publishing to"
expect "a release, where latest names a number" \
  "$(DIST_TAGS='{"latest":1}' scripts/publish.sh "refs/tags/v$release" --dry-run 2>&1)" \
  "names no version" "Publishing to"
expect "a release, where latest names what is no version" \
  "$(publish_release latest "not-a-version")" \
  "no version to order" "Publishing to"

# What the registry answers, read as the publish reads it: a curl that answers as told, ahead of the
# real one on the path, so the reading of each answer is taken here and not only what comes of it.
# The dist-tags are asked first, and the package itself where they are refused.
fake="$(mktemp -d)"
cat > "$fake/curl" <<'CURL'
#!/usr/bin/env bash
out=/dev/null
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" = --output ]; then
    j=$((i + 1))
    out="${!j}"
  fi
done
case "${*: -1}" in
  */dist-tags) printf '%s' "$TAGS_BODY" > "$out"; printf '%s' "$TAGS_CODE" ;;
  *) printf '%s' "$PACKAGE_CODE" ;;
esac
CURL
chmod +x "$fake/curl"
asked() {
  TAGS_CODE="$1" TAGS_BODY="$2" PACKAGE_CODE="$3" PATH="$fake:$PATH" \
    scripts/publish.sh "refs/tags/v$release" --dry-run 2>&1
}
expect "a release, where the registry names a newer latest" \
  "$(asked 200 '{"latest":"999999.0.0"}' 200)" "with tag release-$release "
expect "a release, where the registry answers what is not JSON" \
  "$(asked 200 '<html>' 200)" "is not an object of them" "Publishing to"
expect "a release, where the registry has no such package" \
  "$(asked 401 '"Unauthorized"' 404)" "with tag latest"
expect "a release, where the registry will not say and has the package" \
  "$(asked 401 '"Unauthorized"' 200)" "would not say" "Publishing to"
expect "a release, where the registry fails" \
  "$(asked 500 'oops' 200)" "would not say" "Publishing to"
rm -rf "$fake"

# A tag whose run refused it, or failed, published nothing, and has no say in what latest names.
git tag "$greater"
expect "a release, beside a greater tag that published nothing" \
  "$(publish_release latest 0.0.1)" "with tag latest"
