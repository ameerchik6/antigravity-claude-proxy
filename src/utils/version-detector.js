import { execSync } from 'child_process';
import { platform, homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { config } from '../config.js';

/**
 * Intelligent Version Detection for Antigravity
 *
 * Detects versions from the local Antigravity installation's product.json.
 * Two version values are tracked:
 *   - "version" field      → X-Client-Version header (API version gate)
 *   - "ideVersion" field   → User-Agent version string
 *
 * Detection priority (for each):
 *   1. Environment variable override
 *   2. config.json (antigravityClientVersion / antigravityIdeVersion)
 *   3. product.json from local Antigravity app
 *   4. OS-specific detection (macOS plist / Windows exe / Linux package managers)
 *   5. Hardcoded fallback
 *
 * The Cloud Code backend gates newer models (e.g. gemini-4-argon-*) on the
 * User-Agent: it must use the Antigravity Hub format ("antigravity/hub/<version>")
 * with a recent enough version, so an outdated fallback can hide models that the
 * real Antigravity client lists.
 */

// Fallback for User-Agent version (ideVersion in product.json), used only when
// no installed Antigravity version is detected
const FALLBACK_USER_AGENT_VERSION = process.env.FALLBACK_ANTIGRAVITY_VERSION || '2.25.0';

// Detected versions must be above this to be used (older installs are ignored)
const MIN_DETECTED_USER_AGENT_VERSION = '2.0.3';

// Fallback for X-Client-Version (top-level "version" in product.json)
// Can be overridden via ANTIGRAVITY_CLIENT_VERSION_FALLBACK env var
const FALLBACK_CLIENT_VERSION = process.env.ANTIGRAVITY_CLIENT_VERSION_FALLBACK || '1.110.0';

// Cache TTL: 1 hour — avoids stale versions for the entire process lifetime
const CACHE_TTL_MS = 60 * 60 * 1000;

let cachedUserAgent = null;
let cachedUserAgentAt = 0;
let cachedClientVersion = null;
let cachedClientVersionAt = 0;
let cachedProductJson = undefined; // undefined = not yet attempted
let cachedProductJsonAt = 0;
let loggedVersionInfo = false;

/**
 * Validates that a string looks like a semver version (X.Y.Z with optional extras).
 * @param {string} str - The string to validate
 * @returns {boolean} True if it matches a version pattern
 */
function isValidVersionString(str) {
    return typeof str === 'string' && /^\d+\.\d+(\.\d+)?/.test(str);
}

/**
 * Compares two semver-ish version strings (X.Y.Z).
 * @returns {boolean} True if v1 > v2
 */
function isVersionHigher(v1, v2) {
    if (!isValidVersionString(v1) || !isValidVersionString(v2)) return false;

    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return true;
        if (p1 < p2) return false;
    }
    return false;
}

/**
 * Compares two semver-ish version strings (X.Y.Z).
 * @returns {boolean} True if v1 >= v2
 */
function isVersionHigherOrEqual(v1, v2) {
    if (!isValidVersionString(v1) || !isValidVersionString(v2)) return false;

    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return true;
        if (p1 < p2) return false;
    }
    return true; // Equal versions return true (>= comparison)
}

/**
 * Check if a cache entry has expired.
 * @param {number} cachedAt - Timestamp when the value was cached
 * @returns {boolean} True if the cache entry has expired or was never set
 */
function isCacheExpired(cachedAt) {
    return !cachedAt || (Date.now() - cachedAt) > CACHE_TTL_MS;
}

/**
 * Returns platform-specific search paths for product.json.
 */
function getProductJsonPaths() {
    const os = platform();
    const paths = [];

    if (os === 'darwin') {
        paths.push('/Applications/Antigravity.app/Contents/Resources/app/product.json');
        paths.push(join(homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'product.json'));
    } else if (os === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        if (localAppData) {
            paths.push(join(localAppData, 'Programs', 'Antigravity', 'resources', 'app', 'product.json'));
        }
        paths.push(join(programFiles, 'Antigravity', 'resources', 'app', 'product.json'));
    } else {
        paths.push('/usr/share/antigravity/resources/app/product.json');
        paths.push('/opt/antigravity/resources/app/product.json');
        paths.push('/opt/Antigravity/resources/app/product.json');
        paths.push(join(homedir(), '.local', 'share', 'antigravity', 'resources', 'app', 'product.json'));
        paths.push('/snap/antigravity/current/resources/app/product.json');
    }

    return paths;
}

/**
 * Find and parse product.json from the local Antigravity installation.
 * Caches the result after first attempt with TTL expiration.
 * @returns {Object|null} Parsed product.json or null
 */
