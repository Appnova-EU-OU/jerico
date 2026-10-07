const SOI = Buffer.from([0xFF, 0xD8])
const EOI = Buffer.from([0xFF, 0xD9])

export class MjpegFrameExtractor {
  private buffer: Buffer = Buffer.alloc(0)
  private subscribed: boolean = false
  private onFrame: (base64: string) => void
  private sourceStream?: NodeJS.ReadableStream

  constructor(onFrame: (base64: string) => void) {
    this.onFrame = onFrame
  }

  bindStream(stream: NodeJS.ReadableStream): void {
    this.sourceStream = stream
    stream.on('data', (chunk: Buffer) => this.feed(chunk))
    stream.pause()
  }

  setSubscribed(v: boolean): void {
    this.subscribed = v
    if (!v) {
      this.sourceStream?.pause()
    } else {
      this.sourceStream?.resume()
    }
  }

  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const soi = this.buffer.indexOf(SOI)
      if (soi === -1) {
        // Keep last byte in case it's 0xFF and next chunk starts with 0xD8
        this.buffer = this.buffer.subarray(-1)
        return
      }
      const eoi = this.buffer.indexOf(EOI, soi + 2)
      if (eoi === -1) return
      const frame = this.buffer.subarray(soi, eoi + 2)
      this.buffer = this.buffer.subarray(eoi + 2)
      if (this.subscribed) {
        this.onFrame(frame.toString('base64'))
      }
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
    this.sourceStream = undefined
  }
}
