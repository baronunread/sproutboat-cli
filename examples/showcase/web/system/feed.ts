/**
 * What a section's data source must offer so the shared parts (LiveChip, LiveText, LiveNumber) can show it.
 * The fleet store is the first one; each new act writes its own store and implements this.
 */
export type FeedStatus =
  /** No sample yet. */
  | "connecting"
  /** Samples are arriving. */
  | "live"
  /** Samples stopped arriving a few seconds ago: numbers on screen are old and the chip says so. */
  | "stale"
  /** There is no live source where this copy of the page runs: the act shows recorded, dated numbers. */
  | "offline";

export interface Feed {
  readonly status: FeedStatus;
  /** Where the numbers come from, in the feed's own words: shown beside "Live". */
  readonly label: string;
  /** Called when anything a readout shows may have changed. */
  subscribe(listener: () => void): () => void;
  /** Called once per sample that really arrived: the chip's dot beats on this and on nothing else. */
  onSample(listener: () => void): () => void;
}
