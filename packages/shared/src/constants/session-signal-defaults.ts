/**
 * A session with no heartbeat within this window reads as ended (issue #983
 * acceptance criterion). Read-time only — never written to a stored
 * document; see `isSessionEntryActive` in the backend session service.
 */
export const SESSION_LIVENESS_WINDOW_MS = 5 * 60 * 1000;
