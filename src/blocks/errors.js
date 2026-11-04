// `state`, `raiseErrorInternal`, `clearErrorStateInternal`, `abandonPendingQuery`
// and `settleQuery` are declared by the `setup` export in src/index.js and are
// in scope here once the extension is compiled.
export function raiseError(args, util) {
  const type = args.TYPE || "Error";
  const message = args.MESSAGE || "An error occurred.";
  raiseErrorInternal(type, message);
  // The caller of a query must not wait out the timeout when its handler stops
  // with an error. Settle it now; didErrorOccur() keeps the handler's error.
  abandonPendingQuery(util);
  if (util) {
    if (typeof util.stopThread === "function") {
      return util.stopThread();
    }
    if (util.thread && typeof util.thread.stopThisScript === "function") {
      util.thread.stopThisScript();
    }
  }
}

export function didErrorOccur() {
  return state.errorState.occurred;
}

export function lastErrorType() {
  return state.errorState.type;
}

export function lastErrorMessage() {
  return state.errorState.message;
}

export function clearErrorState() {
  clearErrorStateInternal();
}

export function registerErrorType(args) {
  if (args.TYPE) {
    state.registeredErrorTypes.add(args.TYPE);
  }
}

export function unregisterErrorType(args) {
  const type = args.TYPE;
  if (type && type !== "SignalsError" && type !== "Error") {
    state.registeredErrorTypes.delete(type);
  }
}

export function _getErrorTypes() {
  const types = Array.from(state.registeredErrorTypes);
  return types.length > 0 ? types : ["SignalsError"];
}
