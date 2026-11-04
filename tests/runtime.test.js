import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// The stub harness cannot tell the difference between the block utilities a
// real runtime hands to a hat predicate, so drive the built extension through
// the actual scratch-vm runtime as well. scratch-vm is not a dependency of this
// project: install it locally to run these tests, otherwise they are skipped.
function loadVirtualMachine() {
  try {
    return createRequire(import.meta.url)("scratch-vm");
  } catch {
    return null;
  }
}

const VirtualMachine = loadVirtualMachine();
const runtimeTest = VirtualMachine ? test : test.skip;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = readFileSync(resolve(root, "dist/extension.js"), "utf8");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const HAT = {
  action: "signals_whenActionReceived",
  query: "signals_whenQueryRequested",
  event: "signals_whenEventEmitted",
};

// Scratch projects require at least one costume per target; nothing is ever
// rendered, so the asset is never loaded.
const COSTUME = {
  name: "backdrop1",
  dataFormat: "svg",
  assetId: "cd21514d0531fdffb22204e0ec5ed84a",
  md5ext: "cd21514d0531fdffb22204e0ec5ed84a.svg",
  rotationCenterX: 240,
  rotationCenterY: 180,
};

const BLOCK_TYPES = {
  COMMAND: "command",
  REPORTER: "reporter",
  BOOLEAN: "boolean",
  HAT: "hat",
  EVENT: "event",
  CONDITIONAL: "conditional",
  LOOP: "loop",
  BUTTON: "button",
  LABEL: "label",
};

const ARGUMENT_TYPES = {
  STRING: "string",
  NUMBER: "number",
  BOOLEAN: "boolean",
  ANGLE: "angle",
  COLOR: "color",
};

let blockCounter = 0;

// One script: a hat with a text argument stored the way a saved project stores
// it (an inline text primitive in the NAME input), followed by commands.
function script(hatOpcode, name, body = []) {
  const blocks = {};
  const hatId = `hat${blockCounter++}`;
  const bodyIds = body.map(() => `block${blockCounter++}`);

  blocks[hatId] = {
    opcode: hatOpcode,
    next: bodyIds[0] ?? null,
    parent: null,
    inputs: { NAME: [1, [10, name]] },
    fields: {},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0,
  };

  body.forEach((command, index) => {
    blocks[bodyIds[index]] = {
      opcode: command.opcode,
      next: bodyIds[index + 1] ?? null,
      parent: index === 0 ? hatId : bodyIds[index - 1],
      inputs: command.inputs ?? {},
      fields: command.fields ?? {},
      shadow: false,
      topLevel: false,
    };
  });

  return blocks;
}

const INCREMENT = {
  opcode: "data_changevariableby",
  inputs: { VALUE: [1, [4, "1"]] },
  fields: { VARIABLE: ["runs", "runsVar"] },
};
const RAISE = {
  opcode: "signals_raiseError",
  inputs: { MESSAGE: [1, [10, "boom"]] },
  fields: { TYPE: ["SignalsError", null] },
};
const RETURN_SEVEN = {
  opcode: "signals_returnValue",
  inputs: { VALUE: [1, [10, "7"]] },
};
const WAIT = {
  opcode: "control_wait",
  inputs: { DURATION: [1, [5, "0.05"]] },
};
const LONG_WAIT = {
  opcode: "control_wait",
  inputs: { DURATION: [1, [5, "0.3"]] },
};

function makeProject(scripts) {
  const targets = [
    {
      isStage: true,
      name: "Stage",
      variables: { runsVar: ["runs", 0] },
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [COSTUME],
      sounds: [],
      volume: 100,
      layerOrder: 0,
      tempo: 60,
      videoTransparency: 50,
      videoState: "on",
      textToSpeechLanguage: null,
    },
  ];

  scripts.forEach((blocks, index) => {
    targets.push({
      isStage: false,
      name: `Handler${index}`,
      variables: {},
      lists: {},
      broadcasts: {},
      blocks,
      comments: {},
      currentCostume: 0,
      costumes: [COSTUME],
      sounds: [],
      volume: 100,
      layerOrder: index + 1,
      visible: true,
      x: 0,
      y: 0,
      size: 100,
      direction: 90,
      draggable: false,
      rotationStyle: "all around",
    });
  });

  return { targets, meta: { semver: "3.0.0", vm: "5.0.0", agent: "" } };
}

