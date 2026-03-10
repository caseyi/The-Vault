import '@testing-library/jest-dom';

// Mock global fetch
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  })
);

// Mock IntersectionObserver (used by lazy-loading images)
global.IntersectionObserver = class {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Suppress console errors from component renders during tests
const originalError = console.error;
beforeAll(() => {
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('act(...)')) return;
    originalError.call(console, ...args);
  };
});
afterAll(() => { console.error = originalError; });
