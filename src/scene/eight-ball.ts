export type PoolPlayer = 0 | 1;
export type PoolGroup = "solid" | "stripe";
export type PoolFoul = "scratch" | "no-contact" | "wrong-first-ball" | "no-rail" | "illegal-break" | "early-eight" | "wrong-eight-pocket";

export interface PoolShot {
  breakShot: boolean;
  firstContact: number | null;
  pocketed: { number: number; pocket: number }[];
  railAfterContact: boolean;
  objectRails: number[];
  remainingBefore: number[];
  calledBall: number | null;
  calledPocket: number | null;
}

export interface PoolShotResult {
  respotEight: boolean;
  rerack: boolean;
}

export type ShotFacts = PoolShot;

export function ballGroup(number: number): PoolGroup | null {
  return number >= 1 && number <= 7 ? "solid" : number >= 9 && number <= 15 ? "stripe" : null;
}

export class EightBallRules {
  currentPlayer: PoolPlayer = 0;
  groups: [PoolGroup | null, PoolGroup | null] = [null, null];
  winner: PoolPlayer | null = null;
  ballInHand = false;
  behindHeadString = false;
  lastFoul: PoolFoul | null = null;

  reset(startingPlayer: PoolPlayer = 0): void {
    this.currentPlayer = startingPlayer;
    this.groups = [null, null];
    this.winner = null;
    this.ballInHand = false;
    this.behindHeadString = false;
    this.lastFoul = null;
  }

  legalTargets(remaining: number[]): number[] {
    if (this.winner !== null) return [];
    const group = this.groups[this.currentPlayer];
    if (group) {
      const own = remaining.filter(number => ballGroup(number) === group);
      return own.length ? own : remaining.filter(number => number === 8);
    }
    const cleared = !remaining.some(number => ballGroup(number) === "solid") || !remaining.some(number => ballGroup(number) === "stripe");
    return remaining.filter(number => ballGroup(number) !== null || (number === 8 && cleared));
  }

  resolveShot(shot: PoolShot): PoolShotResult {
    const result = { respotEight: false, rerack: false };
    if (this.winner !== null) return result;
    const player = this.currentPlayer;
    const opponent: PoolPlayer = player === 0 ? 1 : 0;
    const scratch = shot.pocketed.some(ball => ball.number === 0);
    const eight = shot.pocketed.find(ball => ball.number === 8);
    const objectPotted = shot.pocketed.some(ball => ball.number > 0);
    this.ballInHand = false;
    this.behindHeadString = false;
    this.lastFoul = scratch ? "scratch" : shot.firstContact === null ? "no-contact" : null;
    if (shot.breakShot) {
      result.respotEight = Boolean(eight);
      const rails = new Set(shot.objectRails.filter(number => number >= 1 && number <= 15));
      if (!objectPotted && rails.size < 4) {
        this.lastFoul ??= "illegal-break";
        this.currentPlayer = opponent;
        this.groups = [null, null];
        this.ballInHand = true;
        this.behindHeadString = true;
        result.rerack = true;
        result.respotEight = false;
      } else if (this.lastFoul) {
        this.currentPlayer = opponent;
        this.ballInHand = true;
        this.behindHeadString = true;
      } else if (!objectPotted) {
        this.currentPlayer = opponent;
      }
      return result;
    }
    const legal = this.legalTargets(shot.remainingBefore);
    if (shot.firstContact !== null && !legal.includes(shot.firstContact)) this.lastFoul ??= "wrong-first-ball";
    if (!objectPotted && !shot.railAfterContact) this.lastFoul ??= "no-rail";
    if (eight) {
      if (!legal.includes(8) || shot.calledBall !== 8) this.lastFoul ??= "early-eight";
      else if (shot.calledPocket === null || eight.pocket !== shot.calledPocket) this.lastFoul ??= "wrong-eight-pocket";
      this.winner = this.lastFoul ? opponent : player;
      return result;
    }
    if (this.lastFoul) {
      this.currentPlayer = opponent;
      this.ballInHand = true;
      return result;
    }
    const called = shot.calledBall !== null && shot.calledPocket !== null && legal.includes(shot.calledBall)
      && shot.pocketed.some(ball => ball.number === shot.calledBall && ball.pocket === shot.calledPocket);
    if (called) {
      const group = ballGroup(shot.calledBall!);
      if (this.groups[player] === null && group) {
        this.groups[player] = group;
        this.groups[opponent] = group === "solid" ? "stripe" : "solid";
      }
    } else {
      this.currentPlayer = opponent;
    }
    return result;
  }
}
