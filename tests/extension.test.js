import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = readFileSync(resolve(root, "dist/extension.js"), "utf8");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Loads the built bundle into a fresh context so each test starts from clean
// extension state, with just enough of the Scratch API to register it.
function loadExtension() {
  const clock = { time: Date.now() };
  const startHatsCalls = [];
  const listeners = new Map();
  let extension = null;

  const runtime = {
    targets: [],
    threads: [],
    startHats(opcode) {
      startHatsCalls.push(opcode);
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
  };

  const Scratch = {
    extensions: {
      unsandboxed: true,
      register(instance) {
        extension = instance;
      },
    },
    vm: { runtime },
    BlockType: {
      COMMAND: "command",
      REPORTER: "reporter",
      BOOLEAN: "boolean",
      HAT: "hat",
      EVENT: "event",
      CONDITIONAL: "conditional",
      LOOP: "loop",
      BUTTON: "button",
      LABEL: "label",
    },
    ArgumentType: {
      STRING: "string",
      NUMBER: "number",
      BOOLEAN: "boolean",
      ANGLE: "angle",
      COLOR: "color",
    },
  };

  class FakeDate extends Date {
    static now() {
      return clock.time;
    }
  }

  const sandbox = { Scratch, Date: FakeDate, setTimeout, clearTimeout, console };
  vm.createContext(sandbox);
  new vm.Script(bundle, { filename: "dist/extension.js" }).runInContext(sandbox);

  return { extension, runtime, startHatsCalls, listeners, clock };
}

function hatOpcode(extension, opcode) {
  return `${extension.getInfo().id}_${opcode}`;
}

// Builds one target holding top-level hat blocks. The runtime stores a literal
// NAME in a shadow block field named after the shadow's opcode ("TEXT");
// `literal: false` plugs a reporter into the slot instead.
function makeTarget(hats) {
  const blocks = new Map();
  for (const hat of hats) {
    const valueId = `${hat.id}_value`;
    const input = { name: "NAME", block: valueId, shadow: valueId };
    if (hat.literal === false) {
      const reporterId = `${hat.id}_reporter`;
      blocks.set(reporterId, { opcode: "operator_join", inputs: {}, fields: {} });
      input.block = reporterId;
    }
    blocks.set(valueId, {
      opcode: "text",
      inputs: {},
      fields: { TEXT: { name: "TEXT", value: hat.name } },
    });
    blocks.set(hat.id, {
      opcode: hat.opcode,
      topLevel: true,
      inputs: { NAME: input },
      fields: {},
    });
  }
  return {
    blocks: {
      _scripts: hats.map((hat) => hat.id),
      _blocks: Object.fromEntries(blocks),
      getBlock(blockId) {
        return blocks.get(blockId) ?? null;
      },
    },
  };
}

// Scratch thread statuses: 0 running, 4 done.
function makeThread(status = 0, topBlock = null) {
  return { status, topBlock };
}

// Like the real block utility, this has no block id: a hat predicate learns
// which hat it is running for from its thread's top block.
function makeUtil(blockId, thread = makeThread()) {
  if (!thread.topBlock) thread.topBlock = blockId;
  return {
    thread,
    stopThread() {
      thread.status = 4;
    },
  };
}

test("every hat opcode passed to startHats exists in getInfo()", async () => {
  const { extension, runtime, startHatsCalls, listeners } = loadExtension();
  const info = extension.getInfo();
  assert.equal(info.id, "signals");

  const declared = new Set(
    info.blocks
      .filter((block) => typeof block === "object")
      .map((block) => `${info.id}_${block.opcode}`),
  );

  runtime.targets = [
    makeTarget([
      { id: "actionHat", opcode: hatOpcode(extension, "whenActionReceived"), name: "act" },
      { id: "queryHat", opcode: hatOpcode(extension, "whenQueryRequested"), name: "ask" },
      { id: "eventHat", opcode: hatOpcode(extension, "whenEventEmitted"), name: "evt" },
    ]),
  ];

  // Let each hat predicate run once, the way the runtime would before a signal
  // is sent, so the sender can see that a handler is live.
  extension.whenActionReceived({ NAME: "act" }, makeUtil("actionHat"));
  const util = makeUtil("queryHat");
  assert.equal(extension.whenQueryRequested({ NAME: "ask" }, util), false);

  listeners.get("BEFORE_EXECUTE")();
  extension.fireAction({ NAME: "act", DATA: "1" });
  extension.emitEvent({ NAME: "evt", DATA: "1" });

  const query = extension.querySignal({ NAME: "ask", DATA: "1" });
  assert.equal(extension.whenQueryRequested({ NAME: "ask" }, util), true);
  extension.returnValue({ VALUE: "answer" }, util);
  assert.equal(await query, "answer");

  for (const opcode of ["whenActionReceived", "whenQueryRequested", "whenEventEmitted"]) {
    assert.ok(
      startHatsCalls.includes(hatOpcode(extension, opcode)),
      `startHats should have been called with ${hatOpcode(extension, opcode)}`,
    );
  }
  for (const opcode of startHatsCalls) {
    assert.ok(declared.has(opcode), `startHats(${opcode}) is not a block in getInfo()`);
  }
});

test("a handler error settles its query well before the timeout", async () => {
  const { extension, runtime } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "qhat", opcode: hatOpcode(extension, "whenQueryRequested"), name: "ask" },
    ]),
  ];

  const util = makeUtil("qhat");
  assert.equal(extension.whenQueryRequested({ NAME: "ask" }, util), false);

  const started = Date.now();
  const query = extension.querySignal({ NAME: "ask", DATA: "1" });
  assert.equal(extension.whenQueryRequested({ NAME: "ask" }, util), true);
  extension.raiseError({ TYPE: "SignalsError", MESSAGE: "handler exploded" }, util);

  assert.equal(await query, "");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `the handler's error took ${elapsed}ms to reach the caller`);
  assert.equal(extension.didErrorOccur(), true);
  assert.equal(extension.lastErrorMessage(), "handler exploded");
  assert.equal(util.thread.status, 4, "raise error should stop the handler thread");
});

