// Small motion helpers of the staffing console (final-main's web/motion.js). DOM only:
// no numbers are computed here.
//
// countTo() rolls a headline number from the value it showed last to the value just
// rendered, and always finishes on the exact rendered text, so what stays on screen is
// the number logic.ts produced. pulse() restarts the glow on the roster card. Both do
// nothing when the visitor asks for reduced motion. The nodes they touch must not have
// children that Vue patches (the caller writes the final text itself).
const COUNT_MS = 260
// slot key -> number last rendered for that slot
const lastShown = new Map<string, number | null>()

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3)

// Roll `node` from the previous value of `key` to the integer it now shows. Returns
// true when the value differs from the one shown before.
export function countTo(node: Element | null | undefined, key: string): boolean {
  if (!node) return false
  const finalText = node.textContent ?? ''
  const target = Number(finalText.replace(/,/g, ''))
  const known = finalText.trim() !== '' && Number.isFinite(target)
  const from = lastShown.has(key) ? lastShown.get(key)! : 0
  lastShown.set(key, known ? target : null)
  if (!known || from === null || from === target) return known && from !== target
  if (reduced()) return true
  const started = performance.now()
  const step = (now: number) => {
    // re-rendered meanwhile: the new node runs its own roll
    if (!node.isConnected) return
    const k = Math.min(1, (now - started) / COUNT_MS)
    node.textContent =
      k < 1 ? Math.round(from + (target - from) * easeOut(k)).toLocaleString() : finalText
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
  return true
}

// Restart the one-shot glow pulse on `node`.
export function pulse(node: HTMLElement | null | undefined): void {
  if (!node || reduced()) return
  node.classList.remove('pulse')
  // reflow, so adding the class again restarts the animation
  void node.offsetWidth
  node.classList.add('pulse')
}
