/** Date-only calculations shared by board, details and retrospective views. */

/**
 * Read today's local calendar date.
 * @returns ISO calendar date, independent of UTC midnight.
 */
export function localDay(): string {
  const value = new Date()
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

/**
 * Shift a date without crossing daylight-saving time intervals.
 * @param day - ISO calendar date.
 * @param amount - signed number of calendar days.
 * @returns shifted ISO date.
 */
export function shift(day: string, amount: number): string {
  const value = new Date(`${day}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + amount)
  return value.toISOString().slice(0, 10)
}

/**
 * Count date-only intervals.
 * @param from - first ISO calendar date.
 * @param to - second ISO calendar date.
 * @returns signed distance in days.
 */
export function distance(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)
}

/**
 * Find the start of a natural week.
 * @param day - ISO calendar date within the week.
 * @returns Monday's ISO date.
 */
export function monday(day: string): string {
  return shift(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7))
}
