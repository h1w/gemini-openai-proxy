// Errors shared across auth and telegram modules.
//
// These are plain Error subclasses with stable `.name` values so callers
// can switch on them without instanceof coupling through barrels.

export class AuthBrokenError extends Error {
  readonly name = 'AuthBrokenError';
  readonly httpStatus = 503;
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

export class NoPendingLoginError extends Error {
  readonly name = 'NoPendingLoginError';
}

export class StateMismatchError extends Error {
  readonly name = 'StateMismatchError';
}

export class InvalidCallbackUrlError extends Error {
  readonly name = 'InvalidCallbackUrlError';
}

export class OAuthNotSupportedError extends Error {
  readonly name = 'OAuthNotSupportedError';
}
