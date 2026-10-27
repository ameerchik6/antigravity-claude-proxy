const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           IMAGE SANITIZER & VALIDATOR TEST SUITE             ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        validateAndSanitizeImage,
        convertContentToParts,
        isInvalidMediaError,
        stripImagesFromGoogleRequest
    } = await import('../src/format/content-converter.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    // 1. Truncated PNG from the user's log
    const brokenPngB64 = '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';

    // 2. Valid minimal PNG: 1x1 transparent pixel
    const validPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    test('Rejects truncated PNG with truncated IDAT chunk', () => {
        const res = validateAndSanitizeImage({ media_type: 'image/png', data: brokenPngB64 });
        assert.strictEqual(res.valid, false);
        assert.ok(res.reason.includes('Truncated PNG'));
    });

    test('Rejects PNG missing IEND chunk completely', () => {
        // Strip IEND (last 12 bytes) from a valid PNG
        const validBuf = Buffer.from(validPngB64, 'base64');
        const noIendB64 = validBuf.subarray(0, validBuf.length - 12).toString('base64');
        const res = validateAndSanitizeImage({ media_type: 'image/png', data: noIendB64 });
        assert.strictEqual(res.valid, false);
        assert.ok(res.reason.includes('missing IEND chunk'));
    });

    test('Rejects truncated PNG with internal chunk overflow even if IEND is present at tail', () => {
        // Synthetic PNG: 8-byte header + 25-byte IHDR + IDAT claiming 10000 bytes with only 10 bytes + IEND (12 bytes)
        const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        const ihdr = Buffer.from([
            0x00, 0x00, 0x00, 0x0D, // len 13
            0x49, 0x48, 0x44, 0x52, // IHDR
            0x00, 0x00, 0x00, 0x01, // w=1
            0x00, 0x00, 0x00, 0x01, // h=1
            0x08, 0x06, 0x00, 0x00, 0x00, // 8-bit RGBA
            0x1F, 0x15, 0xC4, 0x89 // CRC
        ]);
        const fakeIdat = Buffer.from([
            0x00, 0x00, 0x27, 0x10, // len 10000 (0x2710)
            0x49, 0x44, 0x41, 0x54, // IDAT
            0x78, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01 // only 10 bytes instead of 10000+4
        ]);
        const iend = Buffer.from([
            0x00, 0x00, 0x00, 0x00,
            0x49, 0x45, 0x4E, 0x44,
            0xAE, 0x42, 0x60, 0x82
        ]);
        const corruptBuf = Buffer.concat([header, ihdr, fakeIdat, iend]);
        const res = validateAndSanitizeImage({ media_type: 'image/png', data: corruptBuf.toString('base64') });
        assert.strictEqual(res.valid, false);
        assert.ok(res.reason.includes('Truncated PNG'));
        assert.ok(res.reason.includes('IDAT'));
    });

    // 2. Valid minimal PNG: 1x1 transparent pixel
    test('Accepts valid PNG with complete IEND', () => {
        const res = validateAndSanitizeImage({ media_type: 'image/png', data: validPngB64 });
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.mimeType, 'image/png');
    });

    // 3. Valid JPEG from test suite
    const testJpegPath = path.join(__dirname, 'utils', 'test_image.jpeg');
    const validJpegB64 = fs.readFileSync(testJpegPath).toString('base64');

    test('Accepts valid JPEG with complete EOI (FF D9)', () => {
        const res = validateAndSanitizeImage({ media_type: 'image/jpeg', data: validJpegB64 });
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.mimeType, 'image/jpeg');
    });

    // 4. Truncated JPEG (chopped off)
    test('Rejects truncated JPEG missing EOI', () => {
        const choppedJpeg = validJpegB64.slice(0, 500);
        const res = validateAndSanitizeImage({ media_type: 'image/jpeg', data: choppedJpeg });
        assert.strictEqual(res.valid, false);
        assert.ok(res.reason.includes('EOI'));
    });

    // 5. Normalizes image/jpg to image/jpeg and strips data URL prefix
    test('Strips data URL prefix and normalizes image/jpg', () => {
        const dataUrl = `data:image/jpg;base64,${validJpegB64}`;
        const res = validateAndSanitizeImage({ media_type: 'image/jpg', data: dataUrl });
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.mimeType, 'image/jpeg');
        assert.strictEqual(res.data.startsWith('data:'), false);
    });

    // 6. convertContentToParts with broken user image emits fallback text
    test('convertContentToParts replaces broken user image with omitted notice', () => {
        const parts = convertContentToParts([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: brokenPngB64 } },
            { type: 'text', text: 'Analyze this image' }
        ]);
        assert.strictEqual(parts.length, 2);
        assert.ok(parts[0].text.includes('Image omitted'));
        assert.strictEqual(parts[1].text, 'Analyze this image');
    });

    // 7. convertContentToParts with broken tool_result image (e.g. from Read tool) omits inlineData
    test('convertContentToParts omits broken tool_result image without breaking response', () => {
        const parts = convertContentToParts([
            {
                type: 'tool_result',
                tool_use_id: 'tool_123',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: brokenPngB64 } }
                ]
            }
        ]);
        assert.strictEqual(parts.length, 1);
        assert.ok(parts[0].functionResponse);
        assert.strictEqual(parts[0].functionResponse.name, 'tool_123');
        assert.ok(parts[0].functionResponse.response.result.includes('Image omitted'));
    });

    // 8. Rejects unsupported / unknown formats without blind fallback to valid
    test('Rejects unknown/corrupt formats without blind fallback', () => {
        const randomB64 = Buffer.from('this is not an image at all, just plain ascii text').toString('base64');
        const res = validateAndSanitizeImage({ media_type: 'image/unknown', data: randomB64 });
        assert.strictEqual(res.valid, false);
        assert.ok(res.reason.includes('Unsupported or corrupt'));
    });

    // 9. Rejects GIF format (unsupported by Cloud Code inlineData)
    test('Rejects GIF format with clear reason', () => {
        const gifB64 = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'binary').toString('base64');
        const res = validateAndSanitizeImage({ media_type: 'image/gif', data: gifB64 });
        assert.strictEqual(res.valid, false);
        assert.ok(res.reason.includes('GIF'));
    });

    // 10. isInvalidMediaError identifies error 2011 and INVALID_MEDIA
    test('isInvalidMediaError identifies error 2011 correctly', () => {
        const errJson = JSON.stringify({
            error: {
                code: 400,
                message: "Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting",
                status: "INVALID_ARGUMENT",
                details: [{
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    "reason": "INVALID_MEDIA",
                    "metadata": { "error_number": "2011" }
                }]
            }
        });
        assert.strictEqual(isInvalidMediaError(errJson), true);
        assert.strictEqual(isInvalidMediaError('Some random 400 error: invalid JSON schema'), false);
    });

    // 11. stripImagesFromGoogleRequest strips images from request parts
    test('stripImagesFromGoogleRequest strips images and replaces with placeholder', () => {
        const request = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: 'Look at this' },
                        { inlineData: { mimeType: 'image/png', data: validPngB64 } }
                    ]
                },
                {
                    role: 'model',
                    parts: [
                        { text: 'I see it' }
                    ]
                }
            ]
        };
        const stripped = stripImagesFromGoogleRequest(request);
        assert.strictEqual(stripped, true);
        assert.strictEqual(request.contents[0].parts.length, 2);
        assert.strictEqual(request.contents[0].parts[0].text, 'Look at this');
        assert.ok(request.contents[0].parts[1].text.includes('Image removed: Google Cloud Code unable to process image'));
        assert.strictEqual(request.contents[0].parts[1].inlineData, undefined);

        // Second call when no images remain returns false
        assert.strictEqual(stripImagesFromGoogleRequest(request), false);
    });

    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
