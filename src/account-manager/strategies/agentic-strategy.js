/**
 * Agentic Strategy
 *
 * Prioritizes accounts that demonstrate sustained long-horizon capability
 * (many consecutive successful requests without rate limiting).
 * Mirrors the Nanbeige4.1-3B paper's 600 tool-call turn capability.
 *
 * This strategy rewards accounts that can handle extended tool interactions
 * without hitting rate limits, treating this as a signal of superior capability.
 */

import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';
import { formatDuration } from '../../utils/helpers.js';
import { MAX_WAIT_BEFORE_ERROR_MS } from '../../constants.js';

// Track consecutive successful requests per account per model
const consecutiveSuccessCache = new Map(); // `${email}:${modelId}` -> count

export class AgenticStrategy extends BaseStrategy {
    /**
     * Create a new AgenticStrategy
     * @param {Object} config - Strategy configuration
     */
    constructor(config = {}) {
        super(config);
        // Minimum consecutive successes to be considered "agentic capable"
        this.minConsecutiveSuccesses = config.minConsecutiveSuccesses || 10;
        // Maximum bonus score for agentic capability
        this.agenticBonus = config.agenticBonus || 50;
        // Decay factor for consecutive successes over time
        this.decayFactor = config.decayFactor || 0.95;
    }

    /**
     * Get the consecutive success count for an account+model
     * @private
     */
    #getConsecutiveSuccesses(email, modelId) {
        return consecutiveSuccessCache.get(`${email}:${modelId}`) || 0;
    }

    /**
     * Increment consecutive success count
     * @private
     */
    #incrementConsecutiveSuccesses(email, modelId) {
        const key = `${email}:${modelId}`;
        const current = consecutiveSuccessCache.get(key) || 0;
        consecutiveSuccessCache.set(key, current + 1);
    }

    /**
     * Reset consecutive success count
     * @private
     */
    #resetConsecutiveSuccesses(email, modelId) {
        consecutiveSuccessCache.delete(`${email}:${modelId}`);
    }

    /**
     * Apply time-based decay to all cached counts
     * @private
     */
    #applyDecay() {
        for (const [key, count] of consecutiveSuccessCache.entries()) {
            consecutiveSuccessCache.set(key, Math.floor(count * this.decayFactor));
        }
    }

    /**
     * Select an account prioritizing agentic capability
     *
     * Scoring combines:
     * - Base usability (from BaseStrategy)
     * - Agentic bonus for accounts with sustained success
     * - LRU preference for fair distribution
     *
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - The model ID for the request
     * @param {Object} options - Additional options
     * @returns {SelectionResult} The selected account and index
     */
    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        // Apply decay periodically (every 100 selections)
        if (Math.random() < 0.01) {
            this.#applyDecay();
        }

        // Get usable accounts
        const usableAccounts = this.getUsableAccounts(accounts, modelId);

        if (usableAccounts.length === 0) {
            // No usable accounts - check if we should wait
            const waitInfo = this.#shouldWaitForAccount(accounts, currentIndex, modelId);
            if (waitInfo.shouldWait) {
                const account = accounts[currentIndex];
                logger.info(`[AgenticStrategy] Waiting ${formatDuration(waitInfo.waitMs)} for account: ${account?.email}`);
                return { account: null, index: currentIndex, waitMs: waitInfo.waitMs };
            }
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        // Score each usable account
        const scoredAccounts = usableAccounts.map(({ account, index }) => {
            const email = account.email;
            const consecutiveSuccesses = this.#getConsecutiveSuccesses(email, modelId);

            // Base score: agentic bonus if we have enough consecutive successes
            let score = 0;
            if (consecutiveSuccesses >= this.minConsecutiveSuccesses) {
                // Bonus scales with consecutive successes, capped
                const bonusScale = Math.min(
                    consecutiveSuccesses / this.minConsecutiveSuccesses,
                    3 // Cap at 3x
                );
                score = this.agenticBonus * bonusScale;
            }

            // LRU component: prefer less recently used accounts for fairness
            const lastUsed = account.lastUsed || 0;
            const timeSinceLastUse = Date.now() - lastUsed;
            const lruScore = Math.min(timeSinceLastUse / 1000, 3600) * 0.01; // Up to 36 points for 1hr

            // Health score if available (from strategy's health tracker)
            let healthScore = 0;
            // Note: Health tracker access would need to be passed via config or options

            return {
                account,
                index,
                score: score + lruScore + healthScore,
                consecutiveSuccesses
            };
        });

        // Sort by score descending
        scoredAccounts.sort((a, b) => b.score - a.score);

        // Select the best account
        const best = scoredAccounts[0];
        best.account.lastUsed = Date.now();
        if (onSave) onSave();

        logger.info(`[AgenticStrategy] Using account: ${best.account.email} (score: ${best.score.toFixed(1)}, consecutive: ${best.consecutiveSuccesses})`);

        return { account: best.account, index: best.index, waitMs: 0 };
    }

    /**
     * Called after a successful request - increment consecutive success counter
     * @param {Object} account - The account that was used
     * @param {string} modelId - The model ID that was used
     */
    onSuccess(account, modelId) {
        if (account && account.email) {
            this.#incrementConsecutiveSuccesses(account.email, modelId);
        }
    }

    /**
     * Called when a request is rate-limited - reset consecutive success counter
     * @param {Object} account - The account that was rate-limited
     * @param {string} modelId - The model ID that was rate-limited
     */
    onRateLimit(account, modelId) {
        if (account && account.email) {
            this.#resetConsecutiveSuccesses(account.email, modelId);
        }
    }

    /**
     * Called when a request fails - reset consecutive success counter
     * @param {Object} account - The account that failed
     * @param {string} modelId - The model ID that failed
     */
    onFailure(account, modelId) {
        if (account && account.email) {
            this.#resetConsecutiveSuccesses(account.email, modelId);
        }
    }

    /**
     * Check if we should wait for an account's rate limit to reset
     * @private
     */
    #shouldWaitForAccount(accounts, currentIndex, modelId) {
        if (currentIndex < 0 || currentIndex >= accounts.length) {
            return { shouldWait: false, waitMs: 0 };
        }

        const account = accounts[currentIndex];
        if (!account || account.isInvalid || account.enabled === false) {
            return { shouldWait: false, waitMs: 0 };
        }

        let waitMs = 0;

        if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
            const limit = account.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime) {
                waitMs = limit.resetTime - Date.now();
            }
        }

        // Wait if within threshold
        if (waitMs > 0 && waitMs <= MAX_WAIT_BEFORE_ERROR_MS) {
            return { shouldWait: true, waitMs };
        }

        return { shouldWait: false, waitMs: 0 };
    }
}

export default AgenticStrategy;