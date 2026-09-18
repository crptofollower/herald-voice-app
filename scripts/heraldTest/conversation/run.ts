import { runStage1ConversationRunner } from './runner.ts';

const result = await runStage1ConversationRunner();
process.exit(result.failed ? 1 : 0);
