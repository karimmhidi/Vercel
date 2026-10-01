// Vercel Serverless Function: secure proxy to the Sage 300 Web API.
// Credentials (SAGE_API_USER / SAGE_API_PASS) live only in Vercel's environment
// variables — never in this file, never sent to the browser.
//
// Called by the frontend as:
//   /api/sage-proxy?company=LTN001&type=customers
//
// (National accounts (ARNationalAccounts) support was removed — it never had
// reliable field names and was costing an extra, often-failing round-trip per
// affiliate on every load.)
//
// Add each affiliate's Sage company code to COMPANY_CODES below as you learn it.

const BASE_URL = 'https://appapi.olaenergy.com/Sage300WebApi/v1.0';

// Real Sage 300 company codes (ORGID), one per OLA Energy affiliate.
// Since the affiliate code and the Sage company ID are the same string here,
// this map also doubles as the list of valid/known companies for the dropdown.
const COMPANY_CODES = {
  BFDATA: 'BFDATA', // OLA Energy Burkina SA — Burkina-Faso
  CIDATA: 'CIDATA', // OLA Energy Côte d'Ivoire
  EGDATA: 'EGDATA', // OLA Energy Misr Co. S.A.E. — Egypt
  GADATA: 'GADATA', // OLA Energy Gabon S.A.
  LMA001: 'LMA001', // OLA Energy Maroc SAS
  LOCA:   'LOCA',   // OLA Energy Cameroon
  LOKDAT: 'LOKDAT', // OLA Energy Kenya Limited
  LTN001: 'LTN001', // OLA Energy Tunisie (confirmed working)
  MLDATA: 'MLDATA', // OLA Energy Mali SA
  NEDATA: 'NEDATA', // OLA Energy Niger
  REDATA: 'REDATA', // OLA Energy Réunion SAS
  SNDATA: 'SNDATA', // OLA Energy Sénégal
  TDDATA: 'TDDATA', // OLA Energy Chad S.A.
  UGDATA: 'UGDATA', // OLA Energy Uganda Limited
};

// Display names, used by the /api/sage-proxy?list=companies endpoint so the
// frontend can build the affiliate picker without hardcoding names in the client.
const COMPANY_NAMES = {
  BFDATA: "OLA Energy Burkina SA (Burkina-Faso)",
  CIDATA: "OLA Energy Côte d'Ivoire",
  EGDATA: "OLA Energy Misr Co. S.A.E. (Egypt)",
  GADATA: "OLA Energy Gabon S.A.",
  LMA001: "OLA Energy Maroc SAS",
  LOCA:   "OLA Energy Cameroon",
  LOKDAT: "OLA Energy Kenya Limited",
  LTN001: "OLA Energy Tunisie",
  MLDATA: "OLA Energy Mali SA",
  NEDATA: "OLA Energy Niger",
  REDATA: "OLA Energy Réunion SAS",
  SNDATA: "OLA Energy Sénégal",
  TDDATA: "OLA Energy Chad S.A.",
  UGDATA: "OLA Energy Uganda Limited",
};

const CUSTOMER_SELECT = 'CustomerNumber,GroupCode,NationalAccount,Status,OnHold,CustomerName,CustomerOptionalFieldValues';

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Sage's server can occasionally just stop responding mid-request instead of
// returning a clean error. Without a hard cutoff, that hang can run past the
// platform's own limit and comes back to the browser as an ugly connection
// timeout instead of a clean, retryable error. So every attempt gets its own
// deadline — set generously here since Vercel allows much longer function
// execution than Netlify's free tier does.
async function fetchWithTimeout(url, auth, timeoutMs = 55000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    return await fetch(url, {
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
      signal: controller.signal,
    });
  }catch(err){
    if(err.name === 'AbortError'){
      throw Object.assign(new Error(`Sage API did not respond within ${timeoutMs / 1000}s (stalled connection).`), { stalled: true });
    }
    throw err;
  }finally{
    clearTimeout(timer);
  }
}