function loadExtension() {
  const virtualMachine = new VirtualMachine();
  // Node has no Worker, and the test registers the blocks itself; the project
  // only mentions the extension id because its blocks are in the scripts.
  virtualMachine.extensionManager.loadExtensionURL = () => Promise.resolve();
  let extension = null;

  const Scratch = {
    extensions: {
      unsandboxed: true,
      register(instance) {
        extension = instance;
      },
    },
    vm: virtualMachine,
    BlockType: BLOCK_TYPES,
    ArgumentType: ARGUMENT_TYPES,
  };

  const sandbox = { Scratch, Date, setTimeout, clearTimeout, console };
  vm.createContext(sandbox);
  new vm.Script(bundle, { filename: "dist/extension.js" }).runInContext(sandbox);

  return { virtualMachine, extension };
}

// Mirrors what the extension manager does for an unsandboxed extension: the
// block functions and the hat metadata end up on the runtime.
function registerExtension(runtime, extension) {
  const info = extension.getInfo();
  for (const block of info.blocks) {
    if (typeof block !== "object") continue;
    const opcode = `${info.id}_${block.opcode}`;
    runtime._primitives[opcode] = extension[block.opcode];
    if (block.blockType === BLOCK_TYPES.HAT) {
      runtime._hats[opcode] = {
        edgeActivated: block.isEdgeActivated,
        restartExistingThreads: block.shouldRestartExistingThreads,
      };
    }
  }
}

// TurboWarp emits BEFORE_EXECUTE each frame; vanilla scratch-vm does not, so
// the test emits it by hand to run the extension's hats.
function step(runtime, times = 1) {
  for (let i = 0; i < times; i += 1) {
    runtime.emit("BEFORE_EXECUTE");
    runtime._step();
  }
}

async function setUp(scripts) {
  const { virtualMachine, extension } = loadExtension();
  await virtualMachine.loadProject(makeProject(scripts));
  registerExtension(virtualMachine.runtime, extension);
  const runtime = virtualMachine.runtime;
  // A loaded project leaves the step budget unset; the sequencer would then
  // never step a thread.
  runtime.currentStepTime = 33.33;
  const stage = runtime.getTargetForStage();
  return {
    runtime,
    extension,
    runs: () => stage.variables.runsVar.value,
  };
}

runtimeTest("the real runtime runs a handler in every target", async () => {
  const { runtime, extension, runs } = await setUp([
    script(HAT.event, "evt", [INCREMENT]),
    script(HAT.event, "evt", [INCREMENT]),
    script(HAT.event, "evt", [INCREMENT]),
  ]);

  extension.emitEvent({ NAME: "evt", DATA: "payload" });
  step(runtime, 2);

  assert.equal(runs(), 3);
});

runtimeTest("the real runtime gives every handler each emission once", async () => {
  const { runtime, extension, runs } = await setUp([
    script(HAT.event, "evt", [INCREMENT]),
    script(HAT.event, "evt", [INCREMENT]),
    script(HAT.event, "evt", [INCREMENT]),
  ]);

  extension.emitEvent({ NAME: "evt", DATA: "first" });
  extension.emitEvent({ NAME: "evt", DATA: "second" });
  step(runtime, 3);

  assert.equal(runs(), 6);
});

runtimeTest("the real runtime keeps emissions out of other events", async () => {
  const { runtime, extension, runs } = await setUp([
    script(HAT.event, "evt", [INCREMENT]),
    script(HAT.event, "other", [INCREMENT]),
    script(HAT.event, "evt", [INCREMENT]),
  ]);

  extension.emitEvent({ NAME: "evt", DATA: "payload" });
  step(runtime, 2);
  assert.equal(runs(), 2);

  extension.emitEvent({ NAME: "other", DATA: "payload" });
  step(runtime, 2);
  assert.equal(runs(), 3);
});

