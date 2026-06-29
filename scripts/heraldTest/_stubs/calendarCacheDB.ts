// Test stub — returns empty calendar so tierRouter calendar classification
// completes without hitting the DB. Tests check routing only, not content.
export const getCachedEvents = (_window: string) => [];
export const formatCachedEventsForSpeech = (_window: string, _events: any[]) => "";
export const refreshCalendarCache = async () => {};
export const getCacheAge = () => 0;
