// Verify approved classification and exit semantics without changing test inputs.
const assert = require('node:assert/strict');
const { tests } = require('./review-regression-tiers.json');
const { hasMandatoryFailure, formatReviewResult, summarizeReviewResults } = require('./review-regressions.js');
assert.deepEqual(['Mandatory', 'Compatibility', 'Exploratory'].map(t => tests.filter(x => x.tier === t).length), [6, 6, 3]);
for (const test of tests) {
    const failure = { ...test, error: new Error('reporting sentinel') };
    assert.equal(hasMandatoryFailure([failure]), test.tier === 'Mandatory');
    assert.ok(formatReviewResult(failure).startsWith('FAIL '));
    assert.equal(summarizeReviewResults([failure])[test.tier].failed, 1);
    assert.equal(summarizeReviewResults([failure])[test.tier].passed, 0);
}
console.log('PASS classification and failure reporting for all 15 tests');
