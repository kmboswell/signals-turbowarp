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

// Builds one target holding top-level hat blocks. A literal NAME is stored in
// the shadow block; `literal: false` plugs a reporter into the slot instead.
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
      fields: { NAME: { name: "NAME", value: hat.name } },
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

function makeThread(status = 2) {
  return { status };
}

function makeUtil(blockId, thread = makeThread()) {
  return {
    blockId,
    thread,
    stopThread() {
      thread.status = 0;
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
  assert.equal(util.thread.status, 0, "raise error should stop the handler thread");
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

  handlerThread.status = 0;
  listeners.get("BEFORE_EXECUTE")();
  assert.equal(await query, "");
});

test("the bundle contains no dynamic import", () => {
  assert.equal(bundle.includes("import("), false);
});
