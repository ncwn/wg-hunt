import type { SearchCard } from "@wg-hunt/core";

export function cardKey(card: SearchCard): string {
  return JSON.stringify([card.title, card.rent ?? null, card.size ?? null]);
}

export const cardKeyOf = (json: string): string => cardKey(JSON.parse(json) as SearchCard);
