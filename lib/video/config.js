import { AppError } from '../foundation.js';

function list(value, fallback = '') {
  return (value || fallback).split(',').map((item) => item.trim()).filter(Boolean);
}

function money(value, name) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError(503, 'VIDEO_CONFIGURATION_ERROR', `${name} must be a non-negative number.`);
  }
  return amount;
}

export function getVideoConfig(env = process.env) {
  if (env.VIDEO_ENGINE_ENABLED !== 'true') {
    return { enabled: false, status: 'not_configured', provider: null, model: null };
  }

  const provider = String(env.VIDEO_PROVIDER || '').trim();
  const model = String(env.VIDEO_MODEL || '').trim();
  if (!provider || !model) {
    throw new AppError(503, 'VIDEO_CONFIGURATION_ERROR', 'Video provider and model must be configured.');
  }
  if (!list(env.VIDEO_PROVIDER_ALLOWLIST, 'mock').includes(provider)) {
    throw new AppError(503, 'VIDEO_PROVIDER_BLOCKED', 'The configured video provider is not allowlisted.');
  }
  if (!list(env.VIDEO_MODEL_ALLOWLIST).includes(model)) {
    throw new AppError(503, 'VIDEO_MODEL_BLOCKED', 'The configured video model is not allowlisted.');
  }

  const maxJobUsd = money(env.VIDEO_MAX_JOB_USD || '0', 'VIDEO_MAX_JOB_USD');
  const dailyCapUsd = money(env.VIDEO_DAILY_CAP_USD || '0', 'VIDEO_DAILY_CAP_USD');
  if (maxJobUsd > dailyCapUsd) {
    throw new AppError(503, 'VIDEO_CONFIGURATION_ERROR', 'Per-job cost cannot exceed the daily cap.');
  }
  if (provider !== 'mock' && (maxJobUsd <= 0 || dailyCapUsd <= 0)) {
    throw new AppError(
      503,
      'VIDEO_CONFIGURATION_ERROR',
      'Paid video providers require positive per-job and daily spending caps.'
    );
  }

  if (provider === 'mock') {
    if (env.NODE_ENV === 'production') {
      throw new AppError(503, 'VIDEO_MOCK_FORBIDDEN', 'The mock video provider cannot run in production.');
    }
    if (env.VIDEO_MOCK_ENABLED !== 'true') {
      throw new AppError(503, 'VIDEO_MOCK_DISABLED', 'Local mock video generation is not enabled.');
    }
  } else if (env.NODE_ENV === 'production') {
    throw new AppError(
      503,
      'VIDEO_DURABLE_STATE_REQUIRED',
      'Production video generation requires durable job and spending state.'
    );
  } else if (!env.VIDEO_API_KEY) {
    throw new AppError(503, 'VIDEO_CREDENTIAL_MISSING', 'The video provider credential is missing.');
  }

  return {
    enabled: true,
    status: 'ready',
    provider,
    model,
    maxJobUsd,
    dailyCapUsd,
    credential: env.VIDEO_API_KEY || null
  };
}

export function publicVideoConfig(config) {
  return {
    enabled: config.enabled,
    status: config.status,
    provider: config.provider,
    model: config.model,
    actions: config.enabled ? ['generate', 'poll', 'retry', 'cancel', 'playback'] : []
  };
}