// Sage 300 Web API commonly enforces a small concurrent-session limit per login,
// which shows up as a 409/423/429 — that's worth a quick retry, since it usually
// clears in a second or two. A genuine stalled connection (no response at all) is
// different: retrying it just means waiting the full timeout twice in a row, which
// risks running past the platform's own function time limit — so a stall fails
// immediately and the frontend just moves on / lets you retry that affiliate.
async function fetchWithRetry(url, auth, attempts = 2){
  let lastErr;
  for(let i = 0; i < attempts; i++){
    let res;
    try{
      res = await fetchWithTimeout(url, auth);
    }catch(err){
      if(err.stalled) throw err; // don't burn more time retrying a hang
      lastErr = err;
      if(i < attempts - 1){ await sleep(1000 * (i + 1)); continue; }
      throw lastErr;
    }
    if(res.ok) return res.json();
    const text = await res.text().catch(() => '');
    lastErr = new Error(`Sage API returned ${res.status}: ${text.slice(0,300)}`);
    if((res.status === 409 || res.status === 423 || res.status === 429) && i < attempts - 1){
      await sleep(1000 * (i + 1)); // 1s, 2s...
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const params = req.query || {};

  // /api/sage-proxy?list=companies -> returns the known affiliate list
  // (no Sage API call needed, so this works even before credentials are set).
  if(String(params.list || '').toLowerCase() === 'companies'){
    const list = Object.keys(COMPANY_CODES).map(code => ({ code, name: COMPANY_NAMES[code] || code }));
    res.status(200).json({ companies: list });
    return;
  }

  const user = process.env.SAGE_API_USER;
  const pass = process.env.SAGE_API_PASS;
  if(!user || !pass){
    res.status(500).json({ error: 'Sage API credentials are not configured on the server (SAGE_API_USER / SAGE_API_PASS).' });
    return;
  }

  const affiliateCode = String(params.company || '').toUpperCase();
  const type = 'customers'; // national accounts support removed
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  // A big affiliate (thousands of customers) has many OData pages. Fetching all of
  // them inside one call can take longer than the platform allows. So each call
  // fetches ONE page only, and returns Sage's own "next page" link — the frontend
  // calls back with ?next=<that link> to get the following page, looping until
  // there's no next link left.
  let targetUrl;
  if(params.next){
    try{ targetUrl = decodeURIComponent(String(params.next)); }catch(e){
      res.status(400).json({ error: 'Invalid "next" parameter.' });
      return;
    }
    if(!targetUrl.startsWith(BASE_URL)){
      res.status(400).json({ error: 'Invalid "next" link.' });
      return;
    }
  }else{
    const companyId = COMPANY_CODES[affiliateCode] || affiliateCode; // allow passing a raw Sage company ID too
    if(!companyId){
      res.status(400).json({ error: `Unknown affiliate code "${affiliateCode}". Add it to COMPANY_CODES in sage-proxy.js.` });
      return;
    }
    const select = CUSTOMER_SELECT;
    const entity = 'ARCustomers';
    // $top asks Sage for a bigger page per request — Sage's own server-side cap may
    // still apply, but when it doesn't this cuts the number of slow round-trips a lot.
    // (Reverted from 1000 back to 500 — raising it broke every affiliate with a 502,
    // so Sage is likely rejecting or choking on the larger page size.)
    targetUrl = `${BASE_URL}/-/${companyId}/AR/${entity}?$select=${encodeURIComponent(select)}&$top=500`;
  }

  try{
    const json = await fetchWithRetry(targetUrl, auth);
    const records = json.value || [];
    res.status(200).json({
      company: affiliateCode, type,
      count: records.length,
      records,
      nextLink: json['@odata.nextLink'] || null,
    });
  }catch(err){
    res.status(502).json({ error: String(err.message || err) });
  }
};
