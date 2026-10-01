import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 运维脚本共用的路径解析。
 * 脚本位于 <projectRoot>/app/scripts，因此项目根目录是上两级，
 * 不依赖调用者的当前工作目录。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export const appDir = path.resolve(here, '..');
export const projectRoot = path.resolve(appDir, '..');

export function storageDir() {
  const override = process.env.LIUYAO_STORAGE_DIR;
  return override && override.trim() !== '' ? path.resolve(override.trim()) : path.join(projectRoot, 'storage');
}

export function databasePath() {
  return path.join(storageDir(), 'liuyao.db');
}

export function backupsDir() {
  return path.join(storageDir(), 'backups');
}

export function migrationsDir() {
  const override = process.env.LIUYAO_MIGRATIONS_DIR;
  return override && override.trim() !== '' ? path.resolve(override.trim()) : path.join(appDir, 'migrations');
}
