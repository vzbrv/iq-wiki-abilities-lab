import { assertFreeModel } from '../lib/foundation.js';
import { getVideoConfig } from '../lib/video/config.js';
import { createVideoService } from '../lib/video/service.js';

assertFreeModel(process.env.OPENROUTER_MODEL || 'openrouter/free');
const config = getVideoConfig();
createVideoService(config);

console.log(`OpenRouter model: free-only`);
console.log(`Video engine: ${config.enabled ? `${config.provider}/${config.model}` : 'disabled (expected until provider selection)'}`);
