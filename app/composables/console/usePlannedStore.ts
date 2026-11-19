import { createPlannedStore } from '~/utils/console/logic'
import type { PlannedStore } from '~/utils/console/logic'

// The planned roster, stored in this browser under v4w.planned.v1. A private window or
// blocked storage leaves it in memory only (createPlannedStore guards every call).
export function usePlannedStore(): PlannedStore {
  return createPlannedStore(safeStorage())
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
