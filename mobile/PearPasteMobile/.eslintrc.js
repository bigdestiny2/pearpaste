module.exports = {
  root: true,
  extends: '@react-native',
  env: {
    es2021: true,
  },
  globals: {
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
  },
  ignorePatterns: [
    'android/',
    'ios/',
    'node_modules/',
    'vendor/',
  ],
};
