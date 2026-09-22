// RAM story-arc for silent recollection admission. Session-scoped.
// Stored Track-R units are always user verbatim row ids. Assistant text
// may be held here for Track-C interpretation only and is never persisted.

export type ReminiscenceArcState = 'NO_ARC' | 'ARC_OPEN' | 'ARC_CLOSED';

export class ReminiscenceArcHolder {
  private state: ReminiscenceArcState = 'NO_ARC';
  private rowIds: string[] = [];
  private lastAssistantQuestion: string | null = null;

  peekState(): ReminiscenceArcState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state === 'ARC_OPEN';
  }

  hasDeterministicIdentity(): boolean {
    return this.rowIds.length > 0 && (this.state === 'ARC_OPEN' || this.state === 'ARC_CLOSED');
  }

  peekRowIds(): readonly string[] {
    return this.rowIds;
  }

  /** Track C only. Never written to evidence. */
  noteAssistantQuestion(text: string): void {
    this.lastAssistantQuestion = text.trim() || null;
  }

  peekAssistantQuestion(): string | null {
    return this.lastAssistantQuestion;
  }

  begin(): void {
    this.state = 'ARC_OPEN';
    this.rowIds = [];
    this.lastAssistantQuestion = null;
  }

  appendRow(id: string): void {
    if (this.state !== 'ARC_OPEN') this.begin();
    this.rowIds.push(id);
  }

  dropRow(id: string): void {
    this.rowIds = this.rowIds.filter((rowId) => rowId !== id);
    if (this.rowIds.length === 0 && this.state === 'ARC_OPEN') {
      this.state = 'NO_ARC';
      this.lastAssistantQuestion = null;
    }
  }

  close(): void {
    if (this.state === 'ARC_OPEN') this.state = 'ARC_CLOSED';
  }

  clear(): void {
    this.state = 'NO_ARC';
    this.rowIds = [];
    this.lastAssistantQuestion = null;
  }
}

let defaultArc = new ReminiscenceArcHolder();

export function getDefaultReminiscenceArc(): ReminiscenceArcHolder {
  return defaultArc;
}

export function resetDefaultReminiscenceArc(): void {
  defaultArc = new ReminiscenceArcHolder();
}
