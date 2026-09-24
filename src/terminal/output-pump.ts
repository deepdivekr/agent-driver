import {type Readable} from 'node:stream';
import {requireCondition} from '../core/contracts.js';

// A single durable frame can still block on the OS. These bounds limit work
// between event-loop opportunities, not disk latency or kernel pipe memory.
export const OUTPUT_SLICE = Object.freeze({bytes: 65536, frames: 8, ms: 32, gapMs: 25, readableBytes: 131072});
export interface FrameDecoder {push(bytes: Buffer): void; end(): void; discard(): void}
export class OutputPump {
  private chunk: Buffer | null = null;
  private offset = 0;
  private scheduled: NodeJS.Timeout | null = null;
  private inputEnded = false;
  private finished = false;
  private stats = {bytes: 0, frames: 0, slices: 0, max_slice_ms: 0, max_retained_chunk_bytes: 0, max_readable_bytes: 0};
  constructor(private readonly input: Readable, private readonly decoder: FrameDecoder,
    private readonly failure: (code: string) => void, private readonly drained: () => void) {
    // Pull mode leaves Node's bounded readable buffer and the OS pipe to apply
    // backpressure. Never collect parsed events in a second unbounded queue.
    input.on('readable', this.schedule);
    input.on('end', this.end);
    input.on('error', this.error);
    this.schedule();
  }
  observations() {return {...this.stats, drained: this.finished};}
  // A real quiet interval also gives other processes' SQLite writers a chance
  // to acquire the lock. setImmediate alone can repeatedly starve their retries.
  private schedule = () => {if (!this.finished && !this.scheduled) this.scheduled = setTimeout(() => {this.scheduled = null; this.pump();}, OUTPUT_SLICE.gapMs);};
  private end = () => {this.inputEnded = true; this.schedule();};
  private error = () => this.fail('CLI_STDOUT_ERROR');
  private finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null; this.chunk = null; this.offset = 0; this.decoder.discard();
    this.input.off('readable', this.schedule); this.input.off('end', this.end);
    this.drained();
  }
  abort() {
    this.finish();
    // Drain/discard after a terminal failure/cancel so pipe closure cannot wait
    // for a consumer that has already stopped. No further protocol callbacks.
    this.input.resume();
  }
  private fail(code: string) {if (this.finished) return; try {this.failure(code);} finally {this.abort();}}
  private pump() {
    if (this.finished) return;
    const started = performance.now(); let bytes = 0, frames = 0;
    try {
      while (!this.finished && bytes < OUTPUT_SLICE.bytes && frames < OUTPUT_SLICE.frames) {
        const buffered = this.input.readableLength;
        this.stats.max_readable_bytes = Math.max(this.stats.max_readable_bytes, buffered);
        requireCondition(buffered <= OUTPUT_SLICE.readableBytes, 'CLI_OUTPUT_BUFFER_LIMIT');
        if (!this.chunk) {
          if (!buffered) {this.input.read(0); break;}
          this.chunk = this.input.read(Math.min(buffered, OUTPUT_SLICE.bytes)) as Buffer | null;
          this.offset = 0;
          if (!this.chunk) break;
          requireCondition(Buffer.isBuffer(this.chunk), 'CLI_INVALID_STREAM');
          this.stats.max_retained_chunk_bytes = Math.max(this.stats.max_retained_chunk_bytes, this.chunk.length);
        }
        const newline = this.chunk.indexOf(10, this.offset);
        const end = Math.min(newline < 0 ? this.chunk.length : newline + 1, this.offset + OUTPUT_SLICE.bytes - bytes);
        const piece = this.chunk.subarray(this.offset, end); this.offset = end;
        const frame = piece[piece.length - 1] === 10;
        if (this.offset === this.chunk.length) {this.chunk = null; this.offset = 0;}
        bytes += piece.length; this.stats.bytes += piece.length;
        if (frame) {frames++; this.stats.frames++;}
        this.decoder.push(piece);
        // Re-entrant failure/cancel may abort from the event callback.
        if (this.finished || performance.now() - started >= OUTPUT_SLICE.ms) break;
      }
      // A batch ending exactly at the frame limit must still ask the stream to
      // publish EOF. Otherwise no further readable event need occur.
      if (!this.finished && !this.chunk && !this.input.readableLength) this.input.read(0);
      if (!this.finished && this.inputEnded && !this.chunk && !this.input.readableLength) {this.decoder.end(); this.finish();}
    } catch (error) {this.fail(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CLI_PROTOCOL_ERROR');}
    finally {this.stats.slices++; this.stats.max_slice_ms = Math.max(this.stats.max_slice_ms, performance.now() - started);}
    if (!this.finished && (this.chunk || this.input.readableLength || this.inputEnded)) this.schedule();
  }
}