function getProductJson() {
    if (cachedProductJson !== undefined && !isCacheExpired(cachedProductJsonAt)) {
        return cachedProductJson;
    }

    for (const p of getProductJsonPaths()) {
        try {
            if (existsSync(p)) {
                const content = JSON.parse(readFileSync(p, 'utf8'));
                if (content && (content.version || content.ideVersion)) {
                    cachedProductJson = content;
                    cachedProductJsonAt = Date.now();
                    return content;
                }
            }
        } catch (e) {
            // Continue to next path
        }
    }

    cachedProductJson = null;
    cachedProductJsonAt = Date.now();
    return null;
}

/**
 * Log version detection results once at startup (lazy import to avoid circular deps).
 */
function logVersionInfo(version, source) {
    if (loggedVersionInfo) return;
    loggedVersionInfo = true;

    import('./logger.js').then(({ logger }) => {
        if (source === 'fallback') {
            logger.warn(`X-Client-Version: using hardcoded fallback ${version} — product.json not found. Newer models may be hidden by the backend. Set "antigravityClientVersion" in config.json or the ANTIGRAVITY_CLIENT_VERSION env var to your Antigravity version.`);
        } else {
            logger.debug(`X-Client-Version: ${version} (source: ${source})`);
        }
    }).catch((err) => {
        // Last resort: stderr so version detection issues are at least visible somewhere
        if (source === 'fallback') {
            process.stderr.write(`[version-detector] X-Client-Version: fallback ${version} (logger unavailable: ${err.message})\n`);
        }
    });
}

/**
 * Resolve the X-Client-Version from its candidate sources (pure, for testing).
 * Priority: env var > config.json > product.json "version" > hardcoded fallback
 * @param {{envVersion?: string, configVersion?: string, productVersion?: string}} sources
 * @returns {{version: string, source: 'env'|'config'|'product.json'|'fallback'}}
 */
export function resolveClientVersion({ envVersion, configVersion, productVersion } = {}) {
    if (envVersion) return { version: envVersion, source: 'env' };
    if (configVersion) return { version: String(configVersion), source: 'config' };
    if (productVersion) return { version: productVersion, source: 'product.json' };
    return { version: FALLBACK_CLIENT_VERSION, source: 'fallback' };
}

/**
 * Get the X-Client-Version value for API requests.
 * Priority: ANTIGRAVITY_CLIENT_VERSION env var > config.json "antigravityClientVersion"
 *           > product.json "version" > hardcoded fallback
 * @returns {string} Version string (e.g. "1.110.0")
 */
export function getClientVersion() {
    if (cachedClientVersion && !isCacheExpired(cachedClientVersionAt)) {
        return cachedClientVersion;
    }

    const { version, source } = resolveClientVersion({
        envVersion: process.env.ANTIGRAVITY_CLIENT_VERSION,
        configVersion: config?.antigravityClientVersion,
        productVersion: getProductJson()?.version
    });
    cachedClientVersion = version;
    cachedClientVersionAt = Date.now();
    logVersionInfo(cachedClientVersion, source);
    return cachedClientVersion;
}

/**
 * Get the User-Agent version string.
 * Priority: FALLBACK_ANTIGRAVITY_VERSION env var > config.json "antigravityIdeVersion"
 *           > product.json "ideVersion" > OS detection > fallback
 * @returns {{ version: string, source: string }}
 */
function getUserAgentVersionConfig() {
    if (process.env.FALLBACK_ANTIGRAVITY_VERSION) {
        return { version: process.env.FALLBACK_ANTIGRAVITY_VERSION, source: 'env' };
    }

    if (config?.antigravityIdeVersion) {
        return { version: String(config.antigravityIdeVersion), source: 'config' };
    }

    const fromProduct = resolveUserAgentVersion({ productVersion: getProductJson()?.ideVersion });
    if (fromProduct.source !== 'fallback') return fromProduct;

    // OS-specific detection (legacy — reads app binary metadata directly)
    const os = platform();
    let localVersion = null;
    try {
        if (os === 'darwin') {
            localVersion = getVersionMacos();
        } else if (os === 'win32') {
            localVersion = getVersionWindows();
        } else {
            localVersion = getVersionLinux();
        }
    } catch (error) {
        // Silently fail and use fallback
    }

    return resolveUserAgentVersion({ localVersion });
}

/**
 * Resolve the User-Agent version from detected installs (pure, for testing).
 * A detected version is used as-is; the fallback applies only when nothing
 * usable was detected.
 * @param {{productVersion?: string, localVersion?: string}} detected
 * @returns {{version: string, source: 'product.json'|'local'|'fallback'}}
 */
