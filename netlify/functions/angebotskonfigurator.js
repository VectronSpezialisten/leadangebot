// Angebotskonfigurator – Backend
//
// GET  /.netlify/functions/angebotskonfigurator?partyId=2541001
//      -> lädt den vollständigen Konfigurator-Katalog (statusId-eq=2544460)
//         und die vier vorbefüllten Blöcke der angegebenen Party
//
// PUT  /.netlify/functions/angebotskonfigurator?partyId=2541001
//      Body: { "blocks": { "kostenpflichtig": ["2544293", ...], "enthalten": [...], "kauf": [...], "vorhanden": [...] } }
//      -> schreibt die vier Blöcke (Auswahl + Reihenfolge) zurück in die Party
//
// weclapp verlangt bei PUT immer das vollständige Objekt (siehe Notion "Wissen intern") –
// deshalb wird die Party vor dem Schreiben komplett geladen und nur die vier
// betroffenen customAttributes-Einträge werden verändert.

// Gleiche Env-Var-Namen wie bei Leadstart (WECLAPP_DOMAIN = kompletter Domain-String,
// z.B. thiedebrauer.weclapp.com, nicht nur die Subdomain) - für einen späteren
// fließenden Übergang zwischen den beiden Apps sollen beide Backends dieselbe
// Konvention verwenden.
const BASE_URL = `https://${process.env.WECLAPP_DOMAIN}/webapp/api/v2`;

// Reihenfolge hier = Anzeige-Reihenfolge der Blöcke im Frontend.
const BLOCK_ATTRIBUTE_IDS = {
  kostenpflichtig: '2544446',
  enthalten: '2544448',
  kauf: '2544452',
  vorhanden: '2543133'
};

const KATALOG_STATUS_ID = '2544460'; // articleStatus "Smart4Pay Konfigurator"

// Neues Custom Attribute auf Artikel-Ebene (MULTISELECT_LIST, Label "S4P Konfigurator"):
// legt fest, in welchem/welchen Block(s) ein Artikel überhaupt wählbar sein darf.
// Ein Artikel ohne Eintrag hier taucht in KEINEM Block auf, bis er in weclapp getaggt wird.
const KATALOG_ZUORDNUNG_ATTRIBUTE_ID = '2567322';
const KATALOG_ZUORDNUNG_WERT_ZU_BLOCK = {
  '2567324': 'kostenpflichtig',
  '2567325': 'enthalten',
  '2567326': 'kauf',
  '2567327': 'vorhanden'
};

function ermittleErlaubteBloecke(article) {
  const attr = (article.customAttributes || []).find(
    (a) => a.attributeDefinitionId === KATALOG_ZUORDNUNG_ATTRIBUTE_ID
  );
  const selectedValues = (attr && attr.selectedValues) || [];
  return selectedValues
    .map((v) => KATALOG_ZUORDNUNG_WERT_ZU_BLOCK[v.id])
    .filter(Boolean);
}

// ---------- Zugangsprüfung (identisch zu Leadstart, gleiche Env Vars) ----------

function pruefeZugang(email, passwort) {
  const sharedPassword = process.env.SHARED_PASSWORD || '';
  const allowedEmails = (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const emailNormalized = (email || '').trim().toLowerCase();

  if (!sharedPassword || passwort !== sharedPassword) {
    return { ok: false, grund: 'Falsches Passwort.' };
  }
  if (allowedEmails.length === 0) {
    return { ok: false, grund: 'Keine erlaubten E-Mail-Adressen konfiguriert.' };
  }
  if (!allowedEmails.includes(emailNormalized)) {
    return { ok: false, grund: 'Diese E-Mail-Adresse ist nicht freigeschaltet.' };
  }
  return { ok: true };
}

async function weclapp(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      AuthenticationToken: process.env.WECLAPP_API_TOKEN,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`weclapp ${options.method || 'GET'} ${path} -> ${response.status}: ${text}`);
  }

  return response.status === 204 ? null : response.json();
}

function ermittlePreis(article) {
  const prices = article.articlePrices || [];
  const allgemein = prices.find((p) => !p.customerId) || prices[0];
  return allgemein ? parseFloat(allgemein.price) : 0;
}

function katalogEintragAus(article) {
  return {
    articleId: article.id,
    articleNumber: article.articleNumber,
    name: article.name,
    price: ermittlePreis(article),
    erlaubteBloecke: ermittleErlaubteBloecke(article)
  };
}

async function ladeKatalog() {
  const response = await weclapp(
    `/article?statusId-eq=${KATALOG_STATUS_ID}&pageSize=200&sort=name`
  );
  return (response.result || []).map(katalogEintragAus);
}

