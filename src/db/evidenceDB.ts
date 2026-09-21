// src/db/evidenceDB.ts
// Durable Evidence Substrate V1 — storage only.
// Unconfirmed authorized personal evidence. Not medical_records, facts,
// contacts, notes, observations, calendar_cache, or appointments.
// No routing, promotion, fuzzy retrieval, or entity minting.

import { getDB } from "./schema";

export const EVIDENCE_SOURCE_CLASSES = ["external_source", "user_explicit"] as const;
export type EvidenceSourceClass = (typeof EVIDENCE_SOURCE_CLASSES)[number];

export type EvidenceRecord = {
  id: string;
  sourceClass: EvidenceSourceClass;
  sourceKind: string;
  sourceId: string | null;
  rawText: string;
  observedAt: string;
};

export type PersistEvidenceInput = {
  sourceClass: EvidenceSourceClass;
  sourceKind: string;
  sourceId?: string | null;
  rawText: string;
  observedAt?: string;
  /** User-explicit only. Same capture identity is the same row; omitted mints a new id. */
  captureId?: string | null;
};

export type ActiveEvidenceSelector = {
  sourceClass: EvidenceSourceClass;
  sourceKind?: string;
  sourceId?: string;
};

type EvidenceRow = {
  id: string;
  source_class: string;
  source_kind: string;
  source_id: string | null;
  raw_text: string;
  observed_at: string;
};

function isSourceClass(value: string): value is EvidenceSourceClass {
  return (EVIDENCE_SOURCE_CLASSES as readonly string[]).includes(value);
}

function mapRow(row: EvidenceRow): EvidenceRecord {
  if (!isSourceClass(row.source_class)) {
    throw new Error(`evidence: stored source_class is not authorized: ${row.source_class}`);
  }
  return {
    id: row.id,
    sourceClass: row.source_class,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    rawText: row.raw_text,
    observedAt: row.observed_at,
  };
}

function mintEvidenceId(): string {
  return `ev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeOptionalId(value: string | null | undefined): string | null {
  const t = value?.trim() ?? "";
  return t.length > 0 ? t : null;
}

export function persistEvidence(input: PersistEvidenceInput): EvidenceRecord {
  const db = getDB();
  if (!isSourceClass(input.sourceClass)) {
    throw new Error("evidence: source_class must be external_source or user_explicit");
  }
  const sourceKind = input.sourceKind.trim();
  if (!sourceKind) throw new Error("evidence: source_kind is required");
  const rawText = input.rawText;
  if (typeof rawText !== "string" || rawText.length === 0) {
    throw new Error("evidence: raw_text is required without fabrication");
  }
  const sourceId = normalizeOptionalId(input.sourceId);
  const observedAt = input.observedAt?.trim() || new Date().toISOString();

  if (input.sourceClass === "external_source" && sourceId) {
    const existing = db.getFirstSync<EvidenceRow>(
      `SELECT id, source_class, source_kind, source_id, raw_text, observed_at
         FROM evidence
        WHERE source_class = 'external_source'
          AND source_kind = ?
          AND source_id = ?;`,
      [sourceKind, sourceId],
    );
    if (existing) return mapRow(existing);
  }

  const captureId =
    input.sourceClass === "user_explicit" ? normalizeOptionalId(input.captureId) : null;
  if (captureId) {
    const existing = db.getFirstSync<EvidenceRow>(
      `SELECT id, source_class, source_kind, source_id, raw_text, observed_at
         FROM evidence WHERE id = ?;`,
      [captureId],
    );
    if (existing) return mapRow(existing);
  }

  const id = captureId ?? mintEvidenceId();
  db.runSync(
    `INSERT INTO evidence (id, source_class, source_kind, source_id, raw_text, observed_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [id, input.sourceClass, sourceKind, sourceId, rawText, observedAt],
  );
  const stored = db.getFirstSync<EvidenceRow>(
    `SELECT id, source_class, source_kind, source_id, raw_text, observed_at
       FROM evidence WHERE id = ?;`,
    [id],
  );
  if (!stored) throw new Error("evidence: persist failed to round-trip");
  return mapRow(stored);
}

export function getEvidenceById(id: string): EvidenceRecord | null {
  const db = getDB();
  const row = db.getFirstSync<EvidenceRow>(
    `SELECT id, source_class, source_kind, source_id, raw_text, observed_at
       FROM evidence WHERE id = ?;`,
    [id],
  );
  return row ? mapRow(row) : null;
}

export function listActiveEvidence(selector: ActiveEvidenceSelector): EvidenceRecord[] {
  const db = getDB();
  if (!isSourceClass(selector.sourceClass)) {
    throw new Error("evidence: selector source_class must be external_source or user_explicit");
  }
  const clauses = ["source_class = ?"];
  const params: string[] = [selector.sourceClass];
  if (selector.sourceKind !== undefined) {
    clauses.push("source_kind = ?");
    params.push(selector.sourceKind);
  }
  if (selector.sourceId !== undefined) {
    clauses.push("source_id = ?");
    params.push(selector.sourceId);
  }
  const rows = db.getAllSync<EvidenceRow>(
    `SELECT id, source_class, source_kind, source_id, raw_text, observed_at
       FROM evidence
      WHERE ${clauses.join(" AND ")}
      ORDER BY observed_at ASC, id ASC;`,
    params,
  );
  return rows.map(mapRow);
}
