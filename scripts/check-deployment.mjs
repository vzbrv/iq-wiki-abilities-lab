import { getFreeModelCandidates } from '../lib/foundation.js';
import { getVideoConfig } from '../lib/video/config.js';
import { createVideoLibraryStore } from '../lib/video/library.js';
import { createVideoService } from '../lib/video/service.js';

const models = getFreeModelCandidates(
  process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL || 'openrouter/free'
);
const config = getVideoConfig();
createVideoService(config);
createVideoLibraryStore(process.env);

const libraryUrl = process.env.VIDEO_LIBRARY_REST_URL;
const libraryToken = process.env.VIDEO_LIBRARY_REST_TOKEN;
const librarySyncToken = process.env.VIDEO_LIBRARY_SYNC_TOKEN;
if (Boolean(libraryUrl) !== Boolean(libraryToken)) {
  throw new Error('VIDEO_LIBRARY_REST_URL and VIDEO_LIBRARY_REST_TOKEN must be configured together.');
}
if (libraryUrl && !librarySyncToken) {
  throw new Error('VIDEO_LIBRARY_SYNC_TOKEN is required when the production video library is configured.');
}

console.log(`OpenRouter models: ${models.length} free-only`);
console.log(`Video engine: ${config.enabled ? `${config.provider}/${config.model}` : 'disabled (expected until provider selection)'}`);
console.log(`Video library: ${libraryUrl ? 'configured' : 'not configured (plan-only mode; stored playback unavailable)'}`);
