import { customAlphabet } from "nanoid";

/**
 * Lowercase alphanumerics only. IDs end up in URLs, curl commands and on a
 * projector during the demo — a character set with no case ambiguity is worth
 * more than the handful of bits it costs.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const SIZE = 21;

const nano = customAlphabet(ALPHABET, SIZE);

export const ID_PREFIXES = ["proj", "act", "pol", "apr", "evt"] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nano()}`;
}
