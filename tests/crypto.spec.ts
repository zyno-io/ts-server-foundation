import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AlphanumericCharacters, createApp, Crypto, NumericCharacters, randomBytes, randomBytesSync, randomString, randomStringSync } from '../src';

describe('crypto helpers', () => {
    it('generates random bytes and strings', async () => {
        const bytes = await randomBytes(12);
        const hex = await randomBytes(12, true);
        const syncBytes = randomBytesSync(12);
        const syncHex = randomBytesSync(12, true);
        const numeric = await randomString(20, NumericCharacters);
        const alpha = randomStringSync(20, AlphanumericCharacters);

        assert.equal(bytes.length, 12);
        assert.equal(hex.length, 24);
        assert.equal(syncBytes.length, 12);
        assert.equal(syncHex.length, 24);
        assert.match(numeric, /^[0-9]{20}$/);
        assert.match(alpha, /^[a-zA-Z0-9]{20}$/);
    });

    it('uses fixed-length alphanumeric strings by default', async () => {
        const generated = await randomString(32);
        const syncGenerated = randomStringSync(32);

        assert.equal(generated.length, 32);
        assert.equal(syncGenerated.length, 32);
        assert.match(generated, /^[a-zA-Z0-9]{32}$/);
        assert.match(syncGenerated, /^[a-zA-Z0-9]{32}$/);
    });

    it('encrypts and decrypts strings and buffers', () => {
        process.env.APP_ENV = 'test';
        Crypto.reset();
        createApp({
            defaultConfig: {
                CRYPTO_SECRET: '12345678901234567890123456789012',
                CRYPTO_IV_LENGTH: 12
            }
        });

        const encryptedText = Crypto.encrypt('secret');
        const decryptedText = Crypto.decrypt(encryptedText);
        const encryptedBuffer = Crypto.encrypt(Buffer.from('buffer secret'));
        const decryptedBuffer = Crypto.decrypt(encryptedBuffer);

        assert.notEqual(encryptedText, 'secret');
        assert.equal(decryptedText, 'secret');
        assert.ok(Buffer.isBuffer(encryptedBuffer));
        assert.equal(decryptedBuffer.toString(), 'buffer secret');
    });

    it('rejects unsafe AES-GCM iv lengths and malformed payloads', () => {
        process.env.APP_ENV = 'test';
        Crypto.reset();
        createApp({
            defaultConfig: {
                CRYPTO_SECRET: '12345678901234567890123456789012',
                CRYPTO_IV_LENGTH: 12
            }
        });

        assert.throws(() => new Crypto({ secret: '12345678901234567890123456789012', ivLength: 8 }), /CRYPTO_IV_LENGTH/);
        assert.throws(() => Crypto.decrypt('not base64!'), /Invalid encrypted payload/);
        assert.throws(() => Crypto.decrypt(Buffer.alloc(8)), /Invalid encrypted payload/);
    });
});
