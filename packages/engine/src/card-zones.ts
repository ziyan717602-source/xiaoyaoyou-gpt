import type { MatchState, RngState } from "./index.js";
import { shuffle } from "./random.js";
import type { CardInstanceId } from "./setup-content.js";

export interface DrawPlan {
  readonly cards: readonly CardInstanceId[];
  readonly drawPile: readonly CardInstanceId[];
  readonly discardPile: readonly CardInstanceId[];
  readonly rng: RngState;
}

export function planDraw(state: Readonly<MatchState>, count: number): DrawPlan {
  const cards: CardInstanceId[] = [];
  let drawPile = [...state.drawPile];
  let discardPile = [...state.discardPile];
  let rng = state.rng;
  while (cards.length < count) {
    if (drawPile.length === 0) {
      if (discardPile.length === 0) break;
      const shuffled = shuffle(discardPile, rng);
      drawPile = [...shuffled.values];
      discardPile = [];
      rng = shuffled.rng;
    }
    const card = drawPile.shift();
    if (card !== undefined) cards.push(card);
  }
  return { cards, drawPile, discardPile, rng };
}
