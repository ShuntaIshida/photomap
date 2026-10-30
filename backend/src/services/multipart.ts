import type { Request } from 'express';
import busboy from 'busboy';
import { errors } from '../errors.js';
import { MAX_ORIGINAL_BYTES, MAX_THUMBNAIL_BYTES } from './photoFormat.js';

export interface ParsedUpload {
  file: Buffer;
  filename: string;
}

// 原本（上限）+ 旧クライアントが送るサムネイル（破棄する）+ multipartの枠分。これを超える宣言は読み込まずに拒否する。
const MAX_REQUEST_BYTES = MAX_ORIGINAL_BYTES + MAX_THUMBNAIL_BYTES + 64 * 1024;

/**
 * multipart/form-data から `file`（原本）だけを読む。
 * サムネイルはサーバーで生成するため、旧クライアントが送る `thumbnail` は受け取って破棄する。
 * それ以外のフィールド（例: 保存先フォルダーID）は無視する。
 */
export function parseUploadRequest(req: Request): Promise<ParsedUpload> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return Promise.reject(errors.fileTooLarge());

  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { files: 2, fields: 8, parts: 12, fileSize: MAX_ORIGINAL_BYTES },
      });
    } catch {
      reject(errors.invalidUpload('Expected multipart/form-data'));
      return;
    }

    const chunks: Buffer[] = [];
    const seen = new Set<string>();
    let filename = '';
    let failure: Error | null = null;
    const fail = (e: Error) => {
      failure ??= e;
    };

    bb.on('file', (name, stream, info) => {
      if ((name !== 'file' && name !== 'thumbnail') || seen.has(name)) {
        fail(errors.invalidUpload('Unexpected file field'));
        stream.resume();
        return;
      }
      seen.add(name);
      if (name === 'thumbnail') {
        // 旧クライアント互換。中身は使わずに読み捨てる。
        stream.resume();
        return;
      }
      filename = info.filename ?? '';
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ORIGINAL_BYTES) {
          fail(errors.fileTooLarge());
          return;
        }
        chunks.push(chunk);
      });
      stream.on('limit', () => fail(errors.fileTooLarge()));
    });
    bb.on('filesLimit', () => fail(errors.invalidUpload('Too many files')));
    bb.on('partsLimit', () => fail(errors.invalidUpload('Too many parts')));
    bb.on('error', () => fail(errors.invalidUpload('Malformed multipart body')));
    bb.on('close', () => {
      if (failure) return reject(failure);
      if (!seen.has('file')) return reject(errors.invalidUpload('file is required'));
      resolve({ file: Buffer.concat(chunks), filename });
    });

    req.pipe(bb);
  });
}
