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

  // Scratch's Thread statuses; a thread that is neither running nor done is
  // parked on a yield or a promise.
  const THREAD_STATUS_DONE = 0;
  const THREAD_STATUS_RUNNING = 2;

  // How recently a hat predicate must have run for a hat whose NAME is not a
  // literal to count as a handler. Deliberately generous: a long frame or a
  // throttled background tab can pause the runtime for seconds, and a handler
  // thread can run for a while without the hat predicate running again.
  const HAT_FALLBACK_WINDOW_MS = 60 * 1000;

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
    let blockMap = handlersMap.get(name);
    if (!blockMap) {
      blockMap = new Map();
      handlersMap.set(name, blockMap);
    }
    blockMap.set(util.blockId, { timestamp: Date.now(), thread: util.thread || null });
  }

  function getBlock(target, blockId) {
    const blocks = target && target.blocks;
    if (!blocks || !blockId) return null;
    if (typeof blocks.getBlock === "function") return blocks.getBlock(blockId) || null;
    return (blocks._blocks && blocks._blocks[blockId]) || null;
  }

  // Top-level hat blocks of this opcode, keyed by block id, across every target.
  function findHats(hatOpcode) {
    const hats = new Map();
    if (!runtime || !Array.isArray(runtime.targets)) return hats;
    for (const target of runtime.targets) {
      const blocks = target && target.blocks;
      if (!blocks || !Array.isArray(blocks._scripts)) continue;
      for (const blockId of blocks._scripts) {
        const block = getBlock(target, blockId);
        if (block && block.opcode === hatOpcode) {
          hats.set(blockId, { target, block });
        }
      }
    }
    return hats;
  }

  // The name a hat is wired to, when that name is a literal. A reporter plugged
  // into the NAME slot can only be evaluated by the runtime, so it has none.
  function getLiteralName(target, block) {
    if (block.fields && block.fields.NAME) {
      const fieldValue = block.fields.NAME.value;
      return fieldValue === undefined ? null : String(fieldValue);
    }
    const input = block.inputs && block.inputs.NAME;
    if (!input) return null;
    if (input.block && input.shadow && input.block !== input.shadow) return null;
    const valueId = input.shadow || input.block;
    if (!valueId) return null;
    const valueBlock = getBlock(target, valueId);
    if (!valueBlock || !valueBlock.fields || !valueBlock.fields.NAME) return null;
    const fieldValue = valueBlock.fields.NAME.value;
    return fieldValue === undefined ? null : String(fieldValue);
  }

  function isThreadRunning(record) {
    const thread = record && record.thread;
    if (!thread) return false;
    if (typeof thread.status === "number") return thread.status === THREAD_STATUS_RUNNING;
    return Array.isArray(runtime && runtime.threads) ? runtime.threads.includes(thread) : false;
  }

  function getActiveHandlerCount(handlersMap, name, hatOpcode) {
    const hats = findHats(hatOpcode);
    const live = new Set();

    // Literal hats are read from the project itself, so a handler stays live
    // even when its predicate has not run recently.
    for (const [blockId, hat] of hats) {
      if (getLiteralName(hat.target, hat.block) === name) {
        live.add(blockId);
      }
    }

    const blockMap = handlersMap.get(name);
    if (!blockMap) return live.size;

    const now = Date.now();
    for (const [blockId, record] of blockMap) {
      if (live.has(blockId)) continue;
      const hat = hats.get(blockId);
      if (hat) {
        const literal = getLiteralName(hat.target, hat.block);
        if (literal !== null) {
          // A literal name that does not match can never receive this signal.
          if (!isThreadRunning(record)) blockMap.delete(blockId);
          continue;
        }
      }
      if (isThreadRunning(record)) {
        live.add(blockId);
      } else if (now - record.timestamp < HAT_FALLBACK_WINDOW_MS) {
        live.add(blockId);
      } else {
        blockMap.delete(blockId);
      }
    }

    return live.size;
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
