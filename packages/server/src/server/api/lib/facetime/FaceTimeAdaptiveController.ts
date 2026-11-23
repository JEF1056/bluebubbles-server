export type AdaptiveRung = {
    rung: number;
    maxWidth: number;
    maxHeight: number;
    fps: number;
    minBitrate: number;
    maxBitrate: number;
    defaultBitrate: number;
    stepDownFloor: number;
    stepUpCeiling: number;
};

export type AdaptCommand = {
    cmd: "adapt";
    maxWidth: number;
    maxHeight: number;
    fps: number;
    bitrate: number;
};

export type RtcpFeedbackSample = {
    /** Receiver Report fraction lost normalized to [0, 1]. */
    fractionLost?: number;
    /** Round-trip time in milliseconds. */
    rttMs?: number;
};

export type FaceTimeAdaptiveState = {
    rung: number;
    maxWidth: number;
    maxHeight: number;
    fps: number;
    bitrate: number;
    oscillationCount: number;
    cooldownMs: number;
};

export type FaceTimeAdaptiveControllerOptions = {
    onAdapt: (cmd: AdaptCommand) => void;
    onIdr?: () => void;
    now?: () => number;
    initialRung?: number;
    initialBitrate?: number;
    /** Milliseconds of video RTP flow required before RR/REMB adaptation activates (default 3000ms). */
    warmupMs?: number;
};

export const ADAPTIVE_LADDER: readonly AdaptiveRung[] = [
    {
        rung: 0,
        maxWidth: 426,
        maxHeight: 240,
        fps: 15,
        minBitrate: 150_000,
        maxBitrate: 300_000,
        defaultBitrate: 240_000,
        stepDownFloor: 0,
        stepUpCeiling: 400_000
    },
    {
        rung: 1,
        maxWidth: 640,
        maxHeight: 360,
        fps: 24,
        minBitrate: 300_000,
        maxBitrate: 650_000,
        defaultBitrate: 500_000,
        stepDownFloor: 240_000,
        stepUpCeiling: 820_000
    },
    {
        rung: 2,
        maxWidth: 960,
        maxHeight: 540,
        fps: 30,
        minBitrate: 650_000,
        maxBitrate: 1_200_000,
        defaultBitrate: 950_000,
        stepDownFloor: 500_000,
        stepUpCeiling: 1_500_000
    },
    {
        rung: 3,
        maxWidth: 1280,
        maxHeight: 720,
        fps: 30,
        minBitrate: 1_200_000,
        maxBitrate: 2_500_000,
        defaultBitrate: 1_800_000,
        stepDownFloor: 950_000,
        stepUpCeiling: 3_000_000
    },
    {
        rung: 4,
        maxWidth: 1920,
        maxHeight: 1080,
        fps: 30,
        minBitrate: 2_500_000,
        maxBitrate: 4_500_000,
        defaultBitrate: 1_800_000,
        stepDownFloor: 1_800_000,
        stepUpCeiling: Number.POSITIVE_INFINITY
    }
];

const STEP_DOWN_HOLD_MS = 2_000;
const SUSTAINED_BELOW_FLOOR_HOLD_MS = 10_000;
const VIDEO_WARMUP_MS = 3_000;
const STEP_DOWN_FLOOR_RUNG = 2;
const STEP_UP_HOLD_MS = 6_000;
const COOLDOWN_SCHEDULE_MS = [8_000, 14_000, 20_000] as const;
const OSCILLATION_WINDOW_MS = 30_000;
const STABLE_RESET_MS = 60_000;
const WITHIN_RUNG_INTERVAL_MS = 500;
const WITHIN_RUNG_DEADBAND = 0.1;
const IDR_COOLDOWN_MS = 300;
const RR_LOSS_SOFT_THRESHOLD = 0.05;
const RR_LOSS_STEP_UP_MAX = 0.01;
const RR_RTT_HARD_MS = 400;
const RR_RTT_STEP_UP_MAX_MS = 200;

export class FaceTimeAdaptiveController {
    private readonly onAdapt: (cmd: AdaptCommand) => void;
    private readonly onIdr?: () => void;
    private readonly now: () => number;
    private readonly initialRung: number;
    private readonly initialBitrate: number;
    private readonly warmupMs: number;

    private rungIndex: number;
    private currentBitrate: number;
    private lastBwe: number | undefined;
    private lastFractionLost = 0;
    private lastRttMs: number | undefined;
    private consecutiveHighLoss = 0;
    private severeConditionSince: number | null = null;
    private lowBweSince: number | null = null;
    private stepUpEligibleSince: number | null = null;
    private lastDropAt: number | null = null;
    private lastStepUpAt: number | null = null;
    private oscillationCount = 0;
    private lastBitrateAdaptAt: number | null = null;
    private lastIdrAt: number | null = null;
    private videoFlowStartedAt: number | null = null;