export function resolveUserAgentVersion({ productVersion, localVersion } = {}) {
    if (productVersion && isVersionHigher(productVersion, MIN_DETECTED_USER_AGENT_VERSION)) {
        return { version: productVersion, source: 'product.json' };
    }
    if (localVersion && isVersionHigher(localVersion, MIN_DETECTED_USER_AGENT_VERSION)) {
        return { version: localVersion, source: 'local' };
    }
    return { version: FALLBACK_USER_AGENT_VERSION, source: 'fallback' };
}

/**
 * Generate a simplified User-Agent string used by the Antigravity binary.
 * Format: "antigravity/hub/version os/arch" (Antigravity 2.x Hub family; the
 * backend hides newer models such as gemini-4-argon-* from the legacy
 * "antigravity/version os/arch" format)
 * @returns {string} The User-Agent string
 */
export function generateSmartUserAgent() {
    if (cachedUserAgent && !isCacheExpired(cachedUserAgentAt)) {
        return cachedUserAgent;
    }

    const { version } = getUserAgentVersionConfig();
    const os = platform();
    const architecture = process.arch;

    const osName = os === 'darwin' ? 'darwin' : (os === 'win32' ? 'win32' : 'linux');

    cachedUserAgent = `antigravity/hub/${version} ${osName}/${architecture}`;
    cachedUserAgentAt = Date.now();
    return cachedUserAgent;
}

/**
 * Clear all cached version data. Useful for testing and when the
 * Antigravity installation is updated while the proxy is running.
 */
export function clearVersionCache() {
    cachedUserAgent = null;
    cachedUserAgentAt = 0;
    cachedClientVersion = null;
    cachedClientVersionAt = 0;
    cachedProductJson = undefined;
    cachedProductJsonAt = 0;
    loggedVersionInfo = false;
}

/**
 * MacOS-specific version detection using plutil.
 * Checks both /Applications and ~/Applications.
 */
function getVersionMacos() {
    const appPaths = [
        '/Applications/Antigravity.app',
        join(homedir(), 'Applications', 'Antigravity.app')
    ];

    for (const appPath of appPaths) {
        const plistPath = join(appPath, 'Contents/Info.plist');

        if (!existsSync(plistPath)) continue;

        try {
            const version = execSync(`plutil -extract CFBundleShortVersionString raw "${plistPath}"`, {
                encoding: 'utf8',
                timeout: 5000 // 5s timeout to prevent hanging
            }).trim();
            if (/^\d+\.\d+\.\d+/.test(version)) {
                return version;
            }
        } catch (e) {
            // plutil failed or file not found, try next path
        }
    }
    return null;
}

/**
 * Windows-specific version detection using PowerShell
 */
function getVersionWindows() {
    try {
        const localAppData = process.env.LOCALAPPDATA;
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

        const possiblePaths = [
            join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
            join(programFiles, 'Antigravity', 'Antigravity.exe')
        ];

        for (const exePath of possiblePaths) {
            if (existsSync(exePath)) {
                const cmd = `powershell -Command "(Get-Item '${exePath}').VersionInfo.FileVersion"`;
                const version = execSync(cmd, {
                    encoding: 'utf8',
                    timeout: 10000 // 10s timeout for PowerShell startup
                }).trim();
                const match = version.match(/^(\d+\.\d+\.\d+)/);
                if (match) return match[1];
            }
        }
    } catch (e) {
        // PowerShell or path issues
    }
    return null;
}

/**
 * Linux-specific version detection using package managers.
 * Tries dpkg (Debian/Ubuntu), rpm (Fedora/RHEL), and snap in order.
 */
function getVersionLinux() {
    const detectors = [
        // dpkg (Debian/Ubuntu .deb packages)
        {
            cmd: 'dpkg-query -W -f="${Version}" antigravity 2>/dev/null',
            parse: (output) => {
                const match = output.trim().match(/^(\d+\.\d+\.\d+)/);
                return match ? match[1] : null;
            }
        },
        // rpm (Fedora/RHEL/openSUSE)
        {
            cmd: 'rpm -q --queryformat "%{VERSION}" antigravity 2>/dev/null',
            parse: (output) => {
                const match = output.trim().match(/^(\d+\.\d+\.\d+)/);
                return match ? match[1] : null;
            }
        },
        // snap
        {
            cmd: 'snap info antigravity 2>/dev/null | grep "installed:"',
            parse: (output) => {
                const match = output.match(/installed:\s+(\d+\.\d+\.\d+)/);
                return match ? match[1] : null;
            }
        }
    ];

    for (const { cmd, parse } of detectors) {
        try {
            const output = execSync(cmd, {
                encoding: 'utf8',
                timeout: 5000 // 5s timeout
            });
            const version = parse(output);
            if (version) return version;
        } catch (e) {
            // Package manager not installed or package not found, try next
        }
    }
    return null;
}
