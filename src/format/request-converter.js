/**
 * Request Converter
 * Converts Anthropic Messages API requests to Google Generative AI format
 */

import {
    GEMINI_MAX_OUTPUT_TOKENS,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { convertContentToParts, convertRole } from './content-converter.js';
import { sanitizeSchema, cleanSchema } from './schema-sanitizer.js';
import {
    restoreThinkingSignatures,
    removeTrailingThinkingBlocks,
    reorderAssistantContent,
    filterUnsignedThinkingBlocks,
    hasGeminiHistory,
    hasUnsignedThinkingBlocks,
    needsThinkingRecovery,
    closeToolLoopForThinking,
    cleanCacheControl,
    clampGeminiThinkingBudget
} from './thinking-utils.js';
import { logger } from '../utils/logger.js';

/**
 * Clean system instruction text from Claude Code artifacts.
 * Claude Code (v2.1.274+) injects billing headers into system prompt blocks:
 * e.g. "x-anthropic-billing-header: cc_version=2.1.274.834; cc_entrypoint=sdk-cli;"
 * Cloud Code API rejects requests containing this with 429 RESOURCE_EXHAUSTED.
 */
function cleanSystemInstructionText(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/^x-anthropic-billing-header:[^\n]*\n?/gim, '')
        .replace(/^x-anthropic-[a-z0-9_-]+:[^\n]*\n?/gim, '')
        .trim();
}

/**
 * Convert Anthropic Messages API request to the format expected by Cloud Code
 *
 * Uses Google Generative AI format, but for Claude models:
 * - Keeps tool_result in Anthropic format (required by Claude API)
 *
 * @param {Object} anthropicRequest - Anthropic format request
 * @returns {Object} Request body for Cloud Code API
 */