    constructor(options: FaceTimeAdaptiveControllerOptions) {
        this.onAdapt = options.onAdapt;
        this.onIdr = options.onIdr;
        this.now = options.now ?? (() => Date.now());
        this.initialRung = Math.max(0, Math.min(ADAPTIVE_LADDER.length - 1, options.initialRung ?? 4));
        this.initialBitrate = options.initialBitrate ?? ADAPTIVE_LADDER[this.initialRung].defaultBitrate;
        this.warmupMs = Math.max(0, options.warmupMs ?? VIDEO_WARMUP_MS);
        this.rungIndex = this.initialRung;
        this.currentBitrate = this.initialBitrate;
    }

    markVideoRtpSent(timestampMs = this.now()): void {
        if (this.videoFlowStartedAt === null) {
            this.videoFlowStartedAt = timestampMs;
        }
    }

    reset(): void {
        this.rungIndex = this.initialRung;
        this.currentBitrate = this.initialBitrate;
        this.lastBwe = undefined;
        this.lastFractionLost = 0;
        this.lastRttMs = undefined;
        this.consecutiveHighLoss = 0;
        this.severeConditionSince = null;
        this.lowBweSince = null;
        this.stepUpEligibleSince = null;
        this.lastDropAt = null;
        this.lastStepUpAt = null;
        this.oscillationCount = 0;
        this.lastBitrateAdaptAt = null;
        this.lastIdrAt = null;
        this.videoFlowStartedAt = null;
    }

    private isWarmedUp(timestampMs: number): boolean {
        return this.videoFlowStartedAt !== null && timestampMs - this.videoFlowStartedAt >= this.warmupMs;
    }

    getState(): FaceTimeAdaptiveState {
        const rung = ADAPTIVE_LADDER[this.rungIndex];
        return {
            rung: rung.rung,
            maxWidth: rung.maxWidth,
            maxHeight: rung.maxHeight,
            fps: rung.fps,
            bitrate: this.currentBitrate,
            oscillationCount: this.oscillationCount,
            cooldownMs: this.getCurrentCooldownMs()
        };
    }

    updateBitrate(bps: number, timestampMs = this.now()): void {
        if (!Number.isFinite(bps) || bps <= 0) return;
        if (!this.isWarmedUp(timestampMs)) return;
        this.lastBwe = bps;
        this.evaluate(timestampMs, true);
    }

    updateRtcpFeedback(sample: RtcpFeedbackSample, timestampMs = this.now()): void {
        if (!this.isWarmedUp(timestampMs)) return;
        if (sample.fractionLost !== undefined && Number.isFinite(sample.fractionLost)) {
            this.lastFractionLost = Math.max(0, Math.min(1, sample.fractionLost));
            if (this.lastFractionLost > RR_LOSS_SOFT_THRESHOLD) {
                this.consecutiveHighLoss += 1;
            } else {
                this.consecutiveHighLoss = 0;
            }
        }
        if (sample.rttMs !== undefined && Number.isFinite(sample.rttMs) && sample.rttMs >= 0) {
            this.lastRttMs = sample.rttMs;
        }

        const severeLoss = this.consecutiveHighLoss >= 2;
        const severeRtt = this.lastRttMs !== undefined && this.lastRttMs > RR_RTT_HARD_MS;

        if (severeLoss || severeRtt) {
            if (this.severeConditionSince === null) {
                this.severeConditionSince = timestampMs;
            }
        } else {
            this.severeConditionSince = null;
        }

        this.evaluate(timestampMs, false);
    }

    tick(timestampMs = this.now()): void {
        this.evaluate(timestampMs, false);
    }

    requestIdr(timestampMs = this.now()): boolean {
        if (this.lastIdrAt !== null && timestampMs - this.lastIdrAt < IDR_COOLDOWN_MS) {
            return false;
        }
        this.lastIdrAt = timestampMs;
        this.onIdr?.();
        return true;
    }

    private getCurrentCooldownMs(): number {
        const idx = Math.min(COOLDOWN_SCHEDULE_MS.length - 1, this.oscillationCount);
        return COOLDOWN_SCHEDULE_MS[idx];
    }

