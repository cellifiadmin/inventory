// utils/numberChecks.ts

const isNumber = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed);
  }
  return false;
};

const isInteger = (value: unknown): boolean => {
  if (!isNumber(value)) return false;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num);
};

const isFloat = (value: unknown): boolean => {
  if (!isNumber(value)) return false;
  const num = typeof value === 'number' ? value : Number(value);
  return !Number.isInteger(num);
};

const isGreaterThanZeroNumber = (value: unknown): boolean => {
  if (!isNumber(value)) return false;
  return Number(value) > 0;
};

const isLessThanZeroNumber = (value: unknown): boolean => {
  if (!isNumber(value)) return false;
  return Number(value) < 0;
};

const isZero = (value: unknown): boolean => {
  if (!isNumber(value)) return false;
  return Number(value) === 0;
};

const isGreaterThanZeroInteger = (value: unknown): boolean => {
  return isInteger(value) && Number(value) > 0;
};

const isLessThanZeroInteger = (value: unknown): boolean => {
  return isInteger(value) && Number(value) < 0;
};

const isGreaterThanOrEqualZeroNumber = (value: unknown): boolean => {
  return isNumber(value) && Number(value) >= 0;
};
const isLessThanOrEqualZeroNumber = (value: unknown): boolean => {
  return isNumber(value) && Number(value) <= 0;
};
const isGreaterThanOrEqualZeroInteger = (value: unknown): boolean => {
  return isInteger(value) && Number(value) >= 0;
};
const isLessThanOrEqualZeroInteger = (value: unknown): boolean => {
  return isInteger(value) && Number(value) <= 0;
};
export {
  isNumber,
  isInteger,
  isFloat,
  isGreaterThanZeroNumber,
  isLessThanZeroNumber,
  isZero,
  isGreaterThanZeroInteger,
  isLessThanZeroInteger,
  isGreaterThanOrEqualZeroNumber,
  isLessThanOrEqualZeroNumber,
  isGreaterThanOrEqualZeroInteger,
  isLessThanOrEqualZeroInteger,
};
