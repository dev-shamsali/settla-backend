export class IntegrationError extends Error {
  constructor(system, code, message, { retryable = false, status } = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.system = system;
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}
export const timeoutErr = (s) => new IntegrationError(s, 'INTEGRATION_TIMEOUT', `${s} timed out`, { retryable: true });
export const rateErr = (s) => new IntegrationError(s, 'INTEGRATION_RATE_LIMITED', `${s} rate limited`, { retryable: true });
export const failErr = (s, m = 'request failed') => new IntegrationError(s, 'INTEGRATION_FAILURE', `${s} ${m}`);
export const notConfigured = (s) => new IntegrationError(s, 'INTEGRATION_NOT_CONFIGURED', `${s} is not configured`);
