/**
 * Content Converter
 * Converts Anthropic message content to Google Generative AI parts format
 */

import { MIN_SIGNATURE_LENGTH, GEMINI_SKIP_SIGNATURE } from '../constants.js';
import { getCachedSignature, getCachedSignatureFamily } from './signature-cache.js';
import { logger } from '../utils/logger.js';

/**
 * Validate and sanitize an image before sending to Cloud Code API.
 * Verifies base64 encoding, strips data URL prefix and whitespace,
 * enforces size limits, checks headers and dimensions for PNG, JPEG, and WebP,
 * verifies that the image is not truncated, and rejects unsupported/corrupt formats.
 *
 * @param {Object} source - Anthropic image source { type, media_type, data }
 * @returns {{ valid: boolean, mimeType?: string, data?: string, reason?: string }}
 */
export function validateAndSanitizeImage(source) {
    if (!source || typeof source !== 'object') {
        return { valid: false, reason: 'Invalid image source' };
    }
    let rawData = source.data;
    if (!rawData || typeof rawData !== 'string') {
        return { valid: false, reason: 'Empty or non-string image data' };
    }
    // Remove data URL prefix if present (e.g. "data:image/png;base64,") and clean whitespace
    rawData = rawData.replace(/^data:[^;]+;base64,/i, '').trim().replace(/\s+/g, '');
    if (rawData.length < 16) {
        return { valid: false, reason: 'Image base64 data too short' };
    }

    let buffer;
    try {
        buffer = Buffer.from(rawData, 'base64');
    } catch {
        return { valid: false, reason: 'Invalid base64 encoding' };
    }
    if (!buffer || buffer.length < 12) {
        return { valid: false, reason: 'Image binary data too short' };
    }

    // Google Cloud Code inlineData payload limit is ~20MB
    if (buffer.length > 20 * 1024 * 1024) {
        return { valid: false, reason: 'Image exceeds 20MB limit' };
    }

    let mimeType = (source.media_type || '').toLowerCase();
    if (mimeType === 'image/jpg') mimeType = 'image/jpeg';

    // 1. PNG check: 8-byte signature 89 50 4E 47 0D 0A 1A 0A
    if (buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
        buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
        mimeType = 'image/png';
        if (buffer.length < 45) {
            return { valid: false, reason: 'Truncated PNG (file too small)' };
        }
        const ihdrLength = buffer.readUInt32BE(8);
        const ihdrType = buffer.toString('ascii', 12, 16);
        if (ihdrLength !== 13 || ihdrType !== 'IHDR') {
            return { valid: false, reason: 'Corrupt PNG (missing or invalid IHDR chunk)' };
        }
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        if (width === 0 || height === 0) {
            return { valid: false, reason: 'Invalid PNG dimensions (0x0)' };
        }
        if (width > 16384 || height > 16384 || (width / height > 200) || (height / width > 200)) {
            return { valid: false, reason: `Extreme PNG dimensions (${width}x${height})` };
        }
        const tail = buffer.subarray(Math.max(0, buffer.length - 32)).toString('binary');
        if (!tail.includes('IEND')) {
            return { valid: false, reason: 'Truncated PNG (missing IEND chunk)' };
        }
        return { valid: true, mimeType, data: rawData };
    }

    // 2. JPEG check: starts with FF D8 FF, ends with FF D9
    if (buffer.length >= 4 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        mimeType = 'image/jpeg';
        let foundEoi = false;
        const scanStart = Math.max(2, buffer.length - 32);
        for (let i = scanStart; i < buffer.length - 1; i++) {
            if (buffer[i] === 0xFF && buffer[i + 1] === 0xD9) {
                foundEoi = true;
                break;
            }
        }
        if (!foundEoi) {
            return { valid: false, reason: 'Truncated JPEG (missing EOI marker FF D9)' };
        }

        // Try reading dimensions from SOF marker
        let pos = 2;
        let width = 0, height = 0;
        while (pos < buffer.length - 8) {
            if (buffer[pos] !== 0xFF) {
                pos++;
                continue;
            }
            const marker = buffer[pos + 1];
            // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
            if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
                if (pos + 9 <= buffer.length) {
                    height = buffer.readUInt16BE(pos + 5);
                    width = buffer.readUInt16BE(pos + 7);
                }
                break;
            }
            if (marker === 0xD9 || marker === 0xDA) break; // SOS or EOI
            if (marker === 0x00 || (marker >= 0xD0 && marker <= 0xD7)) {
                pos += 2;
            } else if (pos + 4 <= buffer.length) {
                const len = buffer.readUInt16BE(pos + 2);
                if (len < 2) break;
                pos += 2 + len;
            } else {
                break;
            }
        }
        if (width > 0 && height > 0) {
            if (width > 16384 || height > 16384 || (width / height > 200) || (height / width > 200)) {
                return { valid: false, reason: `Extreme JPEG dimensions (${width}x${height})` };
            }
        }
        return { valid: true, mimeType, data: rawData };
    }

    // 3. WebP check: RIFF .... WEBP
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        mimeType = 'image/webp';
        const declaredLength = buffer.readUInt32LE(4) + 8;
        if (buffer.length < declaredLength) {
            return { valid: false, reason: 'Truncated WebP (data is smaller than declared RIFF length)' };
        }
        return { valid: true, mimeType, data: rawData };
    }

    // 4. Reject GIF (not supported by Cloud Code API)
    if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        return { valid: false, reason: 'GIF format is not supported by Google Cloud Code API' };
    }

    // Strict rejection for unknown, unsupported, or corrupt image formats
    return { valid: false, reason: 'Unsupported or corrupt image format' };
}

