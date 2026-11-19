// Types of ./compare.mjs for the TypeScript tests that share it.
export interface Answer {
  status: number
  body: unknown
}
export interface Finding {
  path: string
  expected: unknown
  got: unknown
  why: string
}
export const ABS_TOLERANCE: number
export const REL_TOLERANCE: number
export const ROUNDED_TOLERANCE: number
export const TALK_SEC_TOLERANCE: number
export function compareAnswer(
  expected: Answer,
  actual: Answer,
  options?: { requestPath?: string }
): { differences: Finding[]; warnings: Finding[] }
export function formatDifference(finding: Finding): string
