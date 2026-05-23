// Welch's two-sample t-test and Cohen's d — written from scratch.
// No external statistics library. Uses Lanczos gamma + Lentz continued-fraction beta.

import type { StatsResult } from '../types/index.js';

export const MIN_SAMPLE_SIZE = 15;

// ── Basic descriptive stats ───────────────────────────────────────────────────

export function mean(arr: number[]): number {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function variance(arr: number[]): number {
  // Unbiased sample variance (n-1 denominator)
  const m = mean(arr);
  return arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
}

export function stdDev(arr: number[]): number {
  return Math.sqrt(variance(arr));
}

// ── Lanczos approximation for ln(Γ(x)), accurate to ~15 decimal places ───────

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lnGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula: Γ(x)Γ(1-x) = π/sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS_C[0];
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// ── Regularized incomplete beta function I_x(a,b) using Lentz CF ─────────────
// Used to compute the t-distribution CDF via: P(T≤t|df) = 1 - I_x(df/2, 1/2)/2
// where x = df/(df+t²).

function betaCF(x: number, a: number, b: number): number {
  // Continued fraction for betainc using Lentz's algorithm
  const MAXIT = 200;
  const EPS = 3e-15;
  const FPMIN = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1.0;
  let d = 1.0 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1.0 / d;
  let h = d;

  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    // Even step
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d;
    h *= d * c;
    // Odd step
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1.0) < EPS) break;
  }
  return h;
}

function betaInc(x: number, a: number, b: number): number {
  if (x < 0 || x > 1) throw new Error(`betaInc: x=${x} out of range [0,1]`);
  if (x === 0) return 0;
  if (x === 1) return 1;

  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;

  // Use the symmetry relation for numerical stability
  if (x < (a + 1) / (a + b + 2)) {
    return front * betaCF(x, a, b);
  } else {
    return 1 - Math.exp(Math.log(1 - x) * b + Math.log(x) * a - lbeta) / b * betaCF(1 - x, b, a);
  }
}

// Two-tailed p-value from t-distribution with df degrees of freedom.
function tDistPValue(t: number, df: number): number {
  const x = df / (df + t * t);
  // P(|T| > |t|) = I_x(df/2, 1/2)
  return betaInc(x, df / 2, 0.5);
}

// ── Welch's t-test ────────────────────────────────────────────────────────────

export function welchTTest(a: number[], b: number[]): StatsResult {
  if (a.length < MIN_SAMPLE_SIZE || b.length < MIN_SAMPLE_SIZE) {
    throw new Error(
      `welchTTest requires at least ${MIN_SAMPLE_SIZE} samples per group. ` +
      `Got a=${a.length}, b=${b.length}.`,
    );
  }

  const na = a.length, nb = b.length;
  const ma = mean(a), mb = mean(b);
  const va = variance(a), vb = variance(b);
  const sa = stdDev(a), sb = stdDev(b);

  const se = Math.sqrt(va / na + vb / nb);
  const t = (ma - mb) / se;

  // Welch–Satterthwaite degrees of freedom
  const df =
    (va / na + vb / nb) ** 2 /
    ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));

  const p = tDistPValue(Math.abs(t), df);

  // Cohen's d (pooled standard deviation)
  const pooledSd = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  const d = pooledSd > 0 ? Math.abs(ma - mb) / pooledSd : 0;

  // 95% confidence intervals
  const zCrit = 1.96; // approximate; exact would need inverse t-distribution
  const ci95A: [number, number] = [ma - zCrit * sa / Math.sqrt(na), ma + zCrit * sa / Math.sqrt(na)];
  const ci95B: [number, number] = [mb - zCrit * sb / Math.sqrt(nb), mb + zCrit * sb / Math.sqrt(nb)];

  return {
    meanA: ma,
    meanB: mb,
    stdDevA: sa,
    stdDevB: sb,
    tStatistic: t,
    pValue: p,
    cohensD: d,
    ci95A,
    ci95B,
    // Significance: p < 0.05 AND practical significance Cohen's d > 0.2
    significant: p < 0.05 && d > 0.2,
  };
}

// ── Mann-Whitney U (non-parametric fallback) ──────────────────────────────────
// Used when normality can't be assumed (e.g., binary resolution_rate scores).

export function mannWhitneyU(a: number[], b: number[]): { u: number; significant: boolean } {
  let u = 0;
  for (const x of a) {
    for (const y of b) {
      if (x > y) u++;
      else if (x === y) u += 0.5;
    }
  }
  const maxU = a.length * b.length;
  // Approximate normal: z = (U - maxU/2) / sqrt(maxU*(a.length+b.length+1)/12)
  const muU = maxU / 2;
  const sigmaU = Math.sqrt((maxU * (a.length + b.length + 1)) / 12);
  const z = Math.abs((u - muU) / sigmaU);
  // Two-tailed p from standard normal approximation: p ≈ 2*(1 - Φ(z))
  // Φ(z) approximation (Abramowitz & Stegun 26.2.17)
  const t2 = 1 / (1 + 0.3275911 * z);
  const phi =
    1 -
    (0.254829592 * t2 -
      0.284496736 * t2 ** 2 +
      1.421413741 * t2 ** 3 -
      1.453152027 * t2 ** 4 +
      1.061405429 * t2 ** 5) *
      Math.exp(-(z * z) / 2);
  const p = 2 * (1 - phi);
  return { u, significant: p < 0.05 };
}
