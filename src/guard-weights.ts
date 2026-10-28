/** Public, versioned multiplier-baccarat weights. No imports from the game implementation. */
export const GUARD_MULTIPLIER_VERSION = 'baccarat-multiplier/1';
export interface GuardMultiplierConfig {
  id: 'multiplier' | 'max' | 'jade' | 'gold'; feePercent: number; bankerCommission: number; tieOdds: number; pairOdds: number;
  kDist: Array<{ k: number; weight: number; multipliers: Array<{ value: number; weight: number }> }>;
  winCap: number; mainMax: number | null; sideMax: number;
}
type WeightedValue = { value: number; weight: number };
type MultiplierConfig = GuardMultiplierConfig;
type MultiplierVariantId = GuardMultiplierConfig['id'];
const row = (...pairs: Array<[number, number]>): WeightedValue[] => pairs.map(([value, weight]) => ({ value, weight }));

export const MULTIPLIER_CONFIG: MultiplierConfig = {
  id: 'multiplier',
  feePercent: 20,
  kDist: [
    { k: 1, weight: 1110, multipliers: row([2, 1217], [3, 1590], [4, 1923], [5, 2229], [8, 3041]) },
    { k: 2, weight: 1441, multipliers: row([2, 2000], [3, 2000], [4, 2000], [5, 2000], [8, 2000]) },
    { k: 3, weight: 1870, multipliers: row([2, 2988], [3, 2287], [4, 1892], [5, 1634], [8, 1199]) },
    { k: 4, weight: 2428, multipliers: row([2, 4088], [3, 2395], [4, 1639], [5, 1221], [8, 657]) },
    { k: 5, weight: 3151, multipliers: row([2, 5182], [3, 2323], [4, 1315], [5, 846], [8, 334]) },
  ],
  bankerCommission: 5,
  tieOdds: 500,
  pairOdds: 900,
  winCap: 50_000_000,
  mainMax: 100_000,
  sideMax: 5_000,
};

export const MAX_CONFIG: MultiplierConfig = {
  id: 'max',
  feePercent: 50,
  kDist: [
    { k: 4, weight: 5472, multipliers: row([2, 15], [3, 638], [4, 2809], [5, 4462], [8, 1665], [10, 411]) },
    { k: 5, weight: 2543, multipliers: row([2, 40], [3, 1104], [4, 3481], [5, 4273], [8, 925], [10, 177]) },
    { k: 6, weight: 1181, multipliers: row([2, 101], [3, 1732], [4, 3917], [5, 3714], [8, 467], [10, 69]) },
    { k: 7, weight: 549, multipliers: row([2, 233], [3, 2501], [4, 4055], [5, 2969], [8, 217], [10, 25]) },
    { k: 8, weight: 255, multipliers: row([2, 497], [3, 3335], [4, 3875], [5, 2192], [8, 93], [10, 8]) },
  ],
  bankerCommission: 3,
  tieOdds: 285,
  pairOdds: 800,
  winCap: 50_000_000,
  mainMax: 50_000,
  sideMax: 5_000,
};

export const JADE_CONFIG: MultiplierConfig = {
  id: 'jade',
  feePercent: 20,
  kDist: [{ k: 8, weight: 10_000, multipliers: row([2, 9378], [3, 622]) }],
  bankerCommission: 5,
  tieOdds: 500,
  pairOdds: 1000,
  winCap: 50_000_000,
  mainMax: null,
  sideMax: 50_000,
};

export const GOLD_CONFIG: MultiplierConfig = {
  id: 'gold',
  feePercent: 20,
  kDist: [{ k: 5, weight: 10_000, multipliers: row([2, 4877], [3, 4385], [5, 638], [8, 100]) }],
  bankerCommission: 5,
  tieOdds: 500,
  pairOdds: 900,
  winCap: 50_000_000,
  mainMax: 100_000,
  sideMax: 5_000,
};

export const MULTIPLIER_CONFIGS: Record<MultiplierVariantId, MultiplierConfig> = {
  multiplier: MULTIPLIER_CONFIG,
  max: MAX_CONFIG,
  jade: JADE_CONFIG,
  gold: GOLD_CONFIG,
};
