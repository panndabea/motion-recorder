/** Snapshot-based undo/redo. Snapshots are immutable values (the store never mutates them). */
export class UndoHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private readonly limit = 100) {}

  /** Records `previous` as the state to return to on undo. */
  push(previous: T) {
    this.past.push(previous);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: T): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(current);
    return prev;
  }
  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
}
