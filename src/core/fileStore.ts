import fs from 'fs';
import path from 'path';
import { randomToken } from './crypto';

/**
 * Local-disk file storage (no S3). Files are written under a gitignored
 * `uploads/` directory with randomized stored names so the original filename is
 * never trusted for the path. Metadata lives in the `attachments` table via the
 * entity store; this module only owns bytes on disk.
 */

export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

// Whitelist of accepted content types for the demo (images + PDFs + plain text).
export const ALLOWED_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
]);

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

function ensureDir(): void {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileValidationError';
  }
}

/** Validate a candidate upload before persisting. Throws FileValidationError. */
export function validateUpload(mime: string, size: number): void {
  if (!ALLOWED_MIME.has(mime)) {
    throw new FileValidationError(
      'That file type is not allowed. Please upload an image, PDF, or text file.'
    );
  }
  if (size <= 0) {
    throw new FileValidationError('The uploaded file is empty.');
  }
  if (size > MAX_FILE_BYTES) {
    throw new FileValidationError('That file is too large (max 5 MB).');
  }
}

/** Persist bytes to disk and return the randomized stored filename. */
export function saveBytes(buffer: Buffer, mime: string): string {
  ensureDir();
  const ext = EXT_BY_MIME[mime] ?? '';
  const storedName = `${randomToken(16)}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);
  return storedName;
}

/** Absolute path for a stored file, guarded against path traversal. */
export function resolveStored(storedName: string): string {
  const safe = path.basename(storedName); // strip any directory components
  const full = path.join(UPLOAD_DIR, safe);
  if (!full.startsWith(UPLOAD_DIR)) {
    throw new FileValidationError('Invalid file reference.');
  }
  return full;
}

export function readStored(storedName: string): Buffer {
  return fs.readFileSync(resolveStored(storedName));
}

export function storedExists(storedName: string): boolean {
  try {
    return fs.existsSync(resolveStored(storedName));
  } catch {
    return false;
  }
}
