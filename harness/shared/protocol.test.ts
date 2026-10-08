import test from "node:test";
import assert from "node:assert/strict";
import { actionSchema, modelToolAction, validateFrameAction, type Frame } from "./protocol.js";
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
    () => validateFrameAction({ type: "key", key: "Space" }, frame, 31001),
    /expired/,
  );
  assert.throws(
    () =>
      validateFrameAction(
        { type: "click", x: 1920, y: 0, button: 1 },
        frame,
        1001,
      ),
    /outside/,
  );
  assert.throws(
    () =>
      validateFrameAction(
        { type: "drag", x: 0, y: 0, endX: 20, endY: 1080, button: 1 },
        frame,
        1001,
      ),
    /outside/,
  );
  assert.doesNotThrow(() =>
    validateFrameAction(
      { type: "click", x: 1919, y: 1079, button: 1 },
      frame,
      1001,
    ),
  );
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