/**
 * Check if an error message from Cloud Code is an invalid media error (e.g. error 2011)
 * @param {string} errorText
 * @returns {boolean}
 */
export function isInvalidMediaError(errorText) {
    if (!errorText || typeof errorText !== 'string') return false;
    return errorText.includes('INVALID_MEDIA') ||
           errorText.includes('"2011"') ||
           errorText.includes('Unable to process input image');
}

/**
 * Strip all image parts from a Google Generative AI request body,
 * replacing them with placeholder text to unblock conversations.
 * @param {Object} googleRequest - Google Generative AI request object
 * @returns {boolean} True if any image was stripped
 */
export function stripImagesFromGoogleRequest(googleRequest) {
    if (!googleRequest || !Array.isArray(googleRequest.contents)) return false;
    let strippedCount = 0;
    for (const content of googleRequest.contents) {
        if (!Array.isArray(content.parts)) continue;
        for (let i = 0; i < content.parts.length; i++) {
            const part = content.parts[i];
            if (part && part.inlineData && typeof part.inlineData.mimeType === 'string' && part.inlineData.mimeType.startsWith('image/')) {
                content.parts[i] = { text: '[Image removed: Google Cloud Code unable to process image]' };
                strippedCount++;
            }
        }
    }
    return strippedCount > 0;
}

/**
 * Convert Anthropic role to Google role
 * @param {string} role - Anthropic role ('user', 'assistant')
 * @returns {string} Google role ('user', 'model')
 */
export function convertRole(role) {
    if (role === 'assistant') return 'model';
    if (role === 'user') return 'user';
    return 'user'; // Default to user
}

/**
 * Convert Anthropic message content to Google Generative AI parts
 * @param {string|Array} content - Anthropic message content
 * @param {boolean} isClaudeModel - Whether the model is a Claude model
 * @param {boolean} isGeminiModel - Whether the model is a Gemini model
 * @returns {Array} Google Generative AI parts array
 */
