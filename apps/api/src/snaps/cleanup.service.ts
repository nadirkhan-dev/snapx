import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { SnapsService } from './snaps.service';
import { CallsService } from '../calls/calls.service';

/**
 * Expiry worker.
 *
 * An in-process interval rather than BullMQ. That is a deliberate trade for
 * this stage: it needs no extra process, and the job is idempotent so a missed
 * tick costs nothing. The reason to move it to a real queue is horizontal
 * scaling — with two instances, both would run this every minute and duplicate
 * the work. Redis is already a dependency, so that swap is small when needed.
 *
 * Expiry is *also* enforced on read (`open()` re-checks `expires_at`), so a
 * dead worker degrades storage cleanup, never correctness. A design that relies
 * on a cron job for its security guarantee is a design with a single point of
 * silent failure.
 */
@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Cleanup');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly snaps: SnapsService,
    private readonly calls: CallsService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;   // tests drive it explicitly
    this.timer = setInterval(() => {
      this.snaps.runCleanup().catch(e => this.log.error(`snap cleanup failed: ${e.message}`));
      /* Ringing calls must be swept too. This sweeper existed but was never
         scheduled, so an abandoned call stayed 'ringing' forever — and because
         start() refuses when either party has a live call, one stale row locked
         both users out of calling permanently. A cleanup job that is written
         but not wired is worse than none: the guard it supports looks correct
         in review and fails in production. */
      this.calls.expireRinging().catch(e => this.log.error(`call sweep failed: ${e.message}`));
    }, 30_000);
    // Must not hold the process open on shutdown.
    this.timer.unref();
    this.log.log('expiry worker started (30s: snaps + ringing calls)');
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
