import { tickWorld, type World } from '@sandbox/sim';

/**
 * Advances the world in wall-clock time. At speed 1 one tick (10 s of sim time by default) runs every
 * 10 real seconds. Speed and pause only change pacing; the tick sequence is the same either way.
 */
export class SimTicker {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly world: World) {}

  start(): void {
    if (this.timer) return;
    const loop = () => {
      if (!this.world.clock.paused) tickWorld(this.world);
      this.timer = setTimeout(loop, this.world.config.tickMs / this.world.clock.speed);
    };
    this.timer = setTimeout(loop, this.world.config.tickMs / this.world.clock.speed);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
