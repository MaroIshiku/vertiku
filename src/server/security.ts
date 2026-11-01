import { createHash, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const normalizedIdentifier = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase('en-US');

const secretMatches = (actual: string, expected: string) => {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Accepts surrounding whitespace, one pair of copied YAML quotes, and Unicode compatibility forms of a secret. */
const copiedSecretCandidates = (value: string) => {
  const trimmed = value.trim();
  const candidates = new Set([trimmed, trimmed.normalize('NFKC')]);
  const first = trimmed.at(0); const last = trimmed.at(-1);
  if (trimmed.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    const unquoted = trimmed.slice(1, -1);
    candidates.add(unquoted); candidates.add(unquoted.normalize('NFKC'));
  }
  return [...candidates];
};

export const copiedSecretMatches = (actual: string, expected: string) =>
  copiedSecretCandidates(actual).some((candidate) => copiedSecretCandidates(expected).some((configured) => secretMatches(candidate, configured)));
