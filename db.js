import { config } from './config.js';
import { createFileRepository } from './storage/file-repository.js';
import { createPostgresRepository } from './storage/postgres-repository.js';

const repository = config.database.provider === 'postgres'
  ? createPostgresRepository(config.database.url)
  : createFileRepository(config.database.file);

export const getUser = (...args) => repository.getUser(...args);
export const createUser = (...args) => repository.createUser(...args);
export const getProgress = (...args) => repository.getProgress(...args);
export const saveProgress = (...args) => repository.saveProgress(...args);
export const mergeProgress = (...args) => repository.mergeProgress(...args);
export const getUserByTelegram = (...args) => repository.getUserByTelegram(...args);
export const createTelegramUser = (...args) => repository.createTelegramUser(...args);
export const ensureTelegramUser = (...args) => repository.ensureTelegramUser(...args);
export const grantDays = (...args) => repository.grantDays(...args);
export const markTrialUsed = (...args) => repository.markTrialUsed(...args);
export const getSub = (...args) => repository.getSub(...args);
export const createTelegramAuthCode = (...args) => repository.createTelegramAuthCode(...args);
export const confirmTelegramAuthCode = (...args) => repository.confirmTelegramAuthCode(...args);
export const consumeTelegramAuthCode = (...args) => repository.consumeTelegramAuthCode(...args);
export const createWritingAttempt = (...args) => repository.createWritingAttempt(...args);
export const finishWritingAttempt = (...args) => repository.finishWritingAttempt(...args);
export const logAiRequest = (...args) => repository.logAiRequest(...args);
export const exportUserData = (...args) => repository.exportUserData(...args);
export const deleteUserData = (...args) => repository.deleteUserData(...args);
export const healthCheck = (...args) => repository.healthCheck(...args);
export const closeDatabase = () => repository.close();
