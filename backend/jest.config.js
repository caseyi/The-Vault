/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Set env vars so scanner.js doesn't try to create /data/images
  globals: {},
  setupFiles: ['./tests/setup.js'],
};
