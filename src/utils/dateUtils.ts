/**
 * Checks if two time periods overlap.
 * Handles null values as "infinite" (no end date).
 *
 * @param validFrom1 - Start date of first period
 * @param validTo1 - End date of first period (null = infinite)
 * @param validFrom2 - Start date of second period
 * @param validTo2 - End date of second period (null = infinite)
 * @returns true if periods overlap, false otherwise
 *
 * @example
 * // Check if [2024-01-01, 2024-01-31] overlaps with [2024-01-15, null]
 * doPeriodsOverlap(
 *   new Date('2024-01-01'),
 *   new Date('2024-01-31'),
 *   new Date('2024-01-15'),
 *   null
 * ) // Returns true
 */
export const doPeriodsOverlap = (
  validFrom1: Date,
  validTo1: Date | null,
  validFrom2: Date,
  validTo2: Date | null
): boolean => {
  // Treat null as far future date for comparison
  const end1 = validTo1 || new Date('2099-12-31');
  const end2 = validTo2 || new Date('2099-12-31');

  // Periods overlap if: start1 <= end2 AND end1 >= start2
  return validFrom1 <= end2 && end1 >= validFrom2;
};