runtimeTest("an emission waits for a handler that is still running", async () => {
  const { runtime, extension, runs } = await setUp([
    script(HAT.event, "evt", [WAIT, INCREMENT]),
  ]);

  extension.emitEvent({ NAME: "evt", DATA: "first" });
  step(runtime, 1);
  extension.emitEvent({ NAME: "evt", DATA: "second" });

  for (let frame = 0; frame < 12; frame += 1) {
    step(runtime, 1);
    await sleep(20);
  }

  assert.equal(runs(), 2);
});

runtimeTest("an action reaches its handler", async () => {
  const { runtime, extension, runs } = await setUp([
    script(HAT.action, "act", [INCREMENT]),
  ]);

  extension.fireAction({ NAME: "act", DATA: "payload" });
  assert.equal(extension.didErrorOccur(), false, extension.lastErrorMessage());

  step(runtime, 2);
  assert.equal(runs(), 1);
});

runtimeTest("a query returns its handler's value", async () => {
  const { runtime, extension } = await setUp([
    script(HAT.query, "ask", [RETURN_SEVEN]),
  ]);

  const answer = extension.querySignal({ NAME: "ask", DATA: "payload" });
  assert.equal(extension.didErrorOccur(), false, extension.lastErrorMessage());

  step(runtime, 2);
  assert.equal(await Promise.race([answer, sleep(1000).then(() => "still waiting")]), "7");
});

runtimeTest("raise error stops the handler script", async () => {
  const { runtime, extension, runs } = await setUp([
    script(HAT.action, "act", [RAISE, INCREMENT]),
  ]);

  extension.fireAction({ NAME: "act", DATA: "payload" });
  step(runtime, 3);

  assert.equal(runs(), 0, "the blocks after raise error must not run");
  assert.equal(extension.didErrorOccur(), true);
  assert.equal(extension.lastErrorMessage(), "boom");
});

runtimeTest("raise error in a query handler answers the caller", async () => {
  const { runtime, extension } = await setUp([
    script(HAT.query, "ask", [RAISE]),
  ]);

  const answer = extension.querySignal({ NAME: "ask", DATA: "payload" });
  step(runtime, 2);

  assert.equal(await Promise.race([answer, sleep(1000).then(() => "still waiting")]), "");
  assert.equal(extension.lastErrorMessage(), "boom");
});

runtimeTest("a busy handler still takes an emission another handler took", async () => {
  const { runtime, extension, runs } = await setUp([
    script(HAT.event, "evt", [WAIT, INCREMENT]),
    script(HAT.event, "evt", [INCREMENT]),
  ]);

  extension.emitEvent({ NAME: "evt", DATA: "first" });
  step(runtime, 1);
  // The first handler is still waiting, so it cannot take this one yet.
  extension.emitEvent({ NAME: "evt", DATA: "second" });

  for (let frame = 0; frame < 20; frame += 1) {
    step(runtime, 1);
    await sleep(20);
  }

  assert.equal(runs(), 4, "both handlers should run for both emissions");
});

runtimeTest("a handler reads the data of its emission", async () => {
  const { runtime, extension } = await setUp([script(HAT.event, "evt", [WAIT])]);

  extension.emitEvent({ NAME: "evt", DATA: "payload" });
  step(runtime, 1);

  const thread = runtime.threads.find(
    (kand) => kand.target && kand.target.getName() === "Handler0",
  );
  assert.ok(thread, "the handler should still be running");
  assert.equal(extension.getSignalData({}, { thread }), "payload");
});

runtimeTest("a query times out in the real runtime", async () => {
  const { runtime, extension } = await setUp([script(HAT.query, "ask", [LONG_WAIT])]);

  extension.setQueryTimeout({ MS: 30 });
  const answer = extension.querySignal({ NAME: "ask", DATA: "payload" });
  step(runtime, 1);

  assert.equal(await Promise.race([answer, sleep(1000).then(() => "still waiting")]), "");
  assert.equal(
    extension.lastErrorMessage(),
    "Query 'ask' did not return a value within 30 ms.",
  );
});