export function convertContentToParts(content, isClaudeModel = false, isGeminiModel = false) {
    if (typeof content === 'string') {
        return [{ text: content }];
    }

    if (!Array.isArray(content)) {
        return [{ text: String(content) }];
    }

    const parts = [];
    const deferredInlineData = []; // Collect inlineData to add at the end (Issue #91)

    for (const block of content) {
        if (!block) continue;

        if (block.type === 'text') {
            // Skip empty text blocks - they cause API errors
            if (block.text && block.text.trim()) {
                const part = { text: block.text };
                if (isGeminiModel && block.thoughtSignature && block.thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
                    part.thoughtSignature = block.thoughtSignature;
                }
                parts.push(part);
            }
        } else if (block.type === 'image') {
            // Handle image content
            if (block.source?.type === 'base64') {
                const validated = validateAndSanitizeImage(block.source);
                if (validated.valid) {
                    parts.push({
                        inlineData: {
                            mimeType: validated.mimeType,
                            data: validated.data
                        }
                    });
                } else {
                    logger.warn(`[ContentConverter] Omitted corrupt/truncated image: ${validated.reason}`);
                    parts.push({
                        text: `[Image omitted: ${validated.reason}]`
                    });
                }
            } else if (block.source?.type === 'url') {
                // URL-referenced image
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'image/jpeg',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'document') {
            // Handle document content (e.g. PDF)
            if (block.source?.type === 'base64') {
                parts.push({
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                });
            } else if (block.source?.type === 'url') {
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'application/pdf',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'tool_use') {
            // Convert tool_use to functionCall (Google format)
            // For Claude models, include the id field
            const functionCall = {
                name: block.name,
                args: block.input || {}
            };

            if (isClaudeModel && block.id) {
                functionCall.id = block.id;
            }

            // Build the part with functionCall
            const part = { functionCall };

            // For Gemini models, include thoughtSignature at the part level
            // This is required by Gemini 3+ for tool calls to work correctly
            if (isGeminiModel) {
                // Priority: block.thoughtSignature > cache > GEMINI_SKIP_SIGNATURE
                let signature = block.thoughtSignature;

                if (!signature && block.id) {
                    signature = getCachedSignature(block.id);
                    if (signature) {
                        logger.debug(`[ContentConverter] Restored signature from cache for: ${block.id}`);
                    }
                }

                part.thoughtSignature = signature || GEMINI_SKIP_SIGNATURE;
            }

            parts.push(part);
        } else if (block.type === 'tool_result') {
            // Convert tool_result to functionResponse (Google format)
            let responseContent = block.content;
            let imageParts = [];

            if (typeof responseContent === 'string') {
                responseContent = { result: responseContent };
            } else if (Array.isArray(responseContent)) {
                // Extract images from tool results first (e.g., from Read tool reading image files)
                const omittedReasons = [];
                for (const item of responseContent) {
                    if (item.type === 'image' && item.source?.type === 'base64') {
                        const validated = validateAndSanitizeImage(item.source);
                        if (validated.valid) {
                            imageParts.push({
                                inlineData: {
                                    mimeType: validated.mimeType,
                                    data: validated.data
                                }
                            });
                        } else {
                            logger.warn(`[ContentConverter] Omitted corrupt/truncated image from tool_result: ${validated.reason}`);
                            omittedReasons.push(`[Image omitted: ${validated.reason}]`);
                        }
                    }
                }

                // Extract text content
                let texts = responseContent
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
                if (omittedReasons.length > 0) {
                    texts = (texts ? texts + '\n' : '') + omittedReasons.join('\n');
                }
                responseContent = { result: texts || (imageParts.length > 0 ? 'Image attached' : 'Empty result') };
            }

            const functionResponse = {
                name: block.tool_use_id || 'unknown',
                response: responseContent
            };

            // For Claude models, the id field must match the tool_use_id
            if (isClaudeModel && block.tool_use_id) {
                functionResponse.id = block.tool_use_id;
            }

            parts.push({ functionResponse });

            // Defer images from the tool result to end of parts array (Issue #91)
            // This ensures all functionResponse parts are consecutive
            deferredInlineData.push(...imageParts);
        } else if (block.type === 'thinking') {
            // Handle thinking blocks with signature compatibility check
            if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
                const signatureFamily = getCachedSignatureFamily(block.signature);
                const targetFamily = isClaudeModel ? 'claude' : isGeminiModel ? 'gemini' : null;

                // For Claude: drop unknown or non-Claude signatures.
                // This prevents resumed sessions from forwarding stale signatures that
                // fail upstream validation with "Invalid `signature` in `thinking` block".
                if (isClaudeModel && (!signatureFamily || signatureFamily !== 'claude')) {
                    logger.debug('[ContentConverter] Dropping untrusted thinking signature for Claude model');
                    continue;
                }

                // Drop blocks with incompatible signatures for Gemini (cross-model switch)
                if (isGeminiModel && signatureFamily && targetFamily && signatureFamily !== targetFamily) {
                    logger.debug(`[ContentConverter] Dropping incompatible ${signatureFamily} thinking for ${targetFamily} model`);
                    continue;
                }

                // Drop blocks with unknown signature origin for Gemini (cold cache - safe default)
                if (isGeminiModel && !signatureFamily && targetFamily) {
                    logger.debug(`[ContentConverter] Dropping thinking with unknown signature origin`);
                    continue;
                }

                // Compatible - convert to Gemini format with signature
                parts.push({
                    text: block.thinking,
                    thought: true,
                    thoughtSignature: block.signature
                });
            }
            // Unsigned thinking blocks are dropped (existing behavior)
        }
    }

    // Add deferred inlineData at the end (Issue #91)
    // This ensures functionResponse parts are consecutive, which Claude's API requires
    parts.push(...deferredInlineData);

    return parts;
}
