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

export class ModelValidationError extends Error {
  readonly name = 'ModelValidationError';
  readonly httpStatus = 400;
  readonly param = 'model';
  readonly code: 'model_required' | 'model_not_found';
  readonly allowed: readonly string[];
  readonly requested?: string;

  constructor(
    code: 'model_required' | 'model_not_found',
    message: string,
    allowed: readonly string[],
    requested?: string,
  ) {
    super(message);
    this.code = code;
    this.allowed = allowed;
    this.requested = requested;
  }
}
