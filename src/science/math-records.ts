/**
 * Math Record Hunt — the problems and the best-known values to beat.
 *
 * Every record carries its source and the date it was read. The values were read
 * on 2026-11-04 and must be rechecked against the source before any claim is
 * called a record anywhere outside this site. A claim that beats a value here is
 * shown as UNCONFIRMED until a person reviews it and the record keeper accepts it.
 */

export type MathFamily = "packing" | "kissing" | "ramsey";

export type MathProblem = {
  id: string;
  family: MathFamily;
  kind: "record" | "practice";
  title: string;
  params: { n?: number; dim?: number; s?: number; t?: number };
  /** The value to beat, as text: a decimal (packing) or an integer (kissing count, Ramsey vertices). */
  record: string;
  record_meaning: string;
  /** Proven best possible: nothing can beat it, so it is a practice problem. */
  exact?: boolean;
  source: string;
  source_url: string;
  as_of: string;
  keeper: string;
};

const AS_OF = "2026-11-04";

const PACKOMANIA = "https://www.packomania.com/csq_sum/csq_sum.html";
// Packomania "circles in a square, maximal sum of radii" table, last updated 31 Oct 2026.
const PACKING: Record<number, string> = {
  2: "0.585786437626", 3: "0.796287456147", 4: "1.006788474668", 5: "1.103553390593", 6: "1.202838910871",
  7: "1.306546350758", 8: "1.423813915320", 9: "1.524365359370", 10: "1.591012852634", 11: "1.680058380778",
  12: "1.765978318170", 13: "1.829542411692", 14: "1.905667205293", 15: "1.980266508444", 16: "2.053080418439",
  17: "2.111185327830", 18: "2.178530295972", 19: "2.236704571294", 20: "2.301122834497", 21: "2.362117319374",
  22: "2.420202649747", 23: "2.478013611963", 24: "2.530311586971", 25: "2.587275055266", 26: "2.635983084919",
  27: "2.685978684198", 28: "2.737739985536", 29: "2.790344154631", 30: "2.842668747462", 31: "2.889969851933",
  32: "2.939572771205", 33: "2.987285008592", 34: "3.029799271186", 35: "3.074036363730",
};

const KISSING_URL = "https://en.wikipedia.org/wiki/Kissing_number";
// Known exactly in 1, 2, 3, 4, 8 and 24 dimensions; lower bounds elsewhere.
const KISSING: [number, number, boolean][] = [
  [2, 6, true], [3, 12, true], [4, 24, true], [8, 240, true],
  [5, 40, false], [6, 72, false], [7, 126, false], [9, 306, false], [10, 510, false], [11, 604, false], [12, 841, false],
];

const RAMSEY_SURVEY = "https://www.combinatorics.org/ojs/index.php/eljc/article/view/DS1";
const ALPHAEVOLVE_RAMSEY = "https://arxiv.org/abs/2603.09172";
// [s, t, best known lower bound L (so a witness graph on L-1 vertices is known), exact?, source]
const RAMSEY: [number, number, number, boolean, string][] = [
  [3, 3, 6, true, RAMSEY_SURVEY], [3, 4, 9, true, RAMSEY_SURVEY], [3, 5, 14, true, RAMSEY_SURVEY],
  [3, 6, 18, true, RAMSEY_SURVEY], [4, 4, 18, true, RAMSEY_SURVEY],
  [3, 10, 40, false, RAMSEY_SURVEY], [4, 6, 36, false, RAMSEY_SURVEY], [4, 7, 49, false, RAMSEY_SURVEY],
  [4, 8, 59, false, RAMSEY_SURVEY], [3, 13, 61, false, ALPHAEVOLVE_RAMSEY], [4, 13, 139, false, ALPHAEVOLVE_RAMSEY],
];

export const MATH_PROBLEMS: MathProblem[] = [
  ...Object.entries(PACKING).map(([k, v]): MathProblem => {
    const n = Number(k);
    return {
      id: `packing-${n}`, family: "packing", kind: "record", title: `${n} circles in a square: largest total radius`,
      params: { n }, record: v, record_meaning: `best known sum of radii for ${n} circles in the unit square`,
      source: "Packomania, circles in a square, maximal sum of radii (updated 31 Oct 2026)", source_url: PACKOMANIA, as_of: AS_OF,
      keeper: "Packomania (Eckard Specht)",
    };
  }),
  ...KISSING.map(([dim, v, exact]): MathProblem => ({
    id: `kissing-${dim}`, family: "kissing", kind: exact ? "practice" : "record",
    title: `Kissing number in ${dim} dimensions`, params: { dim }, record: String(v), exact,
    record_meaning: exact ? `proven maximum in ${dim} dimensions` : `best known lower bound in ${dim} dimensions`,
    source: "Kissing number table (Wikipedia, which cites the published constructions)", source_url: KISSING_URL, as_of: AS_OF,
    keeper: "Published literature; the Wikipedia table and Cohn's kissing number tables track it",
  })),
  ...RAMSEY.map(([s, t, L, exact, url]): MathProblem => ({
    id: `ramsey-${s}-${t}`, family: "ramsey", kind: exact ? "practice" : "record",
    title: `Ramsey number R(${s},${t}): a graph with no ${s}-clique and no ${t}-independent set`,
    params: { s, t }, record: String(L - 1), exact,
    record_meaning: exact ? `R(${s},${t}) = ${L}, so ${L - 1} vertices is the most possible` : `largest known witness graph: ${L - 1} vertices, so R(${s},${t}) ≥ ${L}`,
    source: url === ALPHAEVOLVE_RAMSEY ? "AlphaEvolve Ramsey lower bounds (arXiv 2603.09172, graphs public on GitHub)" : "Radziszowski, Small Ramsey Numbers (dynamic survey DS1)",
    source_url: url, as_of: AS_OF, keeper: "Radziszowski's dynamic survey of small Ramsey numbers",
  })),
];

const BY_ID = new Map(MATH_PROBLEMS.map((p) => [p.id, p]));
export const mathProblem = (id: string) => BY_ID.get(id);
