const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const app = require('./app');
const pool = require('./database/pool');
const port = Number(process.env.PORT || 3000);
async function start() {
  await pool.query('SELECT 1');
  app.listen(port, () => console.log(`BMU TTMS auth server listening on http://localhost:${port}`));
}
start().catch(error => { console.error('Server startup failed. Check MySQL and environment configuration.', error.message); process.exit(1); });
