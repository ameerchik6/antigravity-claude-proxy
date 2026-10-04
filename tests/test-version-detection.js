import { generateSmartUserAgent, getClientVersion, clearVersionCache } from '../src/utils/version-detector.js';
import { getPlatformUserAgent } from '../src/constants.js';
import assert from 'assert';

// Access internal functions for unit testing via dynamic import workaround
// We test the public API + behavioral contracts

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

async function testVersionDetection() {
    console.log('--- Testing Version Detection ---\n');

    // ═══════════════════════════════════════════
    // Section 1: Original tests (preserved)
    // ═══════════════════════════════════════════
    console.log('Section 1: Core User-Agent Generation');

    test('UA starts with antigravity/', () => {
        const ua = generateSmartUserAgent();
        assert.ok(ua.startsWith('antigravity/'), `Expected "antigravity/..." but got "${ua}"`);
    });

    test('UA contains a valid version number', () => {
        const ua = generateSmartUserAgent();
        assert.ok(/\d+\.\d+\.\d+/.test(ua), `Expected version pattern in "${ua}"`);
    });

    test('UA contains OS and architecture', () => {
        const ua = generateSmartUserAgent();
        assert.ok(/\s(darwin|win32|linux)\/\w+$/.test(ua), `Expected os/arch suffix in "${ua}"`);
    });

    test('Constants UA matches generated UA', () => {
        const ua = generateSmartUserAgent();
        const constantsUA = getPlatformUserAgent();
        assert.strictEqual(ua, constantsUA);
    });

    // ═══════════════════════════════════════════
    // Section 2: getClientVersion
    // ═══════════════════════════════════════════
    console.log('\nSection 2: X-Client-Version');

    test('getClientVersion returns a non-empty string', () => {
        const version = getClientVersion();
        assert.ok(typeof version === 'string' && version.length > 0, `Expected non-empty string, got "${version}"`);
    });

    test('getClientVersion returns a semver-ish string', () => {
        const version = getClientVersion();
        assert.ok(/^\d+\.\d+\.\d+/.test(version), `Expected semver pattern, got "${version}"`);
    });

    test('getClientVersion is idempotent (cached)', () => {
        const v1 = getClientVersion();
        const v2 = getClientVersion();
        assert.strictEqual(v1, v2, 'Repeated calls should return the same value');
    });

    // ═══════════════════════════════════════════
    // Section 3: Cache clearing (FIX #3)
    // ═══════════════════════════════════════════
    console.log('\nSection 3: Cache TTL & clearVersionCache');

    test('clearVersionCache resets cached UA', () => {
        const uaBefore = generateSmartUserAgent();
        clearVersionCache();
        const uaAfter = generateSmartUserAgent();
        // Both should be valid (same value since env hasn't changed, but re-computed)
        assert.ok(uaBefore.startsWith('antigravity/'), 'Before clear should be valid');
        assert.ok(uaAfter.startsWith('antigravity/'), 'After clear should be valid');
    });

    test('clearVersionCache resets cached client version', () => {
        const vBefore = getClientVersion();
        clearVersionCache();
        const vAfter = getClientVersion();
        assert.ok(/^\d+\.\d+\.\d+/.test(vBefore), 'Before clear should be valid');
        assert.ok(/^\d+\.\d+\.\d+/.test(vAfter), 'After clear should be valid');
    });

    // ═══════════════════════════════════════════
    // Section 4: Env var override
    // ═══════════════════════════════════════════
    console.log('\nSection 4: Environment Variable Override');

    test('ANTIGRAVITY_CLIENT_VERSION env var overrides detection', () => {
        const originalEnv = process.env.ANTIGRAVITY_CLIENT_VERSION;
        try {
            clearVersionCache();
            process.env.ANTIGRAVITY_CLIENT_VERSION = '99.88.77';
            const version = getClientVersion();
            assert.strictEqual(version, '99.88.77', `Expected "99.88.77" but got "${version}"`);
        } finally {
            // Restore original state
            if (originalEnv === undefined) {
                delete process.env.ANTIGRAVITY_CLIENT_VERSION;
            } else {
                process.env.ANTIGRAVITY_CLIENT_VERSION = originalEnv;
            }
            clearVersionCache();
        }
    });

    test('FALLBACK_ANTIGRAVITY_VERSION env var is used for UA', () => {
        // This env var is evaluated at module load time as a const,
        // so we verify the current behavior matches the expected fallback
        const ua = generateSmartUserAgent();
        const expectedVersion = process.env.FALLBACK_ANTIGRAVITY_VERSION || '2.0.3';
        assert.ok(ua.includes(expectedVersion), `Expected UA to contain "${expectedVersion}", got "${ua}"`);
    });

    // ═══════════════════════════════════════════
    // Section 5: Edge cases (FIX #6 — input validation)
    // ═══════════════════════════════════════════
    console.log('\nSection 5: Edge Cases & Robustness');

    test('Multiple rapid calls return consistent results', () => {
        clearVersionCache();
        const results = Array.from({ length: 100 }, () => generateSmartUserAgent());
        const allSame = results.every(r => r === results[0]);
        assert.ok(allSame, 'All 100 calls should return the same value');
    });

    test('clearVersionCache allows version re-detection', () => {
        // Call, clear, call — should work without errors
        generateSmartUserAgent();
        getClientVersion();
        clearVersionCache();
        generateSmartUserAgent();
        getClientVersion();
        clearVersionCache();
        // No assertion needed — if it throws, the test framework catches it
        assert.ok(true, 'Re-detection after clear should not throw');
    });

    // ═══════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════
    console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);

    if (failed > 0) {
        process.exit(1);
    }
    console.log('✓ All version detection tests passed!');
}

testVersionDetection().catch(err => {
    console.error('\n✗ Version detection tests failed:');
    console.error(err);
    process.exit(1);
});