function blockAusParty(party, blockName) {
  const attributeDefinitionId = BLOCK_ATTRIBUTE_IDS[blockName];
  const attr = (party.customAttributes || []).find(
    (a) => a.attributeDefinitionId === attributeDefinitionId
  );
  const refs = (attr && attr.entityReferences) || [];
  return refs.map((r) => r.entityId);
}

async function handleGet(partyId) {
  const [katalog, party] = await Promise.all([
    ladeKatalog(),
    weclapp(`/party/id/${partyId}`)
  ]);

  const katalogById = new Map(katalog.map((k) => [k.articleId, k]));
  const fehlendeIds = new Set();

  const blocks = {};
  for (const blockName of Object.keys(BLOCK_ATTRIBUTE_IDS)) {
    const ids = blockAusParty(party, blockName);
    blocks[blockName] = ids;
    for (const id of ids) {
      if (!katalogById.has(id)) fehlendeIds.add(id);
    }
  }

  // Vorbefüllte Artikel, die (noch) nicht im Katalog stehen (z.B. Status noch nicht gesetzt),
  // trotzdem einzeln nachladen, damit im Frontend nichts als "unbekannter Artikel" auftaucht.
  const nachgeladen = await Promise.all(
    [...fehlendeIds].map((id) =>
      weclapp(`/article/id/${id}`).then(katalogEintragAus).catch(() => null)
    )
  );
  for (const eintrag of nachgeladen) {
    if (eintrag) katalogById.set(eintrag.articleId, eintrag);
  }

  const blocksMitDetails = {};
  for (const [blockName, ids] of Object.entries(blocks)) {
    blocksMitDetails[blockName] = ids
      .map((id) => katalogById.get(id))
      .filter(Boolean);
  }

  return {
    party: { id: party.id, company: party.company },
    katalog,
    blocks: blocksMitDetails
  };
}

async function handlePut(partyId, body) {
  const { blocks } = body;
  if (!blocks) {
    throw new Error('Body benötigt Feld "blocks".');
  }

  // weclapp verlangt das vollständige Objekt bei PUT – deshalb erst komplett laden.
  const party = await weclapp(`/party/id/${partyId}`);
  const customAttributes = party.customAttributes || [];

  for (const [blockName, attributeDefinitionId] of Object.entries(BLOCK_ATTRIBUTE_IDS)) {
    const ids = blocks[blockName] || [];
    const entityReferences = ids.map((id) => ({ entityId: id, entityName: 'article' }));

    const bestehenderIndex = customAttributes.findIndex(
      (a) => a.attributeDefinitionId === attributeDefinitionId
    );

    if (bestehenderIndex >= 0) {
      customAttributes[bestehenderIndex] = {
        ...customAttributes[bestehenderIndex],
        entityReferences
      };
    } else {
      customAttributes.push({ attributeDefinitionId, entityReferences });
    }
  }

  const aktualisierteParty = { ...party, customAttributes };

  await weclapp(`/party/id/${partyId}`, {
    method: 'PUT',
    body: JSON.stringify(aktualisierteParty)
  });

  return { gespeichert: true };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const partyId = event.queryStringParameters && event.queryStringParameters.partyId;
  if (!partyId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ fehler: 'Query-Parameter partyId fehlt.' })
    };
  }

  // Zugangsdaten kommen bei GET als Query-Parameter (aus dem Link von Leadstart
  // bzw. der eigenen Login-Box), bei PUT zusätzlich aus dem Body, damit das
  // Speichern nicht durch eine unvollständige Query-String-Länge riskiert wird.
  let email;
  let passwort;

  if (event.httpMethod === 'PUT') {
    const bodyVorab = JSON.parse(event.body || '{}');
    email = bodyVorab.email;
    passwort = bodyVorab.passwort;
  } else {
    email = event.queryStringParameters && event.queryStringParameters.email;
    passwort = event.queryStringParameters && event.queryStringParameters.pw;
  }

  const zugang = pruefeZugang(email, passwort);
  if (!zugang.ok) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ fehler: zugang.grund })
    };
  }

  try {
    if (event.httpMethod === 'GET') {
      const daten = await handleGet(partyId);
      return { statusCode: 200, headers, body: JSON.stringify(daten) };
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const ergebnis = await handlePut(partyId, body);
      return { statusCode: 200, headers, body: JSON.stringify(ergebnis) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ fehler: 'Methode nicht erlaubt.' }) };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ fehler: error.message })
    };
  }
};
