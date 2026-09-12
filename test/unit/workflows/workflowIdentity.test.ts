import { describe, expect, it } from '@jest/globals';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

describe('cross-owner canonical command identity', () => {
  it('shares a stable recursively sorted JSON hash with the workflow owners', () => {
    expect(workflowInputHash({ b: 2, a: { z: false, x: [1, 'two'] } }))
      .toBe('154d0cf383ca73630f8b82fd34bcd67283a35f4d20242fb774823e3f2b4639dc');
  });
});

import { canonicalWorkflowInput } from '@/inventory/services/workflows/workflowIdentity';
it('accepts plain JSON, null prototypes, and shared noncyclic references', () => {
  const shared = { x: null };
  expect(canonicalWorkflowInput([shared, shared, Object.assign(Object.create(null), { a: 1 })])).toBe('[{"x":null},{"x":null},{"a":1}]');
});
it('rejects non-JSON values, hidden state, cycles, and sparse arrays', () => {
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  const strange = [1]; Object.defineProperty(strange, '0', { get: () => 1 });
  const customKey = [1]; delete customKey[0]; Object.assign(customKey, { x: 1 });
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), cycle, { [Symbol('x')]: 1 },
    Object.defineProperty({}, 'x', { value: 1 }), { get x() { return 1; } }, new Array(1), strange, customKey]) {
    expect(() => canonicalWorkflowInput(value)).toThrow('INVALID_WORKFLOW_INPUT');
  }
});
it('bounds depth and bytes', () => {
  let deep: unknown = null; for (let i = 0; i < 34; i++) deep = [deep];
  expect(() => canonicalWorkflowInput(deep)).toThrow('INVALID_WORKFLOW_INPUT');
  expect(() => canonicalWorkflowInput('a'.repeat(131072))).toThrow('WORKFLOW_INPUT_TOO_LARGE');
});
