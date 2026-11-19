// Review W3-8: start-up removes only the upload folders a stopped process left, never
// those of another process on the same host that may be reading a file right now.
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  UPLOAD_FOLDER_PREFIX,
  makeUploadFolder,
  removeLeftoverUploadFiles,
} from '../../../server/utils/ingest/tempfiles'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'v4w-tempfiles-test-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('upload temp folders', () => {
  it('names a folder after the process that made it', async () => {
    const folder = await makeUploadFolder(dir)
    expect(folder.startsWith(join(dir, `${UPLOAD_FOLDER_PREFIX}${process.pid}-`))).toBe(true)
  })

  it('removes the folders of gone processes, of this pid and without a pid; keeps a live one', async () => {
    const LIVE = 4242
    const DEAD = 4343
    for (const name of [`${LIVE}-aaaaaa`, `${DEAD}-bbbbbb`, `${process.pid}-cccccc`, 'dddddd']) {
      await mkdir(join(dir, UPLOAD_FOLDER_PREFIX + name))
    }
    await mkdir(join(dir, 'someone-else'))
    const removed = await removeLeftoverUploadFiles(dir, (pid) => pid === LIVE)
    expect(removed).toBe(3)
    expect((await readdir(dir)).sort()).toEqual([
      'someone-else',
      `${UPLOAD_FOLDER_PREFIX}${LIVE}-aaaaaa`,
    ])
  })
})
