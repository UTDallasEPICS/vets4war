/* Small motion helpers for the staffing console. DOM only: no numbers are
 * computed here.
 *
 * countTo() rolls a headline number from the value it showed last to the
 * value just rendered, and always finishes on the exact rendered text, so
 * what stays on screen is the number logic.js produced. pulse() restarts the
 * glow on the roster card. Both do nothing when the visitor asks for reduced
 * motion.
 *
 * Loaded by index.html before app.js.
 */
const V4WMotion = (() => {
  "use strict";
  const COUNT_MS = 260;
  const lastShown = new Map();       // key -> number last rendered for that slot

  const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const easeOut = (k) => 1 - Math.pow(1 - k, 3);

  /**
   * Roll `node` from the previous value of `key` to the integer it now shows.
   * @param {Element|null} node element whose text is the final formatted number
   * @param {string} key names the slot, so a re-rendered node continues from the old value
   * @returns {boolean} true when the value differs from the one shown before
   */
  function countTo(node, key) {
    if (!node) return false;
    const finalText = node.textContent;
    const target = Number(finalText.replace(/,/g, ""));
    const known = finalText.trim() !== "" && Number.isFinite(target);
    const from = lastShown.has(key) ? lastShown.get(key) : 0;
    lastShown.set(key, known ? target : null);
    if (!known || from === null || from === target) return known && from !== target;
    if (reduced()) return true;
    const started = performance.now();
    const step = (now) => {
      if (!node.isConnected) return;   // re-rendered meanwhile: the new node runs its own roll
      const k = Math.min(1, (now - started) / COUNT_MS);
      node.textContent = k < 1 ? Math.round(from + (target - from) * easeOut(k)).toLocaleString() : finalText;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  }

  /** Restart the one-shot glow pulse on `node`. */
  function pulse(node) {
    if (!node || reduced()) return;
    node.classList.remove("pulse");
    void node.offsetWidth;             // reflow, so adding the class again restarts the animation
    node.classList.add("pulse");
  }

  return { countTo, pulse };
})();
