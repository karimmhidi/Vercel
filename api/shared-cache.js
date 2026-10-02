// Vercel Serverless Function: a small shared, server-side cache so the whole team
// (not just one browser) benefits from a Sage 300 pull. The first request for a given
// affiliate each day pays the slow Sage cost once; everyone else reading the same
// affiliate that day gets this cached snapshot back instantly.
//
// Backed by Vercel Blob (public, JSON files at a fixed path per affiliate so they can
// be looked up deterministically). Requires the project to have a Blob store
// connected (Vercel dashboard -> Storage -> create a Blob store -> Connect Project),
// which also sets the BLOB_READ_WRITE_TOKEN environment variable automatically.
//
// GET  /api/shared-cache?company=BFDATA        -> { snapshot: {...} | null }
// POST /api/shared-cache?company=BFDATA        -> body is the snapshot to store

// require() itself can throw (e.g. the @vercel/blob package hasn't been installed
// yet because package.json/this file were only just uploaded, or the project
// hasn't redeployed since). That happens at import time, before our own try/catch
// below even runs, and previously crashed the whole function with a raw 500. Guard
// it here so a missing/not-yet-built dependency just disables the shared cache
// instead of breaking the request.
let put, list;
try{
  ({ put, list } = require('@vercel/blob'));
}catch(e){
  put = null; list = null;
}

function snapshotPath(code){
  return `snapshots/${code}.json`;
}

async function readSnapshot(code){
  const { blobs } = await list({ prefix: snapshotPath(code), limit: 1 });
  if(!blobs.length) return null;
  const res = await fetch(blobs[0].url, { cache: 'no-store' });
  if(!res.ok) return null;
  try{ return await res.json(); }catch(e){ return null; }
}

async function writeSnapshot(code, data){
  const body = JSON.stringify(data);
  await put(snapshotPath(code), body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if(!process.env.BLOB_READ_WRITE_TOKEN || !put || !list){
    // Shared cache isn't set up yet (no Blob store connected, or the @vercel/blob
    // package isn't installed/built yet) — callers should just fall back to a live fetch.
    res.status(200).json({ snapshot: null, sharedCacheConfigured: false });
    return;
  }

  const code = String((req.query && req.query.company) || '').toUpperCase();
  if(!code){
    res.status(400).json({ error: 'Missing "company" parameter.' });
    return;
  }

  try{
    if(req.method === 'POST'){
      let body = req.body;
      if(typeof body === 'string'){
        try{ body = JSON.parse(body); }catch(e){ body = null; }
      }
      if(!body || typeof body !== 'object'){
        res.status(400).json({ error: 'Invalid JSON body.' });
        return;
      }
      const snapshot = { ts: Date.now(), ...body };
      await writeSnapshot(code, snapshot);
      res.status(200).json({ ok: true, ts: snapshot.ts });
      return;
    }

    // GET (default)
    const snapshot = await readSnapshot(code);
    res.status(200).json({ snapshot, sharedCacheConfigured: true });
  }catch(err){
    // Blob not configured, or a transient error — treat as a cache miss rather than
    // failing the whole page load; the frontend will just fetch live from Sage.
    res.status(200).json({ snapshot: null, sharedCacheConfigured: false, error: String(err.message || err) });
  }
};
