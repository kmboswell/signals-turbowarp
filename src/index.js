import * as handlers from "./blocks/handlers.js";
import * as senders from "./blocks/senders.js";
import * as errors from "./blocks/errors.js";

export const blocks = {
  whenActionReceived: handlers.whenActionReceived,
  whenQueryRequested: handlers.whenQueryRequested,
  whenEventEmitted: handlers.whenEventEmitted,
  returnValue: handlers.returnValue,
  fireAction: senders.fireAction,
  querySignal: senders.querySignal,
  emitEvent: senders.emitEvent,
  getSignalData: senders.getSignalData,
  raiseError: errors.raiseError,
  didErrorOccur: errors.didErrorOccur,
  lastErrorType: errors.lastErrorType,
  lastErrorMessage: errors.lastErrorMessage,
  clearErrorState: errors.clearErrorState,
  registerErrorType: errors.registerErrorType,
  unregisterErrorType: errors.unregisterErrorType,
};

export const methods = {
  _getErrorTypes: errors._getErrorTypes,
};

// Everything below is emitted at the top level of the compiled extension, so
// the block handlers in src/blocks close over these declarations.
export function setup() {
  // extend.yml owns the extension id, but the compiled extension cannot read
  // the manifest, so it is repeated here. Keep the two in sync.
  const EXTENSION_ID = "signals";

  // Scratch composes an extension block's full opcode as
  // `<extension id>_<opcode>`, which is what startHats() looks up.
  const HAT_OPCODES = {
    whenActionReceived: `${EXTENSION_ID}_whenActionReceived`,
    whenQueryRequested: `${EXTENSION_ID}_whenQueryRequested`,
    whenEventEmitted: `${EXTENSION_ID}_whenEventEmitted`,
  };

  // Scratch's Thread.STATUS_DONE; a thread in this state will run no more
  // blocks, so a handler that never reached `return value` is over.
  const THREAD_STATUS_DONE = 0;

  const state = {
    currentData: null,
    errorState: {
      occurred: false,
      type: "",
      message: "",
    },
    registeredErrorTypes: new Set(["SignalsError", "Error"]),
    actionHandlers: new Map(),
    queryHandlers: new Map(),
    eventHandlers: new Map(),
    actionQueues: new Map(),
    eventQueues: new Map(),
    queryQueues: new Map(),
    queryCounter: 0,
    // queryId -> { resolve, settled, timer, thread }
    pendingQueries: new Map(),
    threadQueryId: new Map(),
    threadData: new Map(),
  };

  // Poll explicitly so consecutive queued signals do not need a false edge.
  let runtime = null;
  if (Scratch.vm && Scratch.vm.runtime) {
    runtime = Scratch.vm.runtime;
    runtime.on("BEFORE_EXECUTE", () => {
      settleFinishedQueryThreads();
      runtime.startHats(HAT_OPCODES.whenActionReceived);
      runtime.startHats(HAT_OPCODES.whenQueryRequested);
      runtime.startHats(HAT_OPCODES.whenEventEmitted);
    });
  }

  function registerHandler(handlersMap, name, util) {
    if (!handlersMap.has(name)) {
      handlersMap.set(name, new Map());
    }
    handlersMap.get(name).set(util.blockId, Date.now());
  }

  function getActiveHandlerCount(handlersMap, name) {
    const blockMap = handlersMap.get(name);
    if (!blockMap) return 0;
    const now = Date.now();
    let count = 0;
    for (const [blockId, timestamp] of blockMap.entries()) {
      if (now - timestamp < 300) {
        count++;
      } else {
        blockMap.delete(blockId);
      }
    }
    return count;
  }

  function raiseErrorInternal(type, message) {
    const validType = state.registeredErrorTypes.has(type)
      ? type
      : "SignalsError";
    const validMessage = state.registeredErrorTypes.has(type)
      ? message
      : `Unregistered error type '${type}': ${message}`;
    state.errorState = {
      occurred: true,
      type: validType,
      message: validMessage,
    };
  }

  // Each query is settled at most once: the handler's return value, its error,
  // or the timeout, whichever happens first.
  function settleQuery(queryId, value) {
    const pending = state.pendingQueries.get(queryId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    state.pendingQueries.delete(queryId);
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.resolve(value);
    return true;
  }

  // Forgets the query a handler thread is answering and hands back its id, if
  // any, so the caller can settle it.
  function takePendingQuery(thread) {
    if (thread === undefined || thread === null) return undefined;
    const queryId = state.threadQueryId.get(thread);
    if (queryId !== undefined) {
      state.threadQueryId.delete(thread);
      state.threadData.delete(thread);
    }
    return queryId;
  }

  function abandonPendingQuery(util) {
    const queryId = takePendingQuery(util && util.thread);
    if (queryId !== undefined) {
      settleQuery(queryId, "");
    }
  }

  function isThreadFinished(thread) {
    return !!thread && typeof thread.status === "number" && thread.status === THREAD_STATUS_DONE;
  }

  // A handler script that ends without running `return value` never settles its
  // query on its own, so settle it once its thread is done instead of waiting
  // out the timeout.
  function settleFinishedQueryThreads() {
    for (const [queryId, pending] of state.pendingQueries) {
      if (!pending.settled && isThreadFinished(pending.thread)) {
        settleQuery(queryId, "");
      }
    }
  }
}
