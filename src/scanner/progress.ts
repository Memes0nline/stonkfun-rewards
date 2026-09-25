/** Scan phases describe work actually attempted by this run, not estimated completion. */
export const SCAN_PHASES = [
  'preparing', 'registry', 'metadata', 'planning', 'history', 'evidence',
  'normalization', 'authority', 'classification', 'pricing', 'checkpoint', 'report', 'complete',
] as const;
export type ScanPhase = typeof SCAN_PHASES[number];
export type ProgressUnit = 'days' | 'signatures' | 'assets';
export interface ScanProgress {
  jobId: string;
  /** Legacy observer label; phase/kind carry the typed journey. */
  stage: string;
  count?: number;
  phase: ScanPhase;
  kind: 'started' | 'activity' | 'completed';
  at: number;
  action: string;
  progress?: { completed: number; total: number; unit: ProgressUnit };
  awaitingProvider?: boolean;
}
