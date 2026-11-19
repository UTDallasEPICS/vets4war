// The console stylesheet: the three cap states each have their own style (final-main's
// test_three_cap_states_are_distinct_and_each_has_a_style), the legend names them, and
// every rule is scoped to the console root so /auth and /admin are untouched.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const css = read('../../../app/assets/css/console.css')
const board = read('../../../app/components/console/ConsoleBoard.vue')

// Selector preludes of style rules, outside @keyframes, comments removed.
function preludes(text: string): string[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  const stack: string[] = []
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      const prelude = src.slice(start, i).trim()
      const inKeyframes = stack.some((s) => s.startsWith('@keyframes'))
      const inRule = stack.length > 0 && !stack[stack.length - 1]!.startsWith('@')
      if (!prelude.startsWith('@') && !inKeyframes && !inRule) out.push(prelude)
      stack.push(prelude)
      start = i + 1
    } else if (ch === '}') {
      stack.pop()
      start = i + 1
    } else if (ch === ';' && stack.length === 0) {
      start = i + 1
    }
  }
  return out
}

// Split a selector list at the commas that are not inside parentheses.
function splitTopLevel(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++
    else if (list[i] === ')') depth--
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(list.slice(start).trim())
  return parts
}

describe('console stylesheet', () => {
  it('styles each of the three cap states and the legend names them', () => {
    for (const cls of ['cap-under', 'cap-at', 'cap-over']) {
      expect((css.match(new RegExp(`\\.${cls}\\b`, 'g')) || []).length).toBeGreaterThanOrEqual(1)
    }
    expect((board.match(/data-legend="(under|at|over)"/g) || []).length).toBe(3)
  })

  it('scopes every selector to the console root', () => {
    const selectors = preludes(css).flatMap(splitTopLevel)
    expect(selectors.length).toBeGreaterThan(300)
    const unscoped = selectors.filter((s) => !s.startsWith('.v4w') && !s.startsWith(':where(.v4w)'))
    expect(unscoped).toEqual([])
  })

  it('is not in a cascade layer, so it wins over Tailwind', () => {
    expect(css).not.toMatch(/@layer/)
  })
})
