import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, '../data/restaurant.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const databaseUrl = process.env.DATABASE_URL;
const pgPool = databaseUrl ? new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } }) : null;
const sqlite = pgPool ? null : new DatabaseSync(dbPath);
if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
const txContext = new AsyncLocalStorage();
let lockTail = Promise.resolve();
async function acquireLock() { let release; const previous=lockTail; lockTail=new Promise(resolve=>release=resolve); await previous; return release; }

function pgSql(source) {
  let sql=source.replace(/INSERT OR IGNORE INTO/gi,'INSERT INTO').replace(/\s+COLLATE NOCASE/gi,'').replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi,'SERIAL PRIMARY KEY');
  sql=sql.replace(/date\(created_at\)=date\('now','localtime'\)/gi,'created_at::date=CURRENT_DATE').replace(/reservation_date=date\('now','localtime'\)/gi,"reservation_date=TO_CHAR(CURRENT_DATE,'YYYY-MM-DD')");
  let index=0, quote=null; sql=sql.replace(/\?|['"`]|--[^\n]*|\/\*[\s\S]*?\*\//g, token=>{ if(token==='?' && !quote) return `$${++index}`; if((token==="'"||token==='"'||token==='`') && (!quote||quote===token)) quote=quote?null:token; return token; });
  return sql;
}

class DatabaseAdapter {
  constructor() { this.isPostgres=Boolean(pgPool); }
  async init() {
    if (pgPool) {
      const schema = POSTGRES_SCHEMA;
      await pgPool.query(schema);
      await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email))');
      await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS ingredients_name_lower_idx ON ingredients (LOWER(name))');
    } else sqlite.exec(SQLITE_SCHEMA);
  }
  prepare(source) {
    const sql=source;
    const execute=async (mode, params)=>{
      if(pgPool) {
        const client=txContext.getStore()||pgPool;
        let query=pgSql(sql);
        const inserting=/^\s*INSERT\s+INTO\s+(\w+)/i.test(query);
        const ignore=/INSERT OR IGNORE/i.test(sql);
        if(ignore) query=query.replace(/;?\s*$/,' ON CONFLICT DO NOTHING');
        if(inserting && /^(users|menu_items|suppliers|ingredients|reservations|orders|order_items|messages|notifications|inventory_log|purchase_orders|purchase_order_items|feedback)$/i.test(query.match(/^\s*INSERT\s+INTO\s+(\w+)/i)?.[1]||'')) query=query.replace(/;?\s*$/,' RETURNING id');
        const run=async()=>client.query(query,params);
        let result;
        if(txContext.getStore()) result=await run();
        else {const release=await acquireLock();try{result=await run()}finally{release()}}
        if(mode==='get') return result.rows[0];
        if(mode==='all') return result.rows;
        return {lastInsertRowid:result.rows[0]?.id||0,changes:result.rowCount||0};
      }
      const statement=sqlite.prepare(sql);
      const run=()=>mode==='get'?statement.get(...params):mode==='all'?statement.all(...params):statement.run(...params);
      if(txContext.getStore()) return run();
      const release=await acquireLock();try{return run()}finally{release()}
    };
    return { get:(...params)=>execute('get',params), all:(...params)=>execute('all',params), run:(...params)=>execute('run',params) };
  }
  async transaction(fn) {
    if(pgPool) {
      const client=await pgPool.connect();
      try { await client.query('BEGIN'); const value=await txContext.run(client,fn); await client.query('COMMIT'); return value; }
      catch(err){await client.query('ROLLBACK');throw err} finally{client.release()}
    }
    const release=await acquireLock(); sqlite.exec('BEGIN IMMEDIATE');
    try {const value=await txContext.run(sqlite,fn);sqlite.exec('COMMIT');return value}
    catch(err){sqlite.exec('ROLLBACK');throw err}finally{release()}
  }
}

const SQLITE_SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('admin','chef','waiter','customer')),
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  image_url TEXT NOT NULL DEFAULT '',
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  unit TEXT NOT NULL DEFAULT 'unit',
  quantity REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS recipes (
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  quantity REAL NOT NULL CHECK(quantity > 0),
  PRIMARY KEY(menu_item_id, ingredient_id)
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  reservation_date TEXT NOT NULL,
  time_slot TEXT NOT NULL,
  guests INTEGER NOT NULL CHECK(guests BETWEEN 1 AND 12),
  tables_needed INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Requested' CHECK(status IN ('Requested','Confirmed','Cancelled','Seated','Completed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS reservations_slot_idx ON reservations(reservation_date,time_slot,status);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Received' CHECK(status IN ('Received','Preparing','Ready','Served','Cancelled')),
  payment_status TEXT NOT NULL DEFAULT 'Due' CHECK(payment_status IN ('Due','Pending','Paid','Refunded')),
  payment_method TEXT NOT NULL DEFAULT 'Pay at pickup',
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  service_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  inventory_applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  audience TEXT NOT NULL DEFAULT 'customer',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inventory_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  change_amount REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Received','Cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_at TEXT
);
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  quantity REAL NOT NULL CHECK(quantity > 0),
  unit TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;
const POSTGRES_SCHEMA = SQLITE_SCHEMA.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi,'SERIAL PRIMARY KEY').replace(/\s+COLLATE NOCASE/gi,'').replace(/INSERT OR IGNORE/gi,'INSERT');
export const db = new DatabaseAdapter();

const initialMenu = [
  ['Bunny Chow','Meals','A proper Durban classic, filled with our slow-cooked curry.',450,'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?auto=format&fit=crop&w=700&q=80'],
  ['Samoosas (3)','Snacks','Golden, crisp little parcels. Choose veggie or beef.',150,'https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=700&q=80'],
  ['Vetkoek & Mince','Meals','Soft, warm vetkoek with a savoury mince filling.',300,'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?auto=format&fit=crop&w=700&q=80'],
  ['Boerewors Roll','Meals','Grilled boerewors, golden onions, and a little chakalaka.',350,'https://images.unsplash.com/photo-1528605248644-14dd04022da1?auto=format&fit=crop&w=700&q=80'],
  ['Toasted Sandwich','Snacks','Crispy on the outside, melty right through. Your choice.',250,'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=700&q=80'],
  ['Campus Coffee','Drinks','The warm, reliable start your morning needed.',150,'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=700&q=80']
];

export async function seedDatabase(env) {
  await db.transaction(async () => {
    if (db.isPostgres) await db.prepare("SELECT pg_advisory_xact_lock(hashtext('privies-campus-bites-seed'))").get();
  const count = Number((await db.prepare('SELECT COUNT(*) AS count FROM menu_items').get()).count);
  if (count === 0) {
    const insert = await db.prepare('INSERT INTO menu_items(name,category,description,price_cents,image_url) VALUES(?,?,?,?,?)');
    for (const item of initialMenu) await insert.run(...item);
  }

  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    const existing = await db.prepare('SELECT id FROM users WHERE email=?').get(env.ADMIN_EMAIL);
    if (!existing) {
      const hash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
      await db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)')
        .run(env.ADMIN_NAME || "Privie's Admin", env.ADMIN_EMAIL, hash, 'admin');
    }
  }

  const supplierCount = Number((await db.prepare('SELECT COUNT(*) AS count FROM suppliers').get()).count);
  if (!supplierCount) await db.prepare('INSERT INTO suppliers(name,contact_name,phone,notes) VALUES(?,?,?,?)')
    .run('Campus Fresh Market','Purchasing desk','', 'Demo supplier; replace with your actual supplier details.');
  const supplierId = (await db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get()).id;
  const ingredients = [
    ['Chicken','kg',12,3],['Tomatoes','kg',8,2],['Onions','kg',8,2],['Flour','kg',10,2],
    ['Beef mince','kg',8,2],['Sausage','kg',8,2],['Bread rolls','unit',40,10],
    ['Bread slices','unit',60,12],['Cheese','kg',4,1],['Coffee beans','kg',3,0.5],
    ['Cooking oil','litre',6,1],['Potatoes','kg',8,2]
  ];
  const addIngredient = await db.prepare('INSERT OR IGNORE INTO ingredients(name,unit,quantity,reorder_level,supplier_id) VALUES(?,?,?,?,?)');
  for (const row of ingredients) await addIngredient.run(...row, supplierId);

  if (Number((await db.prepare('SELECT COUNT(*) AS count FROM recipes').get()).count) === 0) {
    const itemIds = Object.fromEntries((await db.prepare('SELECT id,name FROM menu_items').all()).map(row=>[row.name,row.id]));
    const ingredientIds = Object.fromEntries((await db.prepare('SELECT id,name FROM ingredients').all()).map(row=>[row.name,row.id]));
    const recipes = [
      ['Bunny Chow','Chicken',0.22],['Bunny Chow','Tomatoes',0.12],['Bunny Chow','Onions',0.08],['Bunny Chow','Cooking oil',0.02],['Bunny Chow','Bread slices',2],
      ['Samoosas (3)','Flour',0.08],['Samoosas (3)','Cooking oil',0.02],['Vetkoek & Mince','Flour',0.12],['Vetkoek & Mince','Beef mince',0.12],['Vetkoek & Mince','Cooking oil',0.02],
      ['Boerewors Roll','Sausage',0.15],['Boerewors Roll','Bread rolls',1],['Toasted Sandwich','Bread slices',2],['Toasted Sandwich','Cheese',0.04],['Campus Coffee','Coffee beans',0.018]
    ];
    const addRecipe=await db.prepare('INSERT OR IGNORE INTO recipes(menu_item_id,ingredient_id,quantity) VALUES(?,?,?)');
    for (const [dish,ingredient,qty] of recipes) if(itemIds[dish]&&ingredientIds[ingredient]) await addRecipe.run(itemIds[dish],ingredientIds[ingredient],qty);
  }
  });
}
