import { createHash } from 'node:crypto';
import { WORKFLOW_ERROR, WORKFLOW_INPUT_MAX_BYTES, WORKFLOW_INPUT_MAX_DEPTH } from '@/constants/inventoryWorkflows';

export const canonicalWorkflowInput = (input: unknown): string => {
  const ancestors = new Set<object>();
  const encode = (value: unknown, depth: number): string => {
    if (depth > WORKFLOW_INPUT_MAX_DEPTH) throw new Error(WORKFLOW_ERROR.INVALID_INPUT);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== 'object') throw new Error(WORKFLOW_ERROR.INVALID_INPUT);
    if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) throw new Error(WORKFLOW_ERROR.INVALID_INPUT);
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!isArray && prototype !== Object.prototype && prototype !== null) throw new Error(WORKFLOW_ERROR.INVALID_INPUT);
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter(key => !isArray || key !== 'length');
    if (isArray && keys.length !== value.length) throw new Error(WORKFLOW_ERROR.INVALID_INPUT);
    for (const key of keys) {
      if (!('value' in descriptors[key]) || !descriptors[key].enumerable) throw new Error(WORKFLOW_ERROR.INVALID_INPUT);
    }
    const encoded = isArray
      ? '[' + Array.from({ length: value.length }, (_, index) => {
        if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) throw new Error(WORKFLOW_ERROR.INVALID_INPUT);
        return encode(descriptors[String(index)].value, depth + 1);
      }).join(',') + ']'
      : '{' + keys.sort().map(key => JSON.stringify(key) + ':' + encode(descriptors[key].value, depth + 1)).join(',') + '}';
    ancestors.delete(value);
    return encoded;
  };
  const encoded = encode(input, 0);
  if (Buffer.byteLength(encoded, 'utf8') > WORKFLOW_INPUT_MAX_BYTES) throw new Error(WORKFLOW_ERROR.INPUT_TOO_LARGE);
  return encoded;
};

export const workflowInputHash = (input: unknown): string =>
  createHash('sha256').update(canonicalWorkflowInput(input)).digest('hex');
