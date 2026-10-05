// Whether one version is newer than another, as SemVer orders them: exits 0 where it is, 1 where it
// is not. A version with a prerelease is older than the same version without one, so a release is
// newer than the development versions that led to it.
//
//     node scripts/newer.mjs <version> <than>

const [version, than] = process.argv.slice(2);
if (version === undefined || than === undefined) {
  console.error("usage: node scripts/newer.mjs <version> <than>");
  process.exit(2);
}

/** A version's numbers and its prerelease fields, or a refusal where it is no SemVer version. */
function parts(written) {
  const held = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(written);
  if (held === null) {
    console.error(`${written} is no SemVer version`);
    process.exit(2);
  }
  return { numbers: held.slice(1, 4).map(BigInt), prerelease: held[4]?.split(".") ?? [] };
}

/** Where `a` stands against `b`: below 0, 0 or above 0, as SemVer orders their precedence. */
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) {
      return a.numbers[i] < b.numbers[i] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === y) {
      continue;
    }
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      return BigInt(x) < BigInt(y) ? -1 : 1;
    }
    if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return a.prerelease.length - b.prerelease.length;
}

process.exit(compare(parts(version), parts(than)) > 0 ? 0 : 1);