test("a handler that ends without return value settles its query", async () => {
  const { extension, runtime, listeners } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "qhat", opcode: hatOpcode(extension, "whenQueryRequested"), name: "ask" },
    ]),
  ];

  const registered = makeUtil("qhat");
  assert.equal(extension.whenQueryRequested({ NAME: "ask" }, registered), false);

  const query = extension.querySignal({ NAME: "ask", DATA: "1" });
  const handlerThread = makeThread();
  const handlerUtil = makeUtil("qhat", handlerThread);
  assert.equal(extension.whenQueryRequested({ NAME: "ask" }, handlerUtil), true);

  handlerThread.status = 4;
  listeners.get("BEFORE_EXECUTE")();
  assert.equal(await query, "");
});

test("a literal handler stays live across a long clock jump", () => {
  const { extension, runtime, clock } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "ahat", opcode: hatOpcode(extension, "whenActionReceived"), name: "act" },
    ]),
  ];
  extension.whenActionReceived({ NAME: "act" }, makeUtil("ahat"));

  clock.time += 5000;
  extension.fireAction({ NAME: "act", DATA: "1" });
  assert.equal(extension.didErrorOccur(), false, extension.lastErrorMessage());
});

test("a running non-literal handler counts as live", () => {
  const { extension, runtime, clock } = loadExtension();
  runtime.targets = [
    makeTarget([
      {
        id: "ahat",
        opcode: hatOpcode(extension, "whenActionReceived"),
        name: "act",
        literal: false,
      },
    ]),
  ];
  const thread = makeThread();
  extension.whenActionReceived({ NAME: "act" }, makeUtil("ahat", thread));

  // Past the timestamp window, but the handler thread is still running.
  clock.time += 120 * 1000;
  extension.fireAction({ NAME: "act", DATA: "1" });
  assert.equal(extension.didErrorOccur(), false, extension.lastErrorMessage());
});

test("each signal starts from a clean error state", () => {
  const { extension } = loadExtension();

  extension.fireAction({ NAME: "missing", DATA: "1" });
  assert.equal(extension.didErrorOccur(), true);
  assert.equal(extension.lastErrorMessage(), "This action/query has no handler.");

  extension.emitEvent({ NAME: "anything", DATA: "1" });
  assert.equal(extension.didErrorOccur(), false);
  assert.equal(extension.lastErrorType(), "");
  assert.equal(extension.lastErrorMessage(), "");

  extension.querySignal({ NAME: "missing", DATA: "1" });
  assert.equal(extension.didErrorOccur(), true);

  extension.clearErrorState();
  assert.equal(extension.didErrorOccur(), false);
  assert.equal(extension.lastErrorType(), "");
  assert.equal(extension.lastErrorMessage(), "");
});

test("set query timeout changes the timeout and its message", async () => {
  const { extension, runtime } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "qhat", opcode: hatOpcode(extension, "whenQueryRequested"), name: "ask" },
    ]),
  ];

  extension.setQueryTimeout({ MS: 30 });
  const started = Date.now();
  const query = extension.querySignal({ NAME: "ask", DATA: "1" });
  assert.equal(await query, "");

  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 25, `query timed out after only ${elapsed}ms`);
  assert.ok(elapsed < 1000, `query timeout took ${elapsed}ms`);
  assert.equal(
    extension.lastErrorMessage(),
    "Query 'ask' did not return a value within 30 ms.",
  );
});

test("a query timeout of 0 waits for the handler", async () => {
  const { extension, runtime } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "qhat", opcode: hatOpcode(extension, "whenQueryRequested"), name: "ask" },
    ]),
  ];

  extension.setQueryTimeout({ MS: 0 });
  const query = extension.querySignal({ NAME: "ask", DATA: "1" });

  let result;
  query.then((value) => {
    result = value;
  });
  await sleep(60);
  assert.equal(result, undefined, "the query should still be waiting");

  const util = makeUtil("qhat");
  assert.equal(extension.whenQueryRequested({ NAME: "ask" }, util), true);
  extension.returnValue({ VALUE: "late" }, util);
  assert.equal(await query, "late");
  assert.equal(extension.didErrorOccur(), false);
});

