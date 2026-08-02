export function createTurnStartGate() {
  let pending: Promise<boolean> | null = null;

  function ensure(
    gen: number,
    currentGen: () => number,
    suspend: () => Promise<{ confirmed: boolean }>,
  ): Promise<boolean> {
    const attachedExisting = !!pending;
    console.log(
      `[RECOVERY-INSTRUMENT] ts=${Date.now()} turn=tts:${gen} gen=tts:${gen} ` +
      `entry=tts_turn_start event=TURN_START_CALLED attachedExisting=${attachedExisting}`
    );

    if (pending) return pending;

    pending = (async () => {
      let confirmed = true;
      try {
        const result = await suspend();
        confirmed = result.confirmed;
      } catch {
        confirmed = false;
      }
      if (gen !== currentGen()) {
        console.log(
          `[RECOVERY-INSTRUMENT] ts=${Date.now()} turn=tts:${gen} gen=tts:${gen} ` +
          `entry=tts_turn_start event=TURN_START_RESOLVED resolution=rejected_stale currentGen=${currentGen()}`
        );
        return false;
      }
      console.log(
        `[RECOVERY-INSTRUMENT] ts=${Date.now()} turn=tts:${gen} gen=tts:${gen} ` +
        `entry=tts_turn_start event=TURN_START_RESOLVED resolution=${confirmed ? 'granted' : 'rejected_suspend_not_confirmed'}`
      );
      return confirmed;
    })();

    return pending;
  }

  function reset() {
    pending = null;
  }

  return { ensure, reset };
}
