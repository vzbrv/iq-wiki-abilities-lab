import { getFreeModelCandidates } from '../lib/foundation.js';
import { getVideoConfig } from '../lib/video/config.js';
import { createVideoService } from '../lib/video/service.js';

const models = getFreeModelCandidates(
  process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL || 'openrouter/free'
);
const config = getVideoConfig();
createVideoService(config);

console.log(`OpenRouter models: ${models.length} free-only`);
console.log(`Video engine: ${config.enabled ? `${config.provider}/${config.model}` : 'disabled (expected until provider selection)'}`);
