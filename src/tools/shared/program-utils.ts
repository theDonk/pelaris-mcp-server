/**
 * Shared program utilities for MCP tools.
 * Extracted from manage_program.ts for reuse across get_program_status + archive_program.
 */

import type { QueryDocumentSnapshot, DocumentSnapshot } from "firebase-admin/firestore";

export function summarizeProgram(doc: QueryDocumentSnapshot | DocumentSnapshot): Record<string, unknown> {
  const d = doc.data()!;
  const sessions = (d.sessions || []) as Array<Record<string, unknown>>;
  const completed = sessions.filter((s) => s.is_completed).length;
  const weeks = [...new Set(sessions.map((s) => s.week_number as number))].sort((a, b) => a - b);

  return {
    queueId: doc.id,
    title: d.title || null,
    methodologyId: d.methodology_id || null,
    sourceProgramId: d.source_program_id || null,
    type: d.type || null,
    totalSessions: sessions.length,
    completedSessions: completed,
    completionPercent: sessions.length > 0 ? Math.round((completed / sessions.length) * 100) : 0,
    totalWeeks: weeks.length,
    generationStatus: d.generation_status || null,
    status: d.status || "active",
    dateCreated: d.date_created?.toDate?.()?.toISOString?.() || null,
    archivedAt: d.archived_at?.toDate?.()?.toISOString?.() || d.archived_at || null,
  };
}
