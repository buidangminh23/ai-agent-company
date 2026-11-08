import assert from "node:assert/strict";
import test from "node:test";
import { pressGuard } from "./press-guard.ts";

function setup() {
  const area = new EventTarget();
  const page = new EventTarget();
  let renders = 0;
  const held = pressGuard(area, page, () => { renders++; }, (run) => run());
  return { area, page, held, renders: () => renders };
}

test("nothing is held without a press", () => {
  const { held, renders } = setup();
  assert.equal(held(), false);
  assert.equal(renders(), 0);
});

test("a render during a press waits and runs once after release", () => {
  const { area, page, held, renders } = setup();
  area.dispatchEvent(new Event("pointerdown"));
  assert.equal(held(), true);
  assert.equal(held(), true);
  assert.equal(renders(), 0);
  page.dispatchEvent(new Event("pointerup"));
  assert.equal(renders(), 1);
  assert.equal(held(), false);
});

test("a press with no blocked render releases without an extra render", () => {
  const { area, page, renders } = setup();
  area.dispatchEvent(new Event("pointerdown"));
  page.dispatchEvent(new Event("pointerup"));
  assert.equal(renders(), 0);
});

test("a cancelled press, such as a touch scroll, still releases", () => {
  const { area, page, held, renders } = setup();
  area.dispatchEvent(new Event("pointerdown"));
  held();
  page.dispatchEvent(new Event("pointercancel"));
  assert.equal(renders(), 1);
});

test("a press outside the area never holds rendering", () => {
  const { page, held } = setup();
  page.dispatchEvent(new Event("pointerdown"));
  assert.equal(held(), false);
});
