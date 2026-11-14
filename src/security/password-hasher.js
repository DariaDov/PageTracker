'use strict';

/**
 * @fileoverview Password hashing and verification using Node.js scrypt.
 */

const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;

/**
 * Derives a password hash using scrypt and a cryptographically random salt.
 *
 * The returned self-describing string contains the fixed work parameters, salt,
 * and derived key in base64url form; the plaintext password is never returned.
 *
 * @param {string} password Non-empty plaintext password.
 * @returns {Promise<string>} Encoded scrypt hash suitable for persistence.
 * @throws {TypeError} If password is not a non-empty string.
 */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Password must be a non-empty string');
  }

  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
  });

  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

/**
 * Checks a password against a hash produced by {@link hashPassword}.
 *
 * Malformed, unsupported, or non-string inputs return false. Key comparison is
 * performed with `timingSafeEqual`.
 *
 * @param {string} password Candidate plaintext password.
 * @param {string} encodedHash Encoded scrypt hash.
 * @returns {Promise<boolean>} Whether the hash is valid and matches password.
 */
async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') {
    return false;
  }

  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, cost, blockSize, parallelization, encodedSalt, encodedKey] = parts;
  if (
    cost !== String(COST) ||
    blockSize !== String(BLOCK_SIZE) ||
    parallelization !== String(PARALLELIZATION) ||
    !/^[A-Za-z0-9_-]+$/.test(encodedSalt) ||
    !/^[A-Za-z0-9_-]+$/.test(encodedKey)
  ) {
    return false;
  }

  const salt = Buffer.from(encodedSalt, 'base64url');
  const expectedKey = Buffer.from(encodedKey, 'base64url');
  if (salt.length !== SALT_LENGTH || expectedKey.length !== KEY_LENGTH) {
    return false;
  }

  const actualKey = await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
  });

  return timingSafeEqual(actualKey, expectedKey);
}

module.exports = { hashPassword, verifyPassword };
