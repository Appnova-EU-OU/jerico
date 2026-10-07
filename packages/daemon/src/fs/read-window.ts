import fs from 'fs'

export type ReadEnd = 'start' | 'end'

export interface FileWindow {
  content: string
  truncated: boolean
  /** Which end was kept, present only when the file did not fit. */
  truncatedFrom?: ReadEnd
  /** Full size on disk, so a caller can tell how much it did not get. */
  size: number
}

/**
 * Read at most `limit` bytes of a text file, from either end.
 *
 * Reading only ever from offset 0 made remote log retrieval useless for the thing
 * it gets reached for: a daemon log big enough to be truncated is truncated at the
 * boring end, and the recent entries — the only ones that explain a live failure —
 * are exactly the ones dropped.
 */
export function readFileWindow(target: string, limit: number, from: ReadEnd = 'start'): FileWindow {
  const size = fs.statSync(target).size
  if (size <= limit) {
    return { content: fs.readFileSync(target, 'utf8'), truncated: false, size }
  }

  const fd = fs.openSync(target, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const offset = from === 'end' ? size - limit : 0
    const bytesRead = fs.readSync(fd, buffer, 0, limit, offset)
    let content = buffer.subarray(0, bytesRead).toString('utf8')

    // A byte-offset window lands mid-line (and possibly mid-codepoint). Drop the
    // partial leading line so a caller never parses a fragment as a whole record.
    if (from === 'end') {
      const firstNewline = content.indexOf('\n')
      if (firstNewline !== -1) content = content.slice(firstNewline + 1)
    }
    return { content, truncated: true, truncatedFrom: from, size }
  } finally {
    fs.closeSync(fd)
  }
}
