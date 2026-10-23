const COMPONENT_MODULES = { history: 'dsh-replay/history', retry: 'dsh-replay/retry' };
export const COMPONENT_POLL_MS = 1000;

export function createComponentController(ctx, components) {
  const fibers = new Map();
  let closed = false;
  let epoch = 0;
  let inFlight;
  let lifecycle = Promise.resolve();
  let warned = false;

  function reconcile(state, generation) {
    const task = lifecycle.then(async () => {
      for (const key of Object.keys(COMPONENT_MODULES)) {
        if (closed || generation !== epoch) return;
        if (state[key]) {
          if (!fibers.has(key)) fibers.set(key, ctx.plugin(components[key]));
        } else {
          const fiber = fibers.get(key);
          if (!fiber) continue;
          await fiber.dispose();
          fibers.delete(key);
        }
      }
    });
    lifecycle = task.catch(() => {});
    return task;
  }

  function refresh() {
    if (closed) return Promise.resolve();
    if (inFlight) return inFlight;
    const generation = epoch;
    const request = (async () => {
      try {
        const result = await ctx.remote.pluginInventory.list();
        if (closed || generation !== epoch) return;
        if (result?.ok !== true || !Array.isArray(result.value?.entries)) throw new Error('Native component inventory is unavailable');
        const state = {};
        for (const [key, moduleName] of Object.entries(COMPONENT_MODULES)) {
          const rows = result.value.entries.filter((entry) => entry?.moduleName === moduleName);
          if (rows.length !== 1 || typeof rows[0].enabled !== 'boolean') throw new Error('Native component entry is missing or ambiguous: ' + moduleName);
          state[key] = rows[0].enabled;
        }
        await reconcile(state, generation);
        warned = false;
      } catch (error) {
        if (closed || generation !== epoch) return;
        if (!warned) {
          warned = true;
          console.warn('[dsh-replay] Native component synchronization failed; keeping the last verified state.', error);
        }
      }
    })();
    inFlight = request;
    void request.then(() => { if (inFlight === request) inFlight = undefined; });
    return request;
  }

  return {
    refresh,
    reset() {
      if (closed) return Promise.resolve();
      epoch += 1;
      inFlight = undefined;
      return reconcile({ history: false, retry: false }, epoch).then(refresh);
    },
    async dispose() {
      if (closed) return lifecycle;
      closed = true;
      epoch += 1;
      const task = lifecycle.then(async () => {
        const errors = [];
        for (const fiber of fibers.values()) {
          try { await fiber.dispose(); } catch (error) { errors.push(error); }
        }
        fibers.clear();
        if (errors.length) throw new AggregateError(errors, 'Component disposal failed');
      });
      lifecycle = task.catch(() => {});
      return task;
    },
  };
}
