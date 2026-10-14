import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_MAX_AGE_GAME_SECONDS, actionSchema, frameAgeSeconds, modelToolAction, runConfigSchema, validateFrameAction, windowAction, type Frame } from "./protocol.js";
const frame: Frame = {
  id: "test",
  image: "",
  mimeType: "image/jpeg",
  width: 1920,
  height: 1080,
  windowId: 1,
  pid: 2,
  capturedAt: 1000,
  receivedAt: 1000,
  scope: "game-window",
};
test("rejects OS shortcuts, arbitrary commands, coordinates and extra fields", () => {
  for (const value of [
    { type: "key", key: "Alt+Tab" },
    { type: "shell", command: "ls" },
    { type: "click", x: -1, y: 0 },
    { type: "click", x: 1.5, y: 0 },
    { type: "click", x: 1, y: 2, windowId: 123 },
    { type: "key", key: "Super" },
    { type: "click", x: 1, y: 2, button: 2 },
  ])
    assert.equal(actionSchema.safeParse(value).success, false);
});
test("projects only the selected model action fields while validating required values", () => {
  assert.deepEqual(modelToolAction({type:"key",key:"Z",x:0,y:0,endX:0,endY:0,button:1,direction:"down"}), {type:"key",key:"Z"});
  assert.deepEqual(modelToolAction({type:"click",x:100,y:200,endX:0,endY:0,button:1,key:"Z",direction:"down"}), {type:"click",x:100,y:200,button:1});
  assert.throws(() => modelToolAction({type:"click",x:100,key:"Z"}), /invalid_type/);
  assert.throws(() => modelToolAction({type:"key",key:"Alt+Tab",x:0,y:0}), /invalid_value/);
});
test("rejects expired screenshots and out-of-window drag endpoints", () => {
  assert.throws(
    () => validateFrameAction({ type: "key", key: "Space" }, frame, FRAME_MAX_AGE_GAME_SECONDS + 0.1),
    /expired \(older than 40 game seconds of play\)/,
  );
  assert.throws(
    () =>
      validateFrameAction(
        { type: "click", x: 1920, y: 0, button: 1 },
        frame,
        1,
      ),
    /outside/,
  );
  assert.throws(
    () =>
      validateFrameAction(
        { type: "drag", x: 0, y: 0, endX: 20, endY: 1080, button: 1 },
        frame,
        1,
      ),
    /outside/,
  );
  assert.doesNotThrow(() =>
    validateFrameAction(
      { type: "click", x: 1919, y: 1079, button: 1 },
      frame,
      FRAME_MAX_AGE_GAME_SECONDS,
    ),
  );
});

test("a screenshot's age is game time on the game clock, else real time at the benchmark speed", () => {
  const dated = { ...frame, gameTick: 3000, mapName: "Oasis" };
  // 1,200 ticks are 40 game seconds, however long they took in real time (a fast wait, a pause).
  assert.equal(frameAgeSeconds(dated, { tick: 4200, map: "Oasis" }, 1000 + 5000), 40);
  assert.equal(frameAgeSeconds(dated, { tick: 3000, map: "Oasis" }, 1000 + 600_000), 0, "a paused clock does not age it");
  // Another map, or a clock that went back (a reload), is another game.
  assert.equal(frameAgeSeconds(dated, { tick: 4200, map: "Desert" }), Number.POSITIVE_INFINITY);
  assert.equal(frameAgeSeconds(dated, { tick: 2999, map: "Oasis" }), Number.POSITIVE_INFINITY);
  // Without a clock on both sides: real seconds less the paused credit, at speed 40 (30 s = 40 game s).
  assert.equal(frameAgeSeconds(frame, { tick: 4200, map: "Oasis" }, 1000 + 30_000), 40);
  assert.equal(frameAgeSeconds(dated, null, 1000 + 30_000, 15_000), 20);
  assert.equal(frameAgeSeconds(frame, null, 500), 0);
});

test("maps fullscreen letterboxing and rejects clicks in the padding", async () => {
  const { imagePoint } = await import("./protocol.js");
  const rect = { left: 10, top: 20, width: 1000, height: 1000 };
  assert.deepEqual(imagePoint(frame, rect, { clientX: 510, clientY: 520 }), {
    x: 960,
    y: 540,
  });
  assert.equal(imagePoint(frame, rect, { clientX: 510, clientY: 50 }), null);
  assert.equal(imagePoint(frame, rect, { clientX: 1010, clientY: 520 }), null);
  assert.deepEqual(
    imagePoint(
      frame,
      { left: 0, top: 0, width: 960, height: 540 },
      { clientX: 200, clientY: 100 },
    ),
    { x: 400, y: 200 },
  );
});

test("accepts speed controls without exposing modifier shortcuts", () => {
  for (const key of ["+", "-"])
    assert.equal(actionSchema.safeParse({ type: "key", key }).success, true);
  assert.equal(actionSchema.safeParse({ type: "key", key: "Shift+=" }).success, false);
});

test("fallbackObservation defaults to when-needed, accepts always, and rejects anything else", () => {
  assert.equal(runConfigSchema.parse({}).fallbackObservation, "when-needed");
  assert.equal(runConfigSchema.parse({ fallbackObservation: "always" }).fallbackObservation, "always");
  assert.equal(runConfigSchema.safeParse({ fallbackObservation: "sometimes" }).success, false);
});

test("input aimed at a scaled-down screenshot is scaled back to the game window", () => {
  const scaled = { width: 1280, height: 720, windowWidth: 1920, windowHeight: 1080 };
  assert.deepEqual(windowAction({ type: "click", x: 447, y: 679, button: 1 }, scaled), { type: "click", x: 671, y: 1019, button: 1 });
  assert.deepEqual(windowAction({ type: "drag", x: 0, y: 0, endX: 1279, endY: 719, button: 1 }, scaled), { type: "drag", x: 0, y: 0, endX: 1919, endY: 1079, button: 1 });
  assert.deepEqual(windowAction({ type: "key", key: "Z" }, scaled), { type: "key", key: "Z" });
  // A full-size frame is sent as it is.
  const click = { type: "click" as const, x: 5, y: 6, button: 1 as const };
  assert.equal(windowAction(click, { width: 1920, height: 1080 }), click);
  assert.equal(runConfigSchema.parse({}).screenshotWidth, 1280);
});
