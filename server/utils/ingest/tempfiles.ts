// Where an upload's bytes wait while they are read: a private folder per upload in the
// OS temp directory, named after the process that made it, so a process cleaning up at
// start-up removes only what a stopped process left (review W3-8: another server on the
// same host, or a dev server next to a preview, may be reading a file right now).
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const UPLOAD_FOLDER_PREFIX = 'v4w-upload-'

export function makeUploadFolder(dir: string = tmpdir()): Promise<string> {
  return mkdtemp(join(dir, `${UPLOAD_FOLDER_PREFIX}${process.pid}-`))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// At start-up nothing in this process is reading yet: a folder of this pid (a reused pid
// after a restart), of a pid that is gone, or without a pid (older versions) is left over.
export async function removeLeftoverUploadFolders(
  dir: string = tmpdir(),
  alive: (pid: number) => boolean = isAlive
): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(UPLOAD_FOLDER_PREFIX)) continue
    const pid = /^(\d+)-/.exec(name.slice(UPLOAD_FOLDER_PREFIX.length))?.[1]
    const owner = pid === undefined ? null : Number(pid)
    if (owner !== null && owner !== process.pid && alive(owner)) continue
    await rm(join(dir, name), { recursive: true, force: true })
    removed++
  }
  return removed
}
