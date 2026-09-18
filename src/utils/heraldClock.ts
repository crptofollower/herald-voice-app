// src/utils/heraldClock.ts
// Injectable local calendar date for medical upcoming/past SQL predicates.
// Production never calls setNow — todayLocalISO() is the device-local
// YYYY-MM-DD (en-CA), matching SQLite date('now','localtime'), never UTC
// toISOString().slice(0,10). Tests pin via setNow and must resetNow().

let override: Date | null = null;

export function setNow(instant: Date): void {
  override = new Date(instant.getTime());
}

export function resetNow(): void {
  override = null;
}

export function now(): Date {
  return override ? new Date(override.getTime()) : new Date();
}

export function todayLocalISO(): string {
  return now().toLocaleDateString('en-CA');
}
