#!/usr/bin/env node
/** npx tsx scripts/doctor.ts → one JSON object; exit 1 when a check fails. No secrets, no network. */
import { doctorReport } from "../src/doctor.js";

const report = doctorReport();
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
