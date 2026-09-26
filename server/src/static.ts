/** The built web app, with an SPA fallback so a deep link survives a hard reload. */
import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

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

export async function serveStatic(webRoot: string, pathname: string, res: ServerResponse) {
  // `pathname` comes from a parsed URL, so dot segments are already resolved;
  // stripping any leading `../` is belt and braces against leaving `webRoot`.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const candidate = join(webRoot, safe === '/' ? 'index.html' : safe)
  try {
    const data = await readFile(candidate)
    res.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    try {
      const html = await readFile(join(webRoot, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html']! })
      res.end(html)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    }
  }
}
