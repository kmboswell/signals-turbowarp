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

const HAT_OPCODE = "signals_whenEventEmitted";

// Scratch projects require at least one costume per target; the sprite is
// never rendered, so the asset is never loaded.
const COSTUME = {
  name: "backdrop1",
  dataFormat: "svg",
  assetId: "cd21514d0531fdffb22204e0ec5ed84a",
  md5ext: "cd21514d0531fdffb22204e0ec5ed84a.svg",
  rotationCenterX: 240,
  rotationCenterY: 180,
};

// One target per handler, each incrementing the stage's `runs` variable from
// its `when event` hat.
function makeProject(handlers) {
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

  handlers.forEach((name, index) => {
    const hatId = `hat${index}`;
    const runId = `${hatId}run`;
    targets.push({
      isStage: false,
      name: `Handler${index}`,
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {
        [hatId]: {
          opcode: HAT_OPCODE,
          next: runId,
          parent: null,
          inputs: {},
          fields: { NAME: [name, null] },
          shadow: false,
          topLevel: true,
          x: 0,
          y: 0,
        },
        [runId]: {
          opcode: "data_changevariableby",
          next: null,
          parent: hatId,
          inputs: { VALUE: [1, [4, "1"]] },
          fields: { VARIABLE: ["runs", "runsVar"] },
          shadow: false,
          topLevel: false,
        },
      },
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
    BlockType: {
      COMMAND: "command",
      REPORTER: "reporter",
      BOOLEAN: "boolean",
      HAT: "hat",
    },
    ArgumentType: {
      STRING: "string",
      NUMBER: "number",
    },
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
    if (block.blockType === "hat") {
      runtime._hats[opcode] = {
        edgeActivated: block.isEdgeActivated,
        restartExistingThreads: false,
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

async function setUp(handlers) {
  const { virtualMachine, extension } = loadExtension();
  await virtualMachine.loadProject(makeProject(handlers));
  registerExtension(virtualMachine.runtime, extension);
  // A loaded project leaves the step budget unset; the sequencer would then
  // never step a thread.
  virtualMachine.runtime.currentStepTime = 33.33;
  const stage = virtualMachine.runtime.getTargetForStage();
  return {
    runtime: virtualMachine.runtime,
    extension,
    runs: () => stage.variables.runsVar.value,
  };
}

runtimeTest("the real runtime runs a handler in every target", async () => {
  const { runtime, extension, runs } = await setUp(["evt", "evt", "evt"]);

  extension.emitEvent({ NAME: "evt", DATA: "payload" });
  step(runtime, 2);

  assert.equal(runs(), 3);
});

runtimeTest("the real runtime gives every handler each emission once", async () => {
  const { runtime, extension, runs } = await setUp(["evt", "evt", "evt"]);

  extension.emitEvent({ NAME: "evt", DATA: "first" });
  extension.emitEvent({ NAME: "evt", DATA: "second" });
  step(runtime, 3);

  assert.equal(runs(), 6);
});

runtimeTest("the real runtime keeps emissions out of other events", async () => {
  const { runtime, extension, runs } = await setUp(["evt", "other", "evt"]);

  extension.emitEvent({ NAME: "evt", DATA: "payload" });
  step(runtime, 2);

  assert.equal(runs(), 2);

  extension.emitEvent({ NAME: "other", DATA: "payload" });
  step(runtime, 2);

  assert.equal(runs(), 3);
});