test("a timeout never overwrites a handler error", async () => {
  const { extension, runtime } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "qhat", opcode: hatOpcode(extension, "whenQueryRequested"), name: "ask" },
    ]),
  ];

  extension.setQueryTimeout({ MS: 30 });
  const query = extension.querySignal({ NAME: "ask", DATA: "1" });
  const util = makeUtil("qhat");
  assert.equal(extension.whenQueryRequested({ NAME: "ask" }, util), true);
  extension.raiseError({ TYPE: "SignalsError", MESSAGE: "boom" }, util);
  assert.equal(await query, "");

  await sleep(60);
  assert.equal(extension.lastErrorMessage(), "boom");
});

test("every event handler receives the same emission", () => {
  const { extension, runtime, listeners } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "aHat", opcode: hatOpcode(extension, "whenEventEmitted"), name: "evt" },
      { id: "bHat", opcode: hatOpcode(extension, "whenEventEmitted"), name: "evt" },
    ]),
  ];
  const a = makeUtil("aHat");
  const b = makeUtil("bHat");
  extension.whenEventEmitted({ NAME: "evt" }, a);
  extension.whenEventEmitted({ NAME: "evt" }, b);

  extension.emitEvent({ NAME: "evt", DATA: "payload" });
  assert.equal(extension.whenEventEmitted({ NAME: "evt" }, a), true);
  assert.equal(extension.whenEventEmitted({ NAME: "evt" }, b), true);
  assert.equal(extension.getSignalData({}, a), "payload");
  assert.equal(extension.getSignalData({}, b), "payload");

  // The delivery retires once the frame that dispatched it is over.
  listeners.get("BEFORE_EXECUTE")();
  assert.equal(extension.whenEventEmitted({ NAME: "evt" }, a), false);
  assert.equal(extension.whenEventEmitted({ NAME: "evt" }, b), false);
});

test("each emission reaches every event handler once", () => {
  const { extension, runtime, listeners } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "aHat", opcode: hatOpcode(extension, "whenEventEmitted"), name: "evt" },
      { id: "bHat", opcode: hatOpcode(extension, "whenEventEmitted"), name: "evt" },
    ]),
  ];
  const a = makeUtil("aHat");
  const b = makeUtil("bHat");
  extension.whenEventEmitted({ NAME: "evt" }, a);
  extension.whenEventEmitted({ NAME: "evt" }, b);

  extension.emitEvent({ NAME: "evt", DATA: "first" });
  extension.emitEvent({ NAME: "evt", DATA: "second" });

  for (const data of ["first", "second"]) {
    assert.equal(extension.whenEventEmitted({ NAME: "evt" }, a), true);
    assert.equal(extension.whenEventEmitted({ NAME: "evt" }, b), true);
    assert.equal(extension.getSignalData({}, a), data);
    assert.equal(extension.getSignalData({}, b), data);
    listeners.get("BEFORE_EXECUTE")();
  }

  assert.equal(extension.whenEventEmitted({ NAME: "evt" }, a), false);
  assert.equal(extension.whenEventEmitted({ NAME: "evt" }, b), false);
});

test("an emission waits for a handler that is busy", () => {
  const { extension, runtime, listeners } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "eHat", opcode: hatOpcode(extension, "whenEventEmitted"), name: "evt" },
    ]),
  ];

  extension.emitEvent({ NAME: "evt", DATA: "payload" });
  // The handler does not poll for a while, as a script that is still running
  // would not: the emission has to wait for it instead of being dropped.
  for (let poll = 0; poll < 6; poll += 1) {
    listeners.get("BEFORE_EXECUTE")();
  }

  const util = makeUtil("eHat");
  assert.equal(extension.whenEventEmitted({ NAME: "evt" }, util), true);
  assert.equal(extension.getSignalData({}, util), "payload");
});

test("an emission no handler picked up does not stall later ones", () => {
  const { extension, runtime, listeners } = loadExtension();

  extension.emitEvent({ NAME: "evt", DATA: "lost" });
  for (let poll = 0; poll < 4; poll += 1) {
    listeners.get("BEFORE_EXECUTE")();
  }

  extension.emitEvent({ NAME: "evt", DATA: "fresh" });
  const util = makeUtil("eHat");
  assert.equal(extension.whenEventEmitted({ NAME: "evt" }, util), true);
  assert.equal(extension.getSignalData({}, util), "fresh");
});

test("actions still allow only one handler", () => {
  const { extension, runtime } = loadExtension();
  runtime.targets = [
    makeTarget([
      { id: "aHat", opcode: hatOpcode(extension, "whenActionReceived"), name: "act" },
      { id: "bHat", opcode: hatOpcode(extension, "whenActionReceived"), name: "act" },
    ]),
  ];

  extension.fireAction({ NAME: "act", DATA: "1" });
  assert.equal(extension.didErrorOccur(), true);
  assert.equal(extension.lastErrorMessage(), "Action has multiple handlers.");
});

test("the bundle contains no dynamic import", () => {
  assert.equal(bundle.includes("import("), false);
});
