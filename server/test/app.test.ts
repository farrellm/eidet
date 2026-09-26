/**
 * The HTTP surface, driven through the real handler on an ephemeral port. A
 * request that is the client's fault must say so (4xx), not read as the
 * server falling over; and the blob store must still refuse bytes that are
 * not what their name says.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PullResponse } from '@eidet/shared'
import { createHandler } from '../src/app.ts'
import { BlobStore } from '../src/blobs.ts'
import { openDb } from '../src/db.ts'

let server: Server
let base: string
let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eidet-app-'))
  const db = openDb(':memory:')
  const handle = createHandler({ db, blobs: new BlobStore(db, join(dir, 'blobs')), webRoot: dir })
  server = createServer((req, res) => void handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

type ErrorBody = { error: { code: string } }

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

describe('the api', () => {
  it('answers the reachability probe', async () => {
    const res = await fetch(`${base}/api/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('round-trips a push and a pull', async () => {
    const push = await fetch(`${base}/api/changes`, {
      method: 'POST',
      body: JSON.stringify({ paramSets: [{ hash: 'h', w: [1], requestRetention: 0.9, learningSteps: ['1m'], createdAt: 1 }] }),
    })
    expect(push.status).toBe(200)
    const pulled = (await (await fetch(`${base}/api/changes?since=0`)).json()) as PullResponse
    expect(pulled.paramSets).toHaveLength(1)
  })

  it('rejects malformed JSON as a bad request, not a server error', async () => {
    const res = await fetch(`${base}/api/changes`, { method: 'POST', body: '{nope' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error.code).toBe('bad_json')
  })

  it('rejects a body that is not a change set', async () => {
    const res = await fetch(`${base}/api/changes`, { method: 'POST', body: '[1, 2]' })
    expect(res.status).toBe(400)
  })

  it('refuses an oversized blob with 413', async () => {
    const data = Buffer.alloc(8 * 1024 * 1024 + 1)
    const res = await fetch(`${base}/api/blobs/${sha(data)}`, { method: 'PUT', body: data })
    expect(res.status).toBe(413)
  })

  it('stores a blob whose digest matches, and serves it immutable', async () => {
    const data = Buffer.from('an image, honestly')
    const put = await fetch(`${base}/api/blobs/${sha(data)}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/webp', 'x-image-width': 'garbage' },
      body: data,
    })
    expect(put.status).toBe(200)
    const got = await fetch(`${base}/api/blobs/${sha(data)}`)
    expect(got.headers.get('cache-control')).toContain('immutable')
    expect(Buffer.from(await got.arrayBuffer())).toEqual(data)
  })

  it('refuses a blob whose bytes are not what its name says', async () => {
    const res = await fetch(`${base}/api/blobs/${sha(Buffer.from('a'))}`, {
      method: 'PUT',
      body: Buffer.from('b'),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error.code).toBe('bad_blob')
  })

  it('404s an unknown endpoint', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404)
  })
})
