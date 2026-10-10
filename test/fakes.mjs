/**
 * Stand-ins for tests: a MongoDB Db with the few operations the stores use,
 * a SQLite query function (node:sqlite, in memory) and a fetch that answers
 * from a list.
 */

function match(doc, q) {
  return Object.entries(q ?? {}).every(([k, v]) => {
    const x = doc[k];
    if (v && typeof v === 'object' && !(v instanceof Date) && '$lt' in v) return x !== undefined && x < v.$lt;
    return x === v;
  });
}
function setDotted(o, path, fn) {
  const parts = path.split('.');
  let x = o;
  for (const k of parts.slice(0, -1)) x = x[k] && typeof x[k] === 'object' ? x[k] : (x[k] = {});
  const last = parts[parts.length - 1];
  x[last] = fn(x[last]);
}

/** A Db whose collections live in memory: { db, data: Map(name → docs[]) }. */
export function fakeMongo() {
  const data = new Map();
  const coll = (name) => {
    if (!data.has(name)) data.set(name, []);
    const docs = data.get(name);
    const cursor = (list) => ({
      sort(spec) {
        const [[k, dir]] = Object.entries(spec);
        list.sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
        return cursor(list);
      },
      async toArray() {
        return list.map((d) => structuredClone(d));
      },
    });
    const project = (d, p) => {
      if (!p) return d;
      const out = { ...d };
      for (const [k, v] of Object.entries(p)) if (v === 0) delete out[k];
      return out;
    };
    return {
      async createIndex() {},
      async insertOne(doc) {
        docs.push(structuredClone(doc));
      },
      async updateOne(filter, update, opts = {}) {
        let doc = docs.find((d) => match(d, filter));
        if (!doc) {
          if (!opts.upsert) return { matchedCount: 0 };
          doc = { ...filter };
          docs.push(doc);
          for (const [k, v] of Object.entries(update.$setOnInsert ?? {})) doc[k] = v;
        }
        for (const [k, v] of Object.entries(update.$inc ?? {})) setDotted(doc, k, (x) => (x ?? 0) + v);
        for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = structuredClone(v);
        for (const [k, v] of Object.entries(update.$push ?? {})) {
          const each = v && typeof v === 'object' && '$each' in v ? v.$each : [v];
          let list = [...(Array.isArray(doc[k]) ? doc[k] : []), ...structuredClone(each)];
          if (v && v.$sort) {
            const [[sk, dir]] = Object.entries(v.$sort);
            list.sort((a, b) => (a[sk] < b[sk] ? -dir : a[sk] > b[sk] ? dir : 0));
          }
          if (v && typeof v.$slice === 'number') list = v.$slice < 0 ? list.slice(v.$slice) : list.slice(0, v.$slice);
          doc[k] = list;
        }
        return { matchedCount: 1 };
      },
      find(q, opts = {}) {
        return cursor(docs.filter((d) => match(d, q)).map((d) => project(d, opts.projection)));
      },
      async findOne(q, opts = {}) {
        let list = docs.filter((d) => match(d, q));
        if (opts.sort) list = await cursor(list).sort(opts.sort).toArray();
        return list[0] ? structuredClone(list[0]) : null;
      },
      async deleteMany(q) {
        let n = 0;
        for (let i = docs.length - 1; i >= 0; i--) if (match(docs[i], q)) (docs.splice(i, 1), n++);
        return { deletedCount: n };
      },
    };
  };
  return { db: { collection: coll }, data };
}

/** A query(sql, params) on an in-memory SQLite database (node:sqlite), or null where it is missing. */
export async function sqliteQuery() {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return null;
  }
  const db = new sqlite.DatabaseSync(':memory:');
  const query = async (sql, params = []) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
  return { query, db };
}

/** fetch from a list of answers ({ status, json, headers }); records every call. */
export function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const a = typeof answers === 'function' ? answers(calls[calls.length - 1], calls.length - 1) : answers[Math.min(calls.length - 1, answers.length - 1)];
    return new Response(a.json === undefined ? null : JSON.stringify(a.json), { status: a.status ?? 200, headers: a.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}
