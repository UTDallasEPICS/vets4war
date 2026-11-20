// The app is an internal tool: no search engine may crawl any of it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('robots.txt', () => {
  it('disallows all crawling', () => {
    const text = readFileSync(new URL('../../../public/robots.txt', import.meta.url), 'utf8')
    expect(text.split('\n').map((line) => line.trim())).toEqual([
      'User-Agent: *',
      'Disallow: /',
      '',
    ])
  })
})
