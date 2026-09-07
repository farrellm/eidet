/**
 * The eidet server. See DESIGN.md §6, §9.
 *
 * It stores and syncs. It never schedules — all FSRS work happens on the phone,
 * which is what lets the app run with no network at all. Single user, no auth:
 * reachable only over the tailnet.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { openDb } from './db.ts'
import { pull, push } from './changes.ts'
import { BlobStore } from './blobs.ts'

const PORT = Number(process.env.EIDET_PORT ?? 8083)
// Loopback by default: there is no auth, so the only way in is the
// `tailscale serve` proxy in front of the deployed instance (DESIGN.md §7).
const HOST = process.env.EIDET_HOST ?? '127.0.0.1'
const DATA = process.env.EIDET_DATA ?? './data'
const WEB = process.env.EIDET_WEB ?? '../web/dist'

const db = openDb(join(DATA, 'eidet.db'))
const blobs = new BlobStore(db, join(DATA, 'blobs'))

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

async function body(req: import('node:http').IncomingMessage, limit = 16 * 1024 * 1024) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('payload too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const send = (code: number, data: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  try {
    // The reachability probe. Deliberately outside any service-worker runtime
    // cache, so it cannot be answered from cache while the network is down.
    if (url.pathname === '/api/healthz') return send(200, { ok: true })

    if (url.pathname === '/api/changes' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0)
      return send(200, pull(db, Number.isFinite(since) ? since : 0))
    }

    if (url.pathname === '/api/changes' && req.method === 'POST') {
      const changes = JSON.parse((await body(req)).toString('utf8'))
      return send(200, { seq: push(db, changes) })
    }

    const blobMatch = /^\/api\/blobs\/([0-9a-f]{64})$/.exec(url.pathname)
    if (blobMatch) {
      const sha256 = blobMatch[1]!
      if (req.method === 'PUT') {
        const result = await blobs.put(sha256, await body(req), {
          mime: req.headers['content-type'] ?? 'application/octet-stream',
          width: Number(req.headers['x-image-width'] ?? 0),
          height: Number(req.headers['x-image-height'] ?? 0),
        })
        return result.stored
          ? send(200, { sha256 })
          : send(400, { error: { code: 'bad_blob', message: result.error } })
      }
      if (req.method === 'GET') {
        const found = await blobs.get(sha256)
        if (!found) return send(404, { error: { code: 'not_found', message: 'No such image.' } })
        // Content-addressed, so the bytes can never change under this URL.
        res.writeHead(200, {
          'content-type': found.mime,
          'cache-control': 'public, max-age=31536000, immutable',
        })
        return res.end(found.data)
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return send(404, { error: { code: 'not_found', message: 'No such endpoint.' } })
    }

    await serveStatic(url.pathname, res)
  } catch (err) {
    send(500, { error: { code: 'server_error', message: String(err) } })
  }
})

/** Static assets, with an SPA fallback so a deep link survives a hard reload. */
async function serveStatic(pathname: string, res: import('node:http').ServerResponse) {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const candidate = join(WEB, safe === '/' ? 'index.html' : safe)
  try {
    const data = await readFile(candidate)
    res.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    try {
      const html = await readFile(join(WEB, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html']! })
      res.end(html)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    }
  }
}

server.listen(PORT, HOST, () => {
  console.log(`eidet server on http://${HOST}:${PORT} (data: ${DATA})`)
})
