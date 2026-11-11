import { defineConfig } from "hardhat/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  solidity: {
    version: "0.8.28",
    // The official solc 0.8.28 from npm (wasm), so builds work without the compiler download site.
    path: fileURLToPath(new URL("./node_modules/solc/soljson.js", import.meta.url)),
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "src", tests: { solidity: "test" } },
  test: { solidity: { fuzz: { runs: 2000 } } },
});
