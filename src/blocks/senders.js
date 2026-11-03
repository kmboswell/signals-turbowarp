// `state`, `getActiveHandlerCount`, `raiseErrorInternal`, `clearErrorStateInternal`,
// `runtime` and `HAT_OPCODES` are declared by the `setup` export in src/index.js
// and are in scope here once the extension is compiled.
export function fireAction(args) {
  // did error occur? describes this signal, not the one before it.
  clearErrorStateInternal();
  const name = args.NAME;
  const count = getActiveHandlerCount(
    state.actionHandlers,
    name,
    HAT_OPCODES.whenActionReceived,
  );

  if (count === 0) {
    raiseErrorInternal("SignalsError", "This action/query has no handler.");
    return;
  }
  if (count >= 2) {
    raiseErrorInternal("SignalsError", "Action has multiple handlers.");
    return;
  }

  if (!state.actionQueues.has(name)) {
    state.actionQueues.set(name, []);
  }
  state.actionQueues.get(name).push(args.DATA);
  try {
    if (runtime) {
      runtime.startHats(HAT_OPCODES.whenActionReceived);
    }
  } catch (e) {
    raiseErrorInternal("SignalsError", e && e.message ? e.message : String(e));
  }
}

export function querySignal(args) {
  // did error occur? describes this signal, not the one before it.
  clearErrorStateInternal();
  const name = args.NAME;
  const count = getActiveHandlerCount(
    state.queryHandlers,
    name,
    HAT_OPCODES.whenQueryRequested,
  );

  if (count === 0) {
    raiseErrorInternal("SignalsError", "This action/query has no handler.");
    return Promise.resolve("");
  }
  if (count >= 2) {
    raiseErrorInternal("SignalsError", "Query has multiple handlers.");
    return Promise.resolve("");
  }

  const queryId = ++state.queryCounter;
  if (!state.queryQueues.has(name)) {
    state.queryQueues.set(name, []);
  }
  state.queryQueues.get(name).push({ id: queryId, data: args.DATA });

  const timeoutMs = state.queryTimeoutMs;

  return new Promise((resolve) => {
    const pending = { resolve, settled: false, timer: null, thread: null };
    state.pendingQueries.set(queryId, pending);

    if (timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        // A result or error already reached the caller; never overwrite it.
        if (!state.pendingQueries.has(queryId)) return;
        raiseErrorInternal(
          "SignalsError",
          `Query '${name}' did not return a value within ${timeoutMs} ms.`,
        );
        settleQuery(queryId, "");
      }, timeoutMs);
    }

    try {
      if (runtime) {
        runtime.startHats(HAT_OPCODES.whenQueryRequested);
      }
    } catch (e) {
      raiseErrorInternal("SignalsError", e && e.message ? e.message : String(e));
      const queue = state.queryQueues.get(name);
      if (queue) {
        const index = queue.findIndex((request) => request.id === queryId);
        if (index !== -1) {
          queue.splice(index, 1);
        }
      }
      settleQuery(queryId, "");
    }
  });
}

export function setQueryTimeout(args) {
  const ms = Math.floor(Number(args.MS));
  if (!Number.isFinite(ms) || ms < 0) {
    raiseErrorInternal(
      "SignalsError",
      `Invalid query timeout '${args.MS}': expected a number of milliseconds, or 0 to disable the timeout.`,
    );
    return;
  }
  state.queryTimeoutMs = ms;
}

export function emitEvent(args) {
  // did error occur? describes this event, not the one before it.
  clearErrorStateInternal();
  const name = args.NAME;
  if (!state.eventQueues.has(name)) {
    state.eventQueues.set(name, []);
  }
  state.eventQueues.get(name).push(args.DATA);
  try {
    if (runtime) {
      runtime.startHats(HAT_OPCODES.whenEventEmitted);
    }
  } catch (e) {
    raiseErrorInternal("SignalsError", e && e.message ? e.message : String(e));
  }
}

export function getSignalData(args, util) {
  if (state.threadData.has(util.thread)) {
    return state.threadData.get(util.thread);
  }
  return state.currentData !== null ? state.currentData : "";
}