export function convertAnthropicToGoogle(anthropicRequest) {
    // [CRITICAL FIX] Pre-clean all cache_control fields from messages (Issue #189)
    // Claude Code CLI sends cache_control on various content blocks, but Cloud Code API
    // rejects them with "Extra inputs are not permitted". Clean them proactively here
    // before any other processing, following the pattern from Antigravity-Manager.
    const messages = cleanCacheControl(anthropicRequest.messages || []);

    const { system, max_tokens, temperature, top_p, top_k, stop_sequences, tools, tool_choice, thinking, output_config } = anthropicRequest;
    const modelName = anthropicRequest.model || '';
    const modelFamily = getModelFamily(modelName);
    const isClaudeModel = modelFamily === 'claude';
    const isGeminiModel = modelFamily === 'gemini';

    // Thinking is enabled on-demand (matching omniroute) or when model explicitly has -thinking in name
    const hasThinkingSuffix = modelName.toLowerCase().includes('thinking');
    const isThinkingExplicitlyEnabled = thinking?.type === 'enabled' || thinking?.type === 'adaptive';
    const hasEffortConfig = typeof output_config?.effort === 'string' && output_config.effort.toLowerCase() !== 'none';
    const isThinkingExplicitlyDisabled = thinking?.type === 'disabled';

    const shouldEnableThinking = !isThinkingExplicitlyDisabled && (
        isThinkingExplicitlyEnabled ||
        hasEffortConfig ||
        hasThinkingSuffix
    );

    const googleRequest = {
        contents: [],
        generationConfig: {}
    };

    // Handle system instruction
    if (system) {
        let systemParts = [];
        if (typeof system === 'string') {
            const cleaned = cleanSystemInstructionText(system);
            if (cleaned) {
                systemParts = [{ text: cleaned }];
            }
        } else if (Array.isArray(system)) {
            // Filter for text blocks as system prompts are usually text
            // Anthropic supports text blocks in system prompts
            systemParts = system
                .filter(block => block.type === 'text')
                .map(block => ({ text: cleanSystemInstructionText(block.text) }))
                .filter(block => block.text && block.text.length > 0);
        }

        if (systemParts.length > 0) {
            googleRequest.systemInstruction = {
                parts: systemParts
            };
        }
    }

    // Add interleaved thinking hint for Claude thinking models with tools
    if (isClaudeModel && shouldEnableThinking && tools && tools.length > 0) {
        const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
        if (!googleRequest.systemInstruction) {
            googleRequest.systemInstruction = { parts: [{ text: hint }] };
        } else {
            const lastPart = googleRequest.systemInstruction.parts[googleRequest.systemInstruction.parts.length - 1];
            if (lastPart && lastPart.text) {
                lastPart.text = `${lastPart.text}\n\n${hint}`;
            } else {
                googleRequest.systemInstruction.parts.push({ text: hint });
            }
        }
    }

    // Apply thinking recovery for Gemini thinking models when needed
    // Gemini needs recovery for tool loops/interrupted tools (stripped thinking)
    let processedMessages = messages;

    if (isGeminiModel && shouldEnableThinking && needsThinkingRecovery(messages)) {
        logger.debug('[RequestConverter] Applying thinking recovery for Gemini');
        processedMessages = closeToolLoopForThinking(messages, 'gemini');
    }

    // For Claude: apply recovery for cross-model (Gemini→Claude) or unsigned thinking blocks
    // Unsigned thinking blocks occur when Claude Code strips signatures it doesn't understand
    const needsClaudeRecovery = hasGeminiHistory(messages) || hasUnsignedThinkingBlocks(messages);
    if (isClaudeModel && shouldEnableThinking && needsClaudeRecovery && needsThinkingRecovery(messages)) {
        logger.debug('[RequestConverter] Applying thinking recovery for Claude');
        processedMessages = closeToolLoopForThinking(messages, 'claude');
    }

    // Convert messages to contents, then filter unsigned thinking blocks
    for (const msg of processedMessages) {
        let msgContent = msg.content;

        // For assistant messages, process thinking blocks and reorder content
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msgContent)) {
            // First, try to restore signatures for unsigned thinking blocks from cache
            msgContent = restoreThinkingSignatures(msgContent);
            // Remove trailing unsigned thinking blocks
            msgContent = removeTrailingThinkingBlocks(msgContent);
            // Reorder: thinking first, then text, then tool_use
            msgContent = reorderAssistantContent(msgContent);
        }

        const parts = convertContentToParts(msgContent, isClaudeModel, isGeminiModel);

        // SAFETY: Google API requires at least one part per content message
        // This happens when all thinking blocks are filtered out (unsigned)
        if (parts.length === 0) {
            // Use '.' instead of '' because claude models reject empty text parts.
            // A single period is invisible in practice but satisfies the API requirement.
            logger.warn('[RequestConverter] WARNING: Empty parts array after filtering, adding placeholder');
            parts.push({ text: '.' });
        }

        const content = {
            role: convertRole(msg.role),
            parts: parts
        };
        googleRequest.contents.push(content);
    }

    // Filter unsigned thinking blocks for Claude models
    if (isClaudeModel) {
        googleRequest.contents = filterUnsignedThinkingBlocks(googleRequest.contents);
    }

    // Generation config
    if (max_tokens) {
        googleRequest.generationConfig.maxOutputTokens = max_tokens;
    }
    if (temperature !== undefined) {
        googleRequest.generationConfig.temperature = temperature;
    }
    if (top_p !== undefined) {
        googleRequest.generationConfig.topP = top_p;
    } else {
        googleRequest.generationConfig.topP = 1.0;
    }
    if (top_k !== undefined) {
        googleRequest.generationConfig.topK = top_k;
    } else {
        googleRequest.generationConfig.topK = 40;
    }
    if (stop_sequences && stop_sequences.length > 0) {
        googleRequest.generationConfig.stopSequences = stop_sequences;
    }

    // Enable thinking on-demand when requested by client or for dedicated -thinking models (matching omniroute)
    if (shouldEnableThinking) {
        if (isClaudeModel) {
            let thinkingBudget = 32000;
            if (typeof thinking?.budget_tokens === 'number') {
                thinkingBudget = thinking.budget_tokens;
            } else if (typeof output_config?.effort === 'string') {
                const effortMap = { low: 1024, medium: 8192, high: 32000, max: 64000 };
                thinkingBudget = effortMap[output_config.effort.toLowerCase()] || 32000;
            }

            const thinkingConfig = {
                include_thoughts: true,
                thinking_budget: thinkingBudget
            };
            logger.debug(`[RequestConverter] Claude thinking enabled with budget: ${thinkingBudget}`);

            // Validate max_tokens > thinking_budget as required by the API
            const currentMaxTokens = googleRequest.generationConfig.maxOutputTokens;
            if (currentMaxTokens && currentMaxTokens <= thinkingBudget) {
                const adjustedMaxTokens = thinkingBudget + 8192;
                googleRequest.generationConfig.maxOutputTokens = adjustedMaxTokens;
            }

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        } else if (isGeminiModel) {
            let budget = 4096;
            if (typeof thinking?.budget_tokens === 'number') {
                budget = thinking.budget_tokens;
            } else if (typeof output_config?.effort === 'string') {
                const effortMap = { low: 1024, medium: 8192, high: 16384, max: 24576 };
                budget = effortMap[output_config.effort.toLowerCase()] || 4096;
            }

            const thinkingBudget = clampGeminiThinkingBudget(modelName, budget);
            const thinkingConfig = {
                includeThoughts: true,
                thinkingBudget
            };
            logger.debug(`[RequestConverter] Gemini thinking enabled with budget: ${thinkingConfig.thinkingBudget}`);

            // Ensure maxOutputTokens is greater than thinkingBudget so thoughts don't exhaust the full response cap
            const currentMaxTokens = googleRequest.generationConfig.maxOutputTokens;
            if (currentMaxTokens && currentMaxTokens <= thinkingBudget) {
                const adjustedMaxTokens = Math.min(thinkingBudget + 4096, GEMINI_MAX_OUTPUT_TOKENS);
                logger.debug(`[RequestConverter] Adjusting Gemini max_tokens from ${currentMaxTokens} to ${adjustedMaxTokens} for thinking budget`);
                googleRequest.generationConfig.maxOutputTokens = adjustedMaxTokens;
            }

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        }
    }

    // Convert tools to Google format
    if (tools && tools.length > 0) {
        const functionDeclarations = tools.map((tool, idx) => {
            // Extract name from various possible locations
            const name = tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;

            // Extract description from various possible locations
            const description = tool.description || tool.function?.description || tool.custom?.description || '';

            // Extract schema from various possible locations
            const schema = tool.input_schema
                || tool.function?.input_schema
                || tool.function?.parameters
                || tool.custom?.input_schema
                || tool.parameters
                || { type: 'object' };

            // Sanitize schema for general compatibility
            let parameters = sanitizeSchema(schema);

            // Apply Google-format cleaning for ALL models since they all go through
            // Cloud Code API which validates schemas using Google's protobuf format.
            // This fixes issue #82: /compact command fails with schema transformation error
            // "Proto field is not repeating, cannot start list" for Claude models.
            parameters = cleanSchema(parameters);

            return {
                name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
                description: description,
                parameters
            };
        });

        googleRequest.tools = [{ functionDeclarations }];
        logger.debug(`[RequestConverter] Tools: ${JSON.stringify(googleRequest.tools).substring(0, 300)}`);

        // For Claude models, set functionCallingConfig.mode = "VALIDATED"
        // This ensures strict parameter validation (matches opencode-antigravity-auth)
        if (isClaudeModel) {
            googleRequest.toolConfig = {
                functionCallingConfig: {
                    mode: 'VALIDATED'
                }
            };
        }
    }

    // Cap max tokens for Gemini models
    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        logger.debug(`[RequestConverter] Capping Gemini max_tokens from ${googleRequest.generationConfig.maxOutputTokens} to ${GEMINI_MAX_OUTPUT_TOKENS}`);
        googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    return googleRequest;
}
