import { initSchema } from '../../core/db';
import { buildAssistantIndex } from './assistantService';

/** `npm run rag:build`: retrain word vectors and rewrite the assistant index. */
initSchema();
const result = buildAssistantIndex();
// eslint-disable-next-line no-console
console.log(
  `Help assistant index built: ${result.features} features, ${result.chunks} chunks, ` +
    `${result.vocabulary}-word vocabulary in ${result.ms} ms.`
);
