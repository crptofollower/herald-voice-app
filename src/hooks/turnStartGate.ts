export function createTurnStartGate() {
  let pending: Promise<boolean> | null = null;

  function ensure(
    gen: number,
    currentGen: () => number,
    suspend: () => Promise<{ confirmed: boolean }>,
  ): Promise<boolean> {
    if (pending) return pending;

    pending = (async () => {
      let confirmed = true;
      try {
        const result = await suspend();
        confirmed = result.confirmed;
      } catch {
        confirmed = false;
      }
      if (gen !== currentGen()) return false;
      return confirmed;
    })();

    return pending;
  }

  function reset() {
    pending = null;
  }

  return { ensure, reset };
}
