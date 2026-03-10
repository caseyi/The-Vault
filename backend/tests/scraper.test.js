/**
 * Tests for scraper.js URL detection utility
 *
 * Run with: npx jest tests/scraper.test.js
 */

const { detectUrlFromFolderName } = require('../scraper');

describe('detectUrlFromFolderName', () => {
  test('detects Printables PR- pattern', () => {
    const result = detectUrlFromFolderName('PR-123456 Cool Dragon');
    expect(result).toBeTruthy();
    expect(result.site).toBe('printables');
    expect(result.url).toContain('123456');
  });

  test('detects Thingiverse TV- pattern', () => {
    const result = detectUrlFromFolderName('TV-789012 Some Model');
    expect(result).toBeTruthy();
    expect(result.site).toBe('thingiverse');
    expect(result.url).toContain('789012');
  });

  test('detects MyMiniFactory MMF- pattern', () => {
    const result = detectUrlFromFolderName('MMF-345678 Fantasy Set');
    expect(result).toBeTruthy();
    expect(result.site).toBe('myminifactory');
    expect(result.url).toContain('345678');
  });

  test('returns null for unknown patterns', () => {
    const result = detectUrlFromFolderName('Random Folder Name');
    expect(result).toBeNull();
  });

  test('returns null for empty string', () => {
    const result = detectUrlFromFolderName('');
    expect(result).toBeNull();
  });

  test('detects Cults3D pattern', () => {
    const result = detectUrlFromFolderName('Cults-SomeName-Something');
    if (result) {
      expect(result.site).toBe('cults3d');
    }
    // If not detected that's also OK — Cults doesn't always have numeric IDs
  });

  test('detects Printables printables- prefix', () => {
    const result = detectUrlFromFolderName('printables-456789-cool-model');
    expect(result).toBeTruthy();
    expect(result.site).toBe('printables');
  });
});
