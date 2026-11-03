// `state`, `getActiveHandlerCount`, `raiseErrorInternal`, `runtime` and
// `HAT_OPCODES` are declared by the `setup` export in src/index.js and are in
// scope here once the extension is compiled.
export function fireAction(args) {
  const name = args.NAME;
  const count = getActiveHandlerCount(state.actionHandlers, name);

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
  const name = args.NAME;
  const count = getActiveHandlerCount(state.queryHandlers, name);

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

  return new Promise((resolve) => {
    const pending = { resolve, settled: false, timer: null, thread: null };
    state.pendingQueries.set(queryId, pending);

    pending.timer = setTimeout(() => {
      // A result or error already reached the caller; never overwrite it.
      if (!state.pendingQueries.has(queryId)) return;
      raiseErrorInternal("SignalsError", "Query did not return a value.");
      settleQuery(queryId, "");
    }, 2000);

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

export function emitEvent(args) {
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
