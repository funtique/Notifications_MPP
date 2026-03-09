import { runRssTests } from "./rss.spec.js";
import { runProcessorTests } from "./processor.spec.js";

const tests = [
  ["RSS parsing", runRssTests],
  ["Worker processor", runProcessorTests]
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All tests passed");
}