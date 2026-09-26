/**
 * The eidet server. See DESIGN.md §6, §9.
 *
 * It stores and syncs. It never schedules — all FSRS work happens on the phone,
 * which is what lets the app run with no network at all. Single user, no auth:
 * reachable only over the tailnet.
 */
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createHandler } from './app.ts'
import { BlobStore } from './blobs.ts'
import { config } from './config.ts'
import { openDb } from './db.ts'

const db = openDb(join(config.dataDir, 'eidet.db'))
const blobs = new BlobStore(db, join(config.dataDir, 'blobs'))
const handle = createHandler({ db, blobs, webRoot: config.webRoot })
const server = createServer((req, res) => void handle(req, res))

server.listen(config.port, config.host, () => {
  console.log(`eidet server on http://${config.host}:${config.port} (data: ${config.dataDir})`)
})
