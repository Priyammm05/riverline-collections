import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { welchTTest, mean, MIN_SAMPLE_SIZE } from '../learning/stats.js';

// Two clearly different distributions — expect significant result
const HIGH = [7.2,7.8,8.1,6.9,7.5,8.3,7.0,7.6,8.0,7.4,7.9,8.2,7.1,7.7,8.4,7.3,7.8,8.0,7.2,7.6];
const LOW  = [5.1,5.8,4.9,6.0,5.3,5.7,4.8,5.5,6.1,5.2,5.6,4.7,5.9,5.4,6.2,5.0,5.8,5.3,5.1,5.6];

// Two nearly identical distributions — expect non-significant result
const SAME_A = [6.0,6.2,5.8,6.1,5.9,6.3,6.0,5.7,6.2,6.1,5.8,6.0,6.3,5.9,6.1,6.2,5.8,6.0,6.1,5.9];
const SAME_B = [6.1,5.9,6.2,6.0,5.8,6.3,6.0,6.1,5.9,6.2,5.8,6.1,6.0,5.9,6.3,6.0,6.2,5.8,6.1,6.0];

describe('Welch t-test', () => {
  it('detects significant difference between clearly different groups', () => {
    const r = welchTTest(HIGH, LOW);
    console.log(`  meanHigh=${mean(HIGH).toFixed(3)}, meanLow=${mean(LOW).toFixed(3)}`);
    console.log(`  t=${r.tStatistic.toFixed(3)}, p=${r.pValue.toFixed(4)}, d=${r.cohensD.toFixed(3)}`);
    assert.ok(r.pValue < 0.05,  `p=${r.pValue.toFixed(4)} should be < 0.05`);
    assert.ok(r.cohensD > 0.2,  `d=${r.cohensD.toFixed(3)} should be > 0.2`);
    assert.ok(r.significant,    'should be significant');
  });

  it('does NOT flag nearly identical distributions as significant', () => {
    const r = welchTTest(SAME_A, SAME_B);
    console.log(`  meanA=${mean(SAME_A).toFixed(3)}, meanB=${mean(SAME_B).toFixed(3)}`);
    console.log(`  t=${r.tStatistic.toFixed(3)}, p=${r.pValue.toFixed(4)}, d=${r.cohensD.toFixed(3)}`);
    assert.ok(!r.significant, `should NOT be significant (p=${r.pValue.toFixed(4)}, d=${r.cohensD.toFixed(3)})`);
  });

  it('throws when sample size < MIN_SAMPLE_SIZE', () => {
    assert.throws(
      () => welchTTest([1, 2, 3], [4, 5, 6]),
      /at least 15 samples/,
    );
  });

  it('p-value is in [0, 1]', () => {
    const r = welchTTest(HIGH, LOW);
    assert.ok(r.pValue >= 0 && r.pValue <= 1, `p=${r.pValue} out of range`);
  });

  it('meanA and meanB match actual means', () => {
    const r = welchTTest(HIGH, LOW);
    assert.ok(Math.abs(r.meanA - mean(HIGH)) < 1e-9);
    assert.ok(Math.abs(r.meanB - mean(LOW))  < 1e-9);
  });
});
