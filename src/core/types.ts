/** Shared domain types used across services (tour search results, etc.). */

export interface TourOption {
  hotelName: string;
  stars?: number;
  region?: string;
  country?: string;
  meal?: string;
  nights?: number;
  /** Departure date, human-readable (e.g. "15.07.2026"). */
  flyDate?: string;
  price: number;
  currency?: string;
  operator?: string;
  /** Tourvisor hotel rating (0–5), used to rank premium picks. */
  rating?: number;
  /** Tourvisor tour id (used to build a per-tour cart deep link). */
  tourId?: string;
  /** Public link a client can open. */
  link?: string;
}

export interface TourSearchOutcome {
  status: 'ok' | 'empty' | 'error';
  options: TourOption[];
  /** Human note — e.g. an error reason or "search still running". */
  message?: string;
  /**
   * Extra context surfaced to the model even on a successful search — e.g. "the
   * named hotel wasn't found, showing the country instead".
   */
  note?: string;
  /** A link to the full result set on Tourvisor, if available. */
  searchLink?: string;
}
