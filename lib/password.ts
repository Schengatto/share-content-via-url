import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ALGORITHM = "scrypt";
const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_PARALLELIZATION = 4;

interface ScryptParameters {
  cost: number;
  blockSize: number;
  parallelization: number;
}

function memoryLimitFor({ cost, blockSize }: ScryptParameters): number {
  return 256 * cost * blockSize;
}

function derive(password: string, salt: Buffer, parameters: ScryptParameters, length: number): Buffer {
  return scryptSync(password, salt, length, {
    N: parameters.cost,
    r: parameters.blockSize,
    p: parameters.parallelization,
    maxmem: memoryLimitFor(parameters),
  });
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

function areSupported(parameters: ScryptParameters): boolean {
  return (
    isPowerOfTwo(parameters.cost) &&
    Number.isInteger(parameters.blockSize) &&
    parameters.blockSize >= 1 &&
    Number.isInteger(parameters.parallelization) &&
    parameters.parallelization >= 1 &&
    parameters.parallelization <= MAX_PARALLELIZATION &&
    memoryLimitFor(parameters) <= MAX_MEMORY_BYTES
  );
}

export function hashPassword(password: string): string {
  const parameters = { cost: COST, blockSize: BLOCK_SIZE, parallelization: PARALLELIZATION };
  const salt = randomBytes(SALT_BYTES);
  const hash = derive(password, salt, parameters, HASH_BYTES);
  return [ALGORITHM, COST, BLOCK_SIZE, PARALLELIZATION, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function derivePasswordSecret(password: string, salt: Buffer): Buffer {
  return derive(password, salt, { cost: COST, blockSize: BLOCK_SIZE, parallelization: PARALLELIZATION }, HASH_BYTES);
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;
  const [cost, blockSize, parallelization] = parts.slice(1, 4).map(Number);
  const parameters = { cost, blockSize, parallelization };
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!areSupported(parameters) || salt.length === 0 || expected.length === 0) return false;
  return timingSafeEqual(derive(password, salt, parameters, expected.length), expected);
}
