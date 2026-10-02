/**
 * HTTP Proxy Support
 * 
 * Configures global fetch to use HTTP proxy from environment variables.
 * Supports: http_proxy, HTTP_PROXY, https_proxy, HTTPS_PROXY
 * 
 * This module should be imported at the very beginning of the application
 * entry point (src/index.js) before any fetch calls are made.
 */

import { logger } from './logger.js';

/**
 * Initialize proxy support from environment variables
 * Call this once at application startup
 */
export async function initProxy() {
    const proxyUrl = process.env.http_proxy ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.HTTPS_PROXY;

    if (!proxyUrl) {
        return;
    }

    try {
        const { ProxyAgent, setGlobalDispatcher } = await import('undici');
        const proxyAgent = new ProxyAgent(proxyUrl);
        setGlobalDispatcher(proxyAgent);
        logger.info(`[Proxy] Using proxy: ${proxyUrl}`);
    } catch (error) {
        logger.error(`[Proxy] Failed to configure proxy: ${error.message}`);
    }
}

// Auto-initialize on import
initProxy();