    private evaluate(timestampMs: number, allowWithinRungUpdate: boolean): void {
        if (
            this.oscillationCount > 0 &&
            this.lastDropAt !== null &&
            timestampMs - this.lastDropAt >= STABLE_RESET_MS
        ) {
            this.oscillationCount = 0;
        }

        const rung = ADAPTIVE_LADDER[this.rungIndex];
        const stepDownHoldMs =
            this.rungIndex <= STEP_DOWN_FLOOR_RUNG ? SUSTAINED_BELOW_FLOOR_HOLD_MS : STEP_DOWN_HOLD_MS;
        const canStepDownNow =
            this.rungIndex > 0 &&
            (this.lastDropAt === null || timestampMs - this.lastDropAt >= STEP_DOWN_HOLD_MS);

        if (
            canStepDownNow &&
            this.severeConditionSince !== null &&
            timestampMs - this.severeConditionSince >= stepDownHoldMs
        ) {
            this.stepDown(timestampMs);
            return;
        }

        if (this.rungIndex > 0 && this.lastBwe !== undefined) {
            if (this.lastBwe < rung.stepDownFloor) {
                this.stepUpEligibleSince = null;
                if (this.lowBweSince === null) {
                    this.lowBweSince = timestampMs;
                }
                if (canStepDownNow && timestampMs - this.lowBweSince >= stepDownHoldMs) {
                    this.stepDown(timestampMs);
                    return;
                }
            } else {
                this.lowBweSince = null;
            }
        } else {
            this.lowBweSince = null;
        }

        if (this.rungIndex < ADAPTIVE_LADDER.length - 1) {
            const bweOk = this.lastBwe !== undefined && this.lastBwe >= rung.stepUpCeiling;
            const lossOk = this.lastFractionLost < RR_LOSS_STEP_UP_MAX;
            const rttOk = this.lastRttMs === undefined || this.lastRttMs < RR_RTT_STEP_UP_MAX_MS;

            if (bweOk && lossOk && rttOk) {
                if (this.stepUpEligibleSince === null) {
                    this.stepUpEligibleSince = timestampMs;
                }
                const cooldownElapsed =
                    this.lastDropAt === null || timestampMs - this.lastDropAt >= this.getCurrentCooldownMs();
                if (cooldownElapsed && timestampMs - this.stepUpEligibleSince >= STEP_UP_HOLD_MS) {
                    this.stepUp(timestampMs);
                    return;
                }
            } else {
                this.stepUpEligibleSince = null;
            }
        } else {
            this.stepUpEligibleSince = null;
        }

        if (allowWithinRungUpdate && this.lastBwe !== undefined) {
            // Rung 4 starts at 1.8 Mbps downlink so allow smooth ramp from 1.8 -> 4.5 Mbps within rung 4.
            const floor = this.rungIndex === ADAPTIVE_LADDER.length - 1 ? 1_800_000 : rung.minBitrate;
            const target = Math.round(Math.max(floor, Math.min(rung.maxBitrate, this.lastBwe)));
            const elapsed =
                this.lastBitrateAdaptAt === null ? Number.POSITIVE_INFINITY : timestampMs - this.lastBitrateAdaptAt;
            const relDelta = Math.abs(target - this.currentBitrate) / Math.max(1, this.currentBitrate);
            if (elapsed >= WITHIN_RUNG_INTERVAL_MS && relDelta >= WITHIN_RUNG_DEADBAND) {
                this.currentBitrate = target;
                this.lastBitrateAdaptAt = timestampMs;
                this.emitAdapt();
            }
        }
    }

    private stepDown(timestampMs: number): void {
        if (this.rungIndex <= 0) return;

        if (this.lastStepUpAt !== null && timestampMs - this.lastStepUpAt <= OSCILLATION_WINDOW_MS) {
            this.oscillationCount = Math.min(COOLDOWN_SCHEDULE_MS.length - 1, this.oscillationCount + 1);
        }
        this.lastStepUpAt = null;
        this.lastDropAt = timestampMs;
        this.rungIndex -= 1;
        this.consecutiveHighLoss = 0;
        this.severeConditionSince = null;
        this.lowBweSince = null;
        this.stepUpEligibleSince = null;

        const nextRung = ADAPTIVE_LADDER[this.rungIndex];
        const candidate =
            this.lastBwe !== undefined ? Math.min(nextRung.maxBitrate, this.lastBwe) : nextRung.defaultBitrate;
        this.currentBitrate = Math.round(Math.max(nextRung.minBitrate, Math.min(nextRung.maxBitrate, candidate)));
        this.lastBitrateAdaptAt = timestampMs;
        this.emitAdapt();
    }

    private stepUp(timestampMs: number): void {
        if (this.rungIndex >= ADAPTIVE_LADDER.length - 1) return;

        this.rungIndex += 1;
        this.lastStepUpAt = timestampMs;
        this.lowBweSince = null;
        this.stepUpEligibleSince = null;

        const nextRung = ADAPTIVE_LADDER[this.rungIndex];
        const candidate = this.lastBwe ?? nextRung.defaultBitrate;
        this.currentBitrate = Math.round(Math.max(nextRung.minBitrate, Math.min(nextRung.maxBitrate, candidate)));
        this.lastBitrateAdaptAt = timestampMs;
        this.emitAdapt();
    }

    private emitAdapt(): void {
        const rung = ADAPTIVE_LADDER[this.rungIndex];
        this.onAdapt({
            cmd: "adapt",
            maxWidth: rung.maxWidth,
            maxHeight: rung.maxHeight,
            fps: rung.fps,
            bitrate: this.currentBitrate
        });
    }
}
