/**
 * Deterministic challenge & lift recency-decay context helpers for MCP read tools.
 * Pure functions: no Firestore, no network, no dashes in copy.
 */

export type ChallengeCategory = "consistency" | "recovery_mobility" | "strength_progression";

export interface SuggestedChallenge {
  challengeId: string;
  category: ChallengeCategory;
  title: string;
  description: string;
  durationDays: number;
  targetMetric: string;
  targetValue: number;
  unit: string;
  coachRationale: string;
}

export interface AthleteChallengeContextInput {
  sport?: string | null;
  hasActiveInjury: boolean;
  completedSessionsLast28d?: number;
  plannedSessionsLast28d?: number;
  benchmarks?: Array<{
    benchmarkId: string;
    exerciseName: string;
    currentValue: number;
    unit: string;
  }>;
}

export interface AthleteChallengeFacts {
  sport?: string;
  hasActiveInjury: boolean;
  completedSessionsLast28d: number;
  plannedSessionsLast28d: number;
  suggestedChallenges: SuggestedChallenge[];
}

export interface LoggedLiftSample {
  exerciseName: string;
  estimatedOneRepMaxKg: number;
  loggedAt?: string;
  daysAgo?: number;
}

export interface SimilarLiftRecommendation {
  targetExerciseName: string;
  sourceExerciseName: string;
  similarityFactor: number;
  daysSinceSample: number;
  recencyDecayFactor: number;
  decayedEstimated1RmKg: number;
  recommendedWeightKg: number;
  targetReps: number;
  targetRir: number;
  rationale: string;
}

const RECENCY_GRACE_DAYS = 14;
const RECENCY_DECAY_PER_DAY = 0.002;
const RECENCY_DECAY_FLOOR = 0.8;

const LIFT_SIMILARITY_PAIRS: ReadonlyArray<{ a: string; b: string; factor: number }> = [
  { a: "barbell bench press", b: "incline dumbbell bench press", factor: 0.72 },
  { a: "barbell bench press", b: "dumbbell bench press", factor: 0.78 },
  { a: "conventional deadlift", b: "romanian deadlift", factor: 0.68 },
  { a: "back squat", b: "front squat", factor: 0.8 },
  { a: "back squat", b: "goblet squat", factor: 0.45 },
  { a: "overhead press", b: "dumbbell shoulder press", factor: 0.75 },
];

export function computeRecencyDecayFactor(daysSinceSample: number): number {
  if (!Number.isFinite(daysSinceSample) || daysSinceSample <= RECENCY_GRACE_DAYS) return 1;
  const excessDays = daysSinceSample - RECENCY_GRACE_DAYS;
  const raw = 1 - excessDays * RECENCY_DECAY_PER_DAY;
  return Math.max(RECENCY_DECAY_FLOOR, Math.round(raw * 1000) / 1000);
}

export function recommendStartingWeightFromSimilarLifts(params: {
  targetExerciseName: string;
  loggedLifts: LoggedLiftSample[];
  targetReps?: number;
  targetRir?: number;
  now?: Date;
}): SimilarLiftRecommendation | null {
  const targetNorm = params.targetExerciseName.trim().toLowerCase();
  if (!targetNorm || params.loggedLifts.length === 0) return null;

  const targetReps = Math.max(1, Math.min(30, Math.round(params.targetReps ?? 8)));
  const targetRir = Math.max(0, Math.min(6, Math.round(params.targetRir ?? 2)));
  const nowMs = (params.now ?? new Date()).getTime();

  let best: { sample: LoggedLiftSample; factor: number } | null = null;
  for (const sample of params.loggedLifts) {
    if (!Number.isFinite(sample.estimatedOneRepMaxKg) || sample.estimatedOneRepMaxKg <= 0) continue;
    const srcNorm = sample.exerciseName.trim().toLowerCase();
    let factor = srcNorm === targetNorm ? 0.95 : 0;
    if (factor === 0) {
      for (const pair of LIFT_SIMILARITY_PAIRS) {
        if ((pair.a === srcNorm && pair.b === targetNorm) || (pair.b === srcNorm && pair.a === targetNorm)) {
          factor = pair.factor;
          break;
        }
      }
    }
    if (factor > 0 && (!best || factor > best.factor)) {
      best = { sample, factor };
    }
  }
  if (!best) return null;

  let daysSinceSample = 0;
  if (typeof best.sample.daysAgo === "number" && Number.isFinite(best.sample.daysAgo)) {
    daysSinceSample = Math.max(0, Math.round(best.sample.daysAgo));
  } else if (typeof best.sample.loggedAt === "string") {
    const parsedMs = Date.parse(best.sample.loggedAt);
    if (Number.isFinite(parsedMs)) {
      daysSinceSample = Math.max(0, Math.round((nowMs - parsedMs) / (24 * 60 * 60 * 1000)));
    }
  }

  const recencyDecayFactor = computeRecencyDecayFactor(daysSinceSample);
  const decayedEstimated1RmKg = Math.round(best.sample.estimatedOneRepMaxKg * recencyDecayFactor * 10) / 10;
  const effectiveReps = targetReps + targetRir;
  const brzyckiMultiplier = Math.max(0.45, (37 - effectiveReps) / 36);
  const rawWeight = decayedEstimated1RmKg * best.factor * brzyckiMultiplier;
  const recommendedWeightKg = Math.max(2.5, Math.round(rawWeight / 2.5) * 2.5);

  return {
    targetExerciseName: params.targetExerciseName,
    sourceExerciseName: best.sample.exerciseName,
    similarityFactor: best.factor,
    daysSinceSample,
    recencyDecayFactor,
    decayedEstimated1RmKg,
    recommendedWeightKg,
    targetReps,
    targetRir,
    rationale:
      `Estimated from ${best.sample.exerciseName} (${decayedEstimated1RmKg} kg decayed 1RM, ` +
      `recency factor ${recencyDecayFactor}, factor ${best.factor}) for ${targetReps} reps at ${targetRir} RIR.`,
  };
}

