// Starts the API. One instance (and one database) per customer install: `npm run server`.
import { createServer } from 'node:http'
import { createApp } from './app'
import { Store } from './db'
import { checkPrimitiveLibrary } from '../src/model/primitives'

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'
const DB_PATH = process.env.DMF_DB ?? 'data/dmf-toolkit.db'

const problems = checkPrimitiveLibrary()
if (problems.length) throw new Error(`src/model/primitives.json is invalid: ${problems.join('; ')}`)

const store = new Store(DB_PATH)
createServer(createApp(store)).listen(PORT, HOST, () => {
  console.log(`DMF Toolkit API on http://${HOST}:${PORT} (database: ${DB_PATH})`)
})
