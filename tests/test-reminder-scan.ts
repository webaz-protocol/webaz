import { initDatabase } from '../src/layer0-foundation/L0-1-database/schema.js'
import { scanDeadlineReminders } from '../src/layer2-business/L2-6-notifications/notification-engine.js'

const db = initDatabase()
const r = scanDeadlineReminders(db)
console.log('sent:', r.sent)
console.log('details:', JSON.stringify(r.details, null, 2))
