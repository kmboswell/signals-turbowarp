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
      if (request && request.id !== undefined && state.queryResolvers.has(request.id)) {
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
  if (queue && queue.length > 0) {
    state.threadData.set(util.thread, queue.shift());
    return true;
  }
  return false;
}

export function returnValue(args, util) {
  const queryId = state.threadQueryId.get(util.thread);
  if (queryId !== undefined) {
    state.threadQueryId.delete(util.thread);
    state.threadData.delete(util.thread);
    const resolve = state.queryResolvers.get(queryId);
    if (resolve) {
      state.queryResolvers.delete(queryId);
      resolve(args.VALUE);
    }
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
