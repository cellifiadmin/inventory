module.exports = {
  ...require("./jest.config.js"),
  testMatch: ["<rootDir>/test/runtime/**/*.test.ts"],
  setupFiles: ["<rootDir>/test/helpers/purchaseTestEnvironment.cjs"],
  coverageDirectory: "<rootDir>/coverage/purchase-runtime",
};
