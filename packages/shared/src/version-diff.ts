/**
 * P0-1 version diff preview — the frozen cross-boundary shape of
 * `GET /api/documents/:id/versions/:versionId/diff` (`docs/CONTRACTS.md` §12.2).
 *
 * The direction is **current → target**: `delete` is text the restore would remove from the
 * current body, `insert` is text the restore would add from the selected version. The endpoint
 * never returns `yjs_state`; only the two texts, the segments and the counts cross the boundary.
 */
import { z } from 'zod';

export const VERSION_DIFF_SEGMENT_TYPES = ['equal', 'delete', 'insert'] as const;

export const versionDiffSegmentSchema = z
  .object({
    type: z.enum(VERSION_DIFF_SEGMENT_TYPES),
    text: z.string(),
  })
  .strict();

export const versionDiffStatsSchema = z
  .object({
    inserted: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  })
  .strict();

export const versionDiffSchema = z
  .object({
    versionId: z.string().min(1),
    baseRevision: z.number().int().nonnegative(),
    currentRevision: z.number().int().nonnegative(),
    targetText: z.string(),
    currentText: z.string(),
    diff: z.array(versionDiffSegmentSchema),
    stats: versionDiffStatsSchema,
  })
  .strict();

export type VersionDiffSegmentType = (typeof VERSION_DIFF_SEGMENT_TYPES)[number];
export type VersionDiffSegment = z.infer<typeof versionDiffSegmentSchema>;
export type VersionDiffStats = z.infer<typeof versionDiffStatsSchema>;
export type VersionDiff = z.infer<typeof versionDiffSchema>;
