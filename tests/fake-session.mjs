// Pseudo-Browsersitzung fuer Tests (MWA_FAKE_SESSION): page.evaluate fuehrt die In-Page-Funktionen in Node aus, gegen ein Fake-fetch.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOP = {
  'desk organizer': [
    { id: 1, title: 'Modular desk shelf', downloadCount: 2000, tags: ['desk', 'desk shelf', 'organizer', 'desk accessories', 'home office', 'storage', 'pop mart'] },
    { id: 2, title: 'Desk organizer box', downloadCount: 900, tags: ['desk', 'organizer', 'storage', 'pen holder', 'Desk Organizer', 'organizers'] },
    { id: 3, title: 'Cable management desk', downloadCount: 300, tags: ['desk', 'cable management', 'office', 'organizer'] },
  ],
};
const COUNTS = { desk: 54381, organizer: 81731, 'desk shelf': 5000, 'desk accessories': 9000, 'home office': 20000, storage: 90000, 'pen holder': 10990, 'cable management': 3860, office: 60000, 'desk organizer': 7000, 'pop mart': 500, organizers: 100 };
globalThis.__calls = { search: 0, suggest: 0 };
const fakeFetch = async url => {
  const u = new URL(url, 'https://makerworld.com'), kw = u.searchParams.get('keyword') || '';
  if (u.pathname.endsWith('/select/design2')) { globalThis.__calls.search++; const off = +u.searchParams.get('offset') || 0; return { ok: true, json: async () => ({ hits: off ? [] : (TOP[kw] || []) }) }; }
  if (u.pathname.endsWith('/suggest')) {
    globalThis.__calls.suggest++;
    const items = Object.entries(COUNTS).filter(([k]) => k.startsWith(kw.toLowerCase())).slice(0, 5).map(([text, count]) => ({ text, count }));
    if (kw === 'desk organizer a') items.push({ text: 'desk organizer acrylic', count: 400 }, { text: 'desk organizer&amp;amp;amp;#39', count: 0 });
    return { ok: true, json: async () => ({ suggestions: items }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
export default async function () {
  return { handle: 'tester', ctx: null, page: { evaluate: async (fn, arg) => { globalThis.fetch = fakeFetch; globalThis.__MW_DELAY__ = 1; await sleep(+process.env.MWA_FAKE_SLOW || 0); return fn(arg); } } };
}
