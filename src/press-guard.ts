export function pressGuard(area: EventTarget, page: EventTarget, rerender: () => void, later: (run: () => void) => void = (run) => { setTimeout(run, 0); }): () => boolean {
  let pressed = false;
  let deferred = false;
  const release = () => {
    if (!pressed) return;
    pressed = false;
    if (!deferred) return;
    deferred = false;
    later(rerender);
  };
  area.addEventListener("pointerdown", () => { pressed = true; });
  page.addEventListener("pointerup", release);
  page.addEventListener("pointercancel", release);
  return () => {
    if (pressed) deferred = true;
    return pressed;
  };
}