export function buildAthleteChallengeFacts(
  input: AthleteChallengeContextInput,
): AthleteChallengeFacts {
  const completedSessionsLast28d = Math.max(0, Math.round(input.completedSessionsLast28d ?? 0));
  const plannedSessionsLast28d = Math.max(0, Math.round(input.plannedSessionsLast28d ?? 0));
  const hasActiveInjury = input.hasActiveInjury === true;

  const challenges: SuggestedChallenge[] = [];
  const planned = Math.max(1, plannedSessionsLast28d);
  const adherenceRatio = completedSessionsLast28d / planned;
  const weeklyTarget = Math.max(2, Math.min(6, Math.round(planned / 4)));

  challenges.push({
    challengeId: `challenge_consistency_${weeklyTarget}x_2w`,
    category: "consistency",
    title: `${weeklyTarget}x/Week Unbroken Rhythm (14 Days)`,
    description: `Complete ${weeklyTarget * 2} planned sessions over the next 14 days without missing back to back scheduled days.`,
    durationDays: 14,
    targetMetric: "completed_sessions",
    targetValue: weeklyTarget * 2,
    unit: "sessions",
    coachRationale:
      adherenceRatio >= 0.8
        ? "You are already hitting >80% adherence, locking in 2 unbroken weeks cements momentum."
        : "Focusing on a realistic weekly rhythm builds momentum before pushing intensity.",
  });

  if (hasActiveInjury) {
    challenges.push({
      challengeId: "challenge_recovery_pain_free_14d",
      category: "recovery_mobility",
      title: "14 Day Pain Free Rehab and Mobility Anchor",
      description: "Log 10 minutes of targeted mobility or rehab work on 5 days per week while keeping session RPE <= 7.",
      durationDays: 14,
      targetMetric: "mobility_sessions",
      targetValue: 10,
      unit: "sessions",
      coachRationale:
        "Active injury detected on file, protecting healing tissue while maintaining daily movement habits.",
    });
  } else {
    const firstBenchmark = (input.benchmarks ?? []).find(
      (b) => Number.isFinite(b.currentValue) && b.currentValue > 0,
    );
    if (firstBenchmark) {
      const microGain = Math.round(firstBenchmark.currentValue * 1.025 * 10) / 10;
      challenges.push({
        challengeId: `challenge_pr_${firstBenchmark.benchmarkId}_4w`,
        category: "strength_progression",
        title: `${firstBenchmark.exerciseName} +2.5% Progression Block`,
        description: `Build your ${firstBenchmark.exerciseName} from ${firstBenchmark.currentValue} ${firstBenchmark.unit} to ${microGain} ${firstBenchmark.unit} over a 28 day block.`,
        durationDays: 28,
        targetMetric: firstBenchmark.benchmarkId,
        targetValue: microGain,
        unit: firstBenchmark.unit,
        coachRationale:
          "A controlled 2.5% progression over 4 weeks stimulates adaptation without exceeding connective tissue recovery.",
      });
    }
  }

  return {
    ...(typeof input.sport === "string" && input.sport.trim() ? { sport: input.sport.trim() } : {}),
    hasActiveInjury,
    completedSessionsLast28d,
    plannedSessionsLast28d,
    suggestedChallenges: challenges,
  };
}
