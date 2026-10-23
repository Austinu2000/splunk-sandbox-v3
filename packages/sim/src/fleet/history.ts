/**
 * Ring buffer of health transitions within the retention window.
 * Later milestones use stateAt() to decide whether a host emitted events at a past time.
 */
export class HealthHistory {
  private readonly time: Float64Array;
  private readonly row: Uint32Array;
  private readonly from: Uint8Array;
  private readonly to: Uint8Array;
  private start = 0;
  private len = 0;
  /** Transitions dropped because the buffer was full (not because they aged out). */
  overflowed = 0;

  constructor(readonly capacity: number) {
    this.time = new Float64Array(capacity);
    this.row = new Uint32Array(capacity);
    this.from = new Uint8Array(capacity);
    this.to = new Uint8Array(capacity);
  }

  get length(): number {
    return this.len;
  }

  push(time: number, row: number, from: number, to: number): void {
    if (this.len === this.capacity) {
      this.start = (this.start + 1) % this.capacity;
      this.len--;
      this.overflowed++;
    }
    const i = (this.start + this.len) % this.capacity;
    this.time[i] = time;
    this.row[i] = row;
    this.from[i] = from;
    this.to[i] = to;
    this.len++;
  }

  /** Drop transitions older than `before`. */
  prune(before: number): void {
    while (this.len > 0 && this.time[this.start]! < before) {
      this.start = (this.start + 1) % this.capacity;
      this.len--;
    }
  }

  /** Oldest time this history can answer for exactly. */
  get oldest(): number {
    return this.len === 0 ? Infinity : this.time[this.start]!;
  }

  /** Health code of `row` at `time`, given its current health. Times before `oldest` are a best guess. */
  stateAt(row: number, time: number, current: number): number {
    let state = current;
    for (let k = this.len - 1; k >= 0; k--) {
      const i = (this.start + k) % this.capacity;
      if (this.time[i]! <= time) break;
      if (this.row[i] === row) state = this.from[i]!;
    }
    return state;
  }

  /**
   * One pass over the buffer that returns a fast state lookup for `row` at any time after `after`,
   * plus that row's transitions in order. Use this instead of repeated stateAt() calls.
   */
  timeline(
    row: number,
    after: number,
    current: number,
  ): { stateAt(time: number): number; transitions: { time: number; from: number; to: number }[] } {
    const transitions: { time: number; from: number; to: number }[] = [];
    for (let k = 0; k < this.len; k++) {
      const i = (this.start + k) % this.capacity;
      if (this.row[i] === row && this.time[i]! > after)
        transitions.push({ time: this.time[i]!, from: this.from[i]!, to: this.to[i]! });
    }
    return {
      transitions,
      stateAt(time: number): number {
        for (const t of transitions) if (t.time > time) return t.from;
        return current;
      },
    };
  }

  *entries(): Generator<{ time: number; row: number; from: number; to: number }> {
    for (let k = 0; k < this.len; k++) {
      const i = (this.start + k) % this.capacity;
      yield { time: this.time[i]!, row: this.row[i]!, from: this.from[i]!, to: this.to[i]! };
    }
  }
}
