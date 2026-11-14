'use strict';

/**
 * @fileoverview Registration application service and its domain error contract.
 */

const { hashPassword } = require('../security/password-hasher.js');

/**
 * Registration failure that the API layer converts to a problem response.
 *
 * @property {number} status HTTP status associated with the failure.
 * @property {string} code Stable machine-readable error code.
 * @property {string} detail User-facing error detail.
 * @property {Array<{pointer: string, code: string, message: string}>|undefined} errors
 *   Optional field-level validation errors.
 */
class RegistrationError extends Error {
  /**
   * @param {number} status HTTP status for the registration failure.
   * @param {string} code Stable machine-readable error code.
   * @param {string} detail User-facing error detail.
   * @param {Array<{pointer: string, code: string, message: string}>} [errors]
   *   Field-level validation errors, when applicable.
   */
  constructor(status, code, detail, errors) {
    super(detail);
    this.name = 'RegistrationError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.errors = errors;
  }
}

function validationErrors(email, password) {
  const errors = [];
  if (typeof email !== 'string' || email.trim().length === 0) {
    errors.push({ pointer: '/email', code: 'required', message: 'заповніть дані' });
  }
  if (typeof password !== 'string' || password.trim().length === 0) {
    errors.push({ pointer: '/password', code: 'required', message: 'заповніть дані' });
  }
  return errors;
}

function isDuplicateEmailError(error) {
  return error?.code === '23505' && error?.constraint === 'users_email_key';
}

/**
 * Creates a user account without creating an authenticated session.
 *
 * Email and password must be strings containing at least one non-whitespace
 * character. Their original values are preserved. The store must expose
 * `users.findByEmail(email)` and `users.create({ email, passwordHash })`; its
 * unique email constraint must be named `users_email_key` to identify a
 * concurrent duplicate registration.
 *
 * @param {object} options Registration input and persistence adapter.
 * @param {object} options.store User repository adapter exposing
 *   `findByEmail(email)` and `create({ email, passwordHash })`.
 * @param {string} options.email Email value to store.
 * @param {string} options.password Plaintext password; only its hash is stored.
 * @returns {Promise<{id: string, email: string}>} Public account fields; no
 *   password data or session token is returned.
 * @throws {RegistrationError} For missing/blank credentials (422) or an
 *   existing email (409).
 * @throws {Error} Propagates hashing and persistence errors other than the
 *   recognized duplicate-email constraint.
 */
async function registerUser({ store, email, password }) {
  const errors = validationErrors(email, password);
  if (errors.length > 0) {
    throw new RegistrationError(422, 'VALIDATION_ERROR', 'заповніть дані', errors);
  }

  const existingUser = await store.users.findByEmail(email);
  if (existingUser) {
    throw new RegistrationError(409, 'EMAIL_ALREADY_EXISTS', 'Неправильні дані');
  }

  const passwordHash = await hashPassword(password);
  let user;
  try {
    user = await store.users.create({ email, passwordHash });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      throw new RegistrationError(409, 'EMAIL_ALREADY_EXISTS', 'Неправильні дані');
    }
    throw error;
  }

  return { id: user.id, email: user.email };
}

module.exports = { RegistrationError, registerUser };
