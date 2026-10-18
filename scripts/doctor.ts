#!/usr/bin/env node
import { runDoctor } from "../src/doctor.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: npm run doctor -- [--speech]\nLocal JSON preflight. --speech also synthesizes a short temporary WAV and deletes it.\nDoes not sign in, submit, or download models. Explicit Edge TTS may contact its configured upstream.");
} else if (args.some((arg) => arg !== "--speech")) {
  console.log(JSON.stringify({ status: "error", code: "INVALID_ARGUMENT", message: "Usage: doctor [--speech]" }));
  process.exitCode = 2;
} else {
  runDoctor({ speechProbe: args.includes("--speech") }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (result.isError) process.exitCode = 1;
  }).catch((error) => {
    console.log(JSON.stringify({ status: "error", code: "PREFLIGHT_FAILED", message: (error as Error).message }));
    process.exitCode = 1;
  });
}
