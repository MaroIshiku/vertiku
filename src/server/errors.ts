import type { FastifyRequest } from 'fastify';
import { InputFolderError } from './input-library.js';

/** A conversion failure with a stable code, a browser-safe message, and whether the job may be retried. */
export class JobFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) { super(message); }
}

/** An error whose message is safe and useful to show in the browser; every other error is logged and replaced by a generic message. */
export class UserFacingError extends Error {}

export const MULTIPART_LIMIT_MESSAGES: Record<string, { status: number; code: string; message: string }> = {
  FST_REQ_FILE_TOO_LARGE: { status: 413, code: 'UPLOAD_TOO_LARGE', message: 'One of the selected files exceeds the configured upload limit.' },
  FST_FILES_LIMIT: { status: 400, code: 'UPLOAD_TOO_MANY_FILES', message: 'Select at most 500 audio files and one cover image.' },
  FST_PARTS_LIMIT: { status: 400, code: 'UPLOAD_TOO_MANY_FILES', message: 'Select at most 500 audio files and one cover image.' }
};

export const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

const isUserFacing = (error: unknown): error is Error => error instanceof UserFacingError || error instanceof InputFolderError;

/** Returns the message to show in the browser, logging anything that is not explicitly browser-safe. */
export function clientError(request: FastifyRequest, error: unknown, fallback: string) {
  if (isUserFacing(error)) return error.message;
  request.log.warn({ err: error }, 'Request input could not be processed');
  return fallback;
}
