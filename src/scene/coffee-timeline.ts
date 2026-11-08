export type CoffeeStage = "prepare" | "brew" | "serve" | "sip" | "return";

export interface CoffeeCycle {
  stage: CoffeeStage;
  progress: number;
  cupHeld: boolean;
  sip: number;
  brew: number;
}

export function coffeeCycle(t: number): CoffeeCycle {
  const time = ((t % 20) + 20) % 20;
  const stage: CoffeeStage = time < 3 ? "prepare" : time < 8 ? "brew" : time < 10 ? "serve" : time < 16 ? "sip" : "return";
  const start = { prepare: 0, brew: 3, serve: 8, sip: 10, return: 16 }[stage];
  const duration = { prepare: 3, brew: 5, serve: 2, sip: 6, return: 4 }[stage];
  const progress = (time - start) / duration;
  const sip = stage === "sip" ? Math.max(0, Math.sin(Math.min(1, Math.max(0, (progress - 0.12) / 0.64)) * Math.PI)) : 0;
  return { stage, progress, cupHeld: stage === "sip", sip, brew: stage === "brew" ? Math.sin(Math.PI * Math.min(1, progress * 5)) * 0.15 + 0.85 : 0 };
}
