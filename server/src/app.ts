/**
 * The HTTP surface. See DESIGN.md §6 for the endpoints.
 *
 * Built as a plain `(req, res)` handler over its dependencies, so the tests
 * drive the real routing without the process-level wiring in `index.ts`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { ChangeSet } from '@eidet/shared'
import { type BlobStore, MAX_BLOB_BYTES } from './blobs.ts'
import { pull, push } from './changes.ts'
import { serveStatic } from './static.ts'

/** The largest change set one push may carry. */
const MAX_CHANGES_BYTES = 16 * 1024 * 1024

/** A failure that is the request's fault, reported with its own status. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'too_large', 'Payload too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readChanges(req: IncomingMessage): Promise<Partial<ChangeSet>> {
  const text = (await readBody(req, MAX_CHANGES_BYTES)).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'bad_json', 'Body is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_changes', 'Expected a change set object.')
  }
  return parsed
}

/** A header as a non-negative integer, or 0 when absent or garbage. */
function intHeader(value: string | string[] | undefined): number {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function sendError(res: ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { error: { code, message } })
}

const BLOB_PATH = /^\/api\/blobs\/([0-9a-f]{64})$/

export function createHandler(deps: { db: DatabaseSync; blobs: BlobStore; webRoot: string }) {
  const { db, blobs, webRoot } = deps

  async function route(req: IncomingMessage, res: ServerResponse, url: URL) {
    const { pathname } = url

    // The reachability probe. Deliberately outside any service-worker runtime
    // cache, so it cannot be answered from cache while the network is down.
    if (pathname === '/api/healthz') return sendJson(res, 200, { ok: true })

    if (pathname === '/api/changes') {
      if (req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0)
        return sendJson(res, 200, pull(db, Number.isFinite(since) ? since : 0))
      }
      if (req.method === 'POST') {
        return sendJson(res, 200, { seq: push(db, await readChanges(req)) })
      }
    }

    const blobMatch = BLOB_PATH.exec(pathname)
    if (blobMatch) {
      const sha256 = blobMatch[1]!
      if (req.method === 'PUT') {
        const result = await blobs.put(sha256, await readBody(req, MAX_BLOB_BYTES), {
          mime: req.headers['content-type'] ?? 'application/octet-stream',
          width: intHeader(req.headers['x-image-width']),
          height: intHeader(req.headers['x-image-height']),
        })
        return result.stored
          ? sendJson(res, 200, { sha256 })
          : sendError(res, 400, 'bad_blob', result.error)
      }
      if (req.method === 'GET') {
        const found = await blobs.get(sha256)
        if (!found) return sendError(res, 404, 'not_found', 'No such image.')
        // Content-addressed, so the bytes can never change under this URL.
        res.writeHead(200, {
          'content-type': found.mime,
          'cache-control': 'public, max-age=31536000, immutable',
        })
        return res.end(found.data)
      }
    }

    if (pathname.startsWith('/api/')) {
      return sendError(res, 404, 'not_found', 'No such endpoint.')
    }

    await serveStatic(webRoot, pathname, res)
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    try {
      await route(req, res, url)
    } catch (err) {
      if (res.headersSent) return void res.destroy()
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message)
      console.error(err)
      sendError(res, 500, 'server_error', String(err))
    }
  }
}
