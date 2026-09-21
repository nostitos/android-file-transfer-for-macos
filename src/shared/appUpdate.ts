export interface ReleaseCandidate {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

export interface SelectedRelease {
  version: string;
  tag: string;
}

interface ParsedVersion {
  core: [bigint, bigint, bigint];
  prerelease: string[];
  normalized: string;
}

const SEMANTIC_VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemanticVersion(value: string): ParsedVersion | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) {
    return null;
  }
  const match = SEMANTIC_VERSION_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null;
  }
  const normalized = `${match[1]}.${match[2]}.${match[3]}${prerelease.length ? `-${prerelease.join('.')}` : ''}`;
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
    normalized
  };
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    const comparison = comparePrereleasePart(leftPart, rightPart);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

export function compareSemanticVersions(left: string, right: string): number | null {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  if (!parsedLeft || !parsedRight) {
    return null;
  }
  return compareParsedVersions(parsedLeft, parsedRight);
}

export function normalizeSemanticVersion(value: string): string | null {
  return parseSemanticVersion(value)?.normalized ?? null;
}

export function selectLatestRelease(
  currentVersion: string,
  releases: ReleaseCandidate[]
): SelectedRelease | null {
  const current = parseSemanticVersion(currentVersion);
  if (!current) {
    return null;
  }
  let selected: { parsed: ParsedVersion; release: SelectedRelease } | null = null;
  for (const candidate of releases) {
    if (candidate.draft === true || candidate.prerelease === true || typeof candidate.tag_name !== 'string') {
      continue;
    }
    const tag = candidate.tag_name.trim();
    const parsed = parseSemanticVersion(tag);
    if (!parsed || compareParsedVersions(parsed, current) <= 0) {
      continue;
    }
    if (!selected || compareParsedVersions(parsed, selected.parsed) > 0) {
      selected = { parsed, release: { version: parsed.normalized, tag } };
    }
  }
  return selected?.release ?? null;
}
