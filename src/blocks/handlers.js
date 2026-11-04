// `state`, `registerHandler` and `getHatBlockId` are declared by the `setup`
// export in src/index.js and are in scope here once the extension is compiled.
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
  if (!queue) return false;
  // An event is broadcast: every handler takes each emission exactly once. A
  // delivery is not retired until every live handler has taken it, so a
  // handler that was still running when the event arrived takes it from the
  // queue as soon as it is free. A handler skips the deliveries it already
  // took, so one slow handler does not hold up the others.
  const handler = getHandlerId(util);
  for (const delivery of queue) {
    if (delivery.served.has(handler)) continue;
    delivery.served.add(handler);
    state.threadData.set(util.thread, delivery.data);
    return true;
  }
  return false;
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
