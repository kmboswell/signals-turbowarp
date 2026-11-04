// `state` and `registerHandler` are declared by the `setup` export in
// src/index.js and are in scope here once the extension is compiled.
export function whenActionReceived(args, util) {
  registerHandler(state.actionHandlers, args.NAME, util);
  const queue = state.actionQueues.get(args.NAME);
  if (queue && queue.length > 0) {
    state.threadData.set(util.thread, queue.shift());
    return true;
  }
  return false;
}

export function whenQueryRequested(args, util) {
  registerHandler(state.queryHandlers, args.NAME, util);
  const queue = state.queryQueues.get(args.NAME);
  if (queue && queue.length > 0) {
    while (queue.length > 0) {
      const request = queue.shift();
      const pending = request ? state.pendingQueries.get(request.id) : undefined;
      if (pending && !pending.settled) {
        pending.thread = util.thread || null;
        state.threadQueryId.set(util.thread, request.id);
        state.threadData.set(util.thread, request.data);
        return true;
      }
    }
  }
  return false;
}

export function whenEventEmitted(args, util) {
  registerHandler(state.eventHandlers, args.NAME, util);
  const queue = state.eventQueues.get(args.NAME);
  const delivery = queue && queue[0];
  if (!delivery) return false;
  // An event is broadcast: the head delivery stays queued for the whole frame,
  // so every handler hat started in it runs, each exactly once.
  if (delivery.served.has(util.blockId)) return false;
  delivery.served.add(util.blockId);
  state.threadData.set(util.thread, delivery.data);
  return true;
}

export function returnValue(args, util) {
  const queryId = takePendingQuery(util && util.thread);
  if (queryId !== undefined) {
    settleQuery(queryId, args.VALUE);
  }
  if (util) {
    if (typeof util.stopThread === "function") {
      return util.stopThread();
    }
    if (util.thread && typeof util.thread.stopThisScript === "function") {
      util.thread.stopThisScript();
    }
  }
}
