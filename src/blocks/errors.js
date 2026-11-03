// `state` and `raiseErrorInternal` are declared by the `setup` export in
// src/index.js and are in scope here once the extension is compiled.
export function raiseError(args, util) {
  const type = args.TYPE || "Error";
  const message = args.MESSAGE || "An error occurred.";
  raiseErrorInternal(type, message);
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
  state.errorState = {
    occurred: false,
    type: "",
    message: "",
  };
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
