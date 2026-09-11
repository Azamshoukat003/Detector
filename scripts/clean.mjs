// ESM so it runs under either module system — `require` would break the moment
// package.json declares "type": "module".
import { rmSync } from "node:fs";

rmSync(process.env.NEXT_DIST_DIR || ".next", { recursive: true, force: true });
