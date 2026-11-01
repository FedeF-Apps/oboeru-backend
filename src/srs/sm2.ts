export type SrsState = 'new' | 'learning' | 'review' | 'suspended' | 'deleted';

/**
 * Calificación del usuario estilo Anki:
 * 1 = Again (Olvidado)
 * 2 = Hard  (Difícil)
 * 3 = Good  (Bien)
 * 4 = Easy  (Fácil)
 */
export type ReviewRating = 1 | 2 | 3 | 4;

export interface SrsCardState {
  state: SrsState;
  easeFactor: number;
  intervalDays: number;
  lapses: number;
}

export interface SrsCalculationResult extends SrsCardState {
  nextReviewDate: Date;
}

const MIN_EASE_FACTOR = 1.3;

/**
 * Algoritmo SRS basado en SuperMemo SM-2 / Anki para calcular el próximo repaso.
 */
export function calculateNextReview(
  current: SrsCardState,
  rating: ReviewRating,
  now: Date = new Date()
): SrsCalculationResult {
  let { state, easeFactor, intervalDays, lapses } = current;

  if (rating === 1) {
    // Again: la tarjeta vuelve a aprendizaje, suma un lapso y reduce el ease factor
    if (state === 'review') {
      lapses += 1;
    }
    state = 'learning';
    intervalDays = 1;
    easeFactor = Math.max(MIN_EASE_FACTOR, Number((easeFactor - 0.2).toFixed(2)));
  } else if (state === 'new' || state === 'learning' || state === 'deleted') {
    // Graduación desde new / learning (o reactivación) hacia review
    state = 'review';
    intervalDays = rating === 4 ? 4 : 1;
  } else {
    // Estado 'review' con respuesta exitosa (2 = Hard, 3 = Good, 4 = Easy)
    if (rating === 2) {
      intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
      easeFactor = Math.max(MIN_EASE_FACTOR, Number((easeFactor - 0.15).toFixed(2)));
    } else if (rating === 3) {
      intervalDays = Math.max(1, Math.round(intervalDays * easeFactor));
    } else if (rating === 4) {
      intervalDays = Math.max(1, Math.round(intervalDays * easeFactor * 1.3));
      easeFactor = Number((easeFactor + 0.15).toFixed(2));
    }
  }

  const nextReviewDate = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);

  return {
    state,
    easeFactor,
    intervalDays,
    lapses,
    nextReviewDate,
  };
}
