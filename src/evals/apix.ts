export * from "./apix/index"
import { runAPIxEvalCli } from "./apix/index"

if (import.meta.main) await runAPIxEvalCli()
