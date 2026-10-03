import { AppError } from '../lib/errors.js';

export const CASE_STATES = [
  'NEW', 'OBSERVING', 'INVESTIGATING', 'DECIDING', 'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING',
  'RESOLVED', 'REFUNDED', 'WAITING_REVERSAL', 'ESCALATED', 'FAILED', 'CLOSED',
];

const CASE_TRANSITIONS = {
  NEW: ['OBSERVING', 'ESCALATED', 'FAILED'],
  OBSERVING: ['INVESTIGATING', 'ESCALATED', 'FAILED'],
  INVESTIGATING: ['DECIDING', 'ESCALATED', 'FAILED'],
  DECIDING: ['AWAITING_APPROVAL', 'EXECUTING', 'WAITING_REVERSAL', 'ESCALATED', 'FAILED'],
  AWAITING_APPROVAL: ['EXECUTING', 'ESCALATED', 'CLOSED', 'DECIDING'],
  EXECUTING: ['VERIFYING', 'FAILED', 'ESCALATED'],
  VERIFYING: ['RESOLVED', 'REFUNDED', 'EXECUTING', 'ESCALATED', 'FAILED'],
  WAITING_REVERSAL: ['RESOLVED', 'ESCALATED', 'DECIDING'],
  ESCALATED: ['DECIDING', 'AWAITING_APPROVAL', 'EXECUTING', 'RESOLVED', 'REFUNDED', 'CLOSED'],
  FAILED: ['ESCALATED', 'CLOSED', 'DECIDING'],
  RESOLVED: ['CLOSED'],
  REFUNDED: ['CLOSED'],
  CLOSED: [],
};

export const ACTION_STATES = [
  'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'VERIFYING', 'VERIFIED', 'COMPENSATING', 'COMPENSATED', 'ESCALATED',
];

const ACTION_TRANSITIONS = {
  PENDING: ['RUNNING', 'ESCALATED'],
  RUNNING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: ['VERIFYING'],
  VERIFYING: ['VERIFIED', 'FAILED'],
  FAILED: ['PENDING', 'COMPENSATING', 'ESCALATED'],
  COMPENSATING: ['COMPENSATED', 'ESCALATED'],
  VERIFIED: [],
  COMPENSATED: [],
  ESCALATED: [],
};

function makeMachine(name, table) {
  const canTransition = (from, to) => (table[from] ?? []).includes(to);
  return {
    name,
    canTransition,
    next: (from) => [...(table[from] ?? [])],
    assert(from, to) {
      if (!(from in table) || !(to in table)) {
        throw new AppError('INVALID_STATE', `Unknown ${name} state ${from} -> ${to}`, 500);
      }
      if (!canTransition(from, to)) {
        throw new AppError('INVALID_TRANSITION', `${name} cannot move ${from} -> ${to}`, 409);
      }
    },
    isTerminal: (s) => (table[s] ?? []).length === 0,
  };
}

export const caseMachine = makeMachine('case', CASE_TRANSITIONS);
export const actionMachine = makeMachine('action', ACTION_TRANSITIONS);
