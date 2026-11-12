'use strict';

const { hashPassword } = require('../security/password-hasher.js');

class RegistrationError extends Error {
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
