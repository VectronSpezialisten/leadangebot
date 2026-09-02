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

// Für Fehler, die dem Nutzer mit einem passenden Status (nicht immer 500)
// angezeigt werden sollen, z.B. "Ticket nicht gefunden" -> 404.
class HandledError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Reihenfolge hier = Anzeige-Reihenfolge der Blöcke im Frontend.
const BLOCK_ATTRIBUTE_IDS = {
  kostenpflichtig: '2544446',
  enthalten: '2544448',
  kauf: '2544452',
  vorhanden: '2543133'
};

// Katalog-Zugehörigkeit läuft wieder über einen nativen Status - schneller als
// clientseitiges Filtern über 1000 Artikel. WICHTIG: neuer Status "S4P Konfigurator"
// (2569873), NICHT identisch mit dem alten, mittlerweile entfernten Status 2544460.
const KATALOG_STATUS_ID = '2569873';

// Neues Custom Attribute auf Artikel-Ebene (MULTISELECT_LIST, Label "S4P Konfigurator"):
// legt fest, in welchem/welchen Block(s) ein Artikel überhaupt wählbar sein darf.
// Ein Artikel ohne Eintrag hier taucht in KEINEM Block auf, bis er in weclapp getaggt wird.
const KATALOG_ZUORDNUNG_ATTRIBUTE_ID = '2567322';
const KATALOG_ZUORDNUNG_WERT_ZU_BLOCK = {
  '2567324': 'kostenpflichtig',
  '2567325': 'enthalten',
  '2567326': 'kauf',
  '2567327': 'vorhanden',
  '2568640': 'dienstleistung'
};

// "Zeitaufwand gesamt" - Custom Attribute auf Verkaufsartikeln (nicht auf den
// Dienstleistungsartikeln selbst!), von Karsten manuell gepflegt. Wird pro
// Artikel in kostenpflichtig/enthalten/kauf/vorhanden aufsummiert und im
// Dienstleistungen-Block als Orientierungswert angezeigt.
const ZEITAUFWAND_ATTRIBUTE_ID = '2544464';

function ermittleZeitaufwand(article) {
  const attr = (article.customAttributes || []).find(
    (a) => a.attributeDefinitionId === ZEITAUFWAND_ATTRIBUTE_ID
  );
  return attr && attr.numberValue != null ? parseFloat(attr.numberValue) : 0;
}

// Diese vier Dienstleistungsartikel werden bei jedem Laden in dieser Reihenfolge
// als Standardbestückung des Dienstleistungen-Blocks vorgeschlagen (per
// articleNumber aus dem bereits geladenen Katalog gematcht, keine feste ID
// nötig - bleibt stabil, auch wenn die Artikel-ID sich mal ändert).
const STANDARD_DIENSTLEISTUNG_ARTIKELNUMMERN = ['DOnboard', 'DInbetriebnahme', 'DEinweis', 'DFahr'];

// Payment-Block: drei Zusatzfelder auf Party-Ebene (Gruppe "POS & Pay Details").
// Tariftyp ist ein Auswahlfeld (LIST) -> selectedValueId muss über die Definition
// aufgelöst werden, Faktor/TXN fix sind einfache Zahlenfelder (DECIMAL).
const TARIFTYP_ATTRIBUTE_ID = '2544378';
const FAKTOR_ATTRIBUTE_ID = '2544383';
const TXN_FIX_ATTRIBUTE_ID = '2544394';

function findeCustomAttribute(party, attributeDefinitionId) {
  return (party.customAttributes || []).find(
    (a) => a.attributeDefinitionId === attributeDefinitionId
  );
}

// Löst eine Ticketnummer zur internen partyId auf, inkl. Betreff und
// Ansprechpartner - damit der Nutzer vor dem eigentlichen Laden sieht, ob er
// am richtigen Ticket/Kunden ist. Kein Fallback auf Kundennummer mehr: ein
// Angebot bezieht sich laut Vorgabe immer zwingend auf ein Ticket. Hat das
// Ticket keine verknüpfte Firma, kann folgerichtig kein Angebot erstellt werden.
async function loeseTicketAuf(ticketNummer) {
  const ticketTreffer = await weclapp(
    `/ticket?ticketNumber-eq=${encodeURIComponent(ticketNummer)}`
  );
  const ticket = (ticketTreffer.result || [])[0];

  if (!ticket) {
    throw new HandledError(404, `Kein Ticket mit der Nummer "${ticketNummer}" gefunden.`);
  }
  if (!ticket.partyId) {
    throw new HandledError(422, `Ticket "${ticketNummer}" hat keine verknüpfte Firma - Angebot nicht möglich.`);
  }

  const [party, kontakt] = await Promise.all([
    weclapp(`/party/id/${ticket.partyId}`),
    ticket.contactId
      ? weclapp(`/party/id/${ticket.contactId}`).catch(() => null)
      : Promise.resolve(null)
  ]);

  return {
    partyId: ticket.partyId,
    ticketId: ticket.id,
    ticketNummer: ticket.ticketNumber,
    ticketBetreff: ticket.subject || null,
    kunde: party.company,
    ansprechpartner: kontakt ? [kontakt.firstName, kontakt.lastName].filter(Boolean).join(' ') : null
  };
}

async function ladePayment(party) {
  const tariftypAttr = findeCustomAttribute(party, TARIFTYP_ATTRIBUTE_ID);
  const faktorAttr = findeCustomAttribute(party, FAKTOR_ATTRIBUTE_ID);
  const txnFixAttr = findeCustomAttribute(party, TXN_FIX_ATTRIBUTE_ID);

  // Tariftyp-Definition immer laden (nicht nur bei vorhandener Auswahl), damit das
  // Frontend die komplette Optionsliste für ein editierbares Auswahlfeld bekommt.
  const tariftypDefinition = await weclapp(`/customAttributeDefinition/id/${TARIFTYP_ATTRIBUTE_ID}`);
  const tariftypOptionen = (tariftypDefinition.selectableValues || []).map((w) => ({
    id: w.id,
    value: w.value
  }));

  return {
    tariftyp: {
      selectedId: (tariftypAttr && tariftypAttr.selectedValueId) || null,
      optionen: tariftypOptionen
    },
    faktor: faktorAttr && faktorAttr.numberValue != null ? parseFloat(faktorAttr.numberValue) : null,
    kostenProTransaktion: txnFixAttr && txnFixAttr.numberValue != null ? parseFloat(txnFixAttr.numberValue) : null
  };
}

// Setzt oder ersetzt einen customAttributes-Eintrag anhand seiner attributeDefinitionId -
// gemeinsam genutzt für Modul-Blöcke (entityReferences) und Payment-Felder (selectedValueId/numberValue).
function setzeCustomAttribute(customAttributes, attributeDefinitionId, felder) {
  const index = customAttributes.findIndex(
    (a) => a.attributeDefinitionId === attributeDefinitionId
  );
  if (index >= 0) {
    customAttributes[index] = { ...customAttributes[index], ...felder };
  } else {
    customAttributes.push({ attributeDefinitionId, ...felder });
  }
}

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
    zeitaufwand: ermittleZeitaufwand(article),
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

async function handleGet(partyId, ticketId) {
  const [katalog, party, ticket] = await Promise.all([
    ladeKatalog(),
    weclapp(`/party/id/${partyId}`),
    ticketId ? weclapp(`/ticket/id/${ticketId}`).catch(() => null) : Promise.resolve(null)
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

  // Zeitaufwand-Summe: über alle aktuell ausgewählten Artikel in den vier
  // "oberen" Blöcken (kostenpflichtig/enthalten/kauf/vorhanden), NICHT über
  // die Dienstleistungsartikel selbst - dient dort nur als Orientierungswert.
  let zeitaufwandSumme = 0;
  for (const blockName of Object.keys(BLOCK_ATTRIBUTE_IDS)) {
    for (const eintrag of blocksMitDetails[blockName]) {
      zeitaufwandSumme += eintrag.zeitaufwand || 0;
    }
  }

  // Dienstleistungen-Block hat (noch) kein eigenes Party-Feld zur Speicherung -
  // deshalb bei jedem Laden frisch mit den vier Standardartikeln in fester
  // Reihenfolge vorbelegt, jeweils mit Menge 1,00 als Startwert.
  const dienstleistungKatalog = katalog.filter((a) => (a.erlaubteBloecke || []).includes('dienstleistung'));
  const dienstleistungStandard = STANDARD_DIENSTLEISTUNG_ARTIKELNUMMERN
    .map((nr) => dienstleistungKatalog.find((a) => a.articleNumber === nr))
    .filter(Boolean)
    .map((a) => ({ ...a, quantity: 1 }));

  const payment = await ladePayment(party);

  // Ticket-Info nur, wenn eine ticketId mitgegeben wurde (z.B. aus der
  // Ticketsuche oder künftig direkt aus Leadstarts Link). Ohne ticketId
  // bleibt dieser Teil einfach leer - kein Pflichtbestandteil.
  let ticketInfo = null;
  if (ticket) {
    const kontakt = ticket.contactId
      ? await weclapp(`/party/id/${ticket.contactId}`).catch(() => null)
      : null;
    ticketInfo = {
      beschreibung: ticket.description || null,
      ansprechpartner: kontakt ? [kontakt.firstName, kontakt.lastName].filter(Boolean).join(' ') : null,
      telefon: kontakt ? kontakt.phone : null
    };
  }

  return {
    party: { id: party.id, company: party.company },
    katalog,
    blocks: { ...blocksMitDetails, dienstleistung: dienstleistungStandard },
    zeitaufwandSumme,
    payment,
    ticket: ticketInfo
  };
}

async function handlePut(partyId, body) {
  const { blocks, payment } = body;
  if (!blocks) {
    throw new Error('Body benötigt Feld "blocks".');
  }

  // weclapp verlangt das vollständige Objekt bei PUT – deshalb erst komplett laden.
  const party = await weclapp(`/party/id/${partyId}`);
  const customAttributes = party.customAttributes || [];

  for (const [blockName, attributeDefinitionId] of Object.entries(BLOCK_ATTRIBUTE_IDS)) {
    const ids = blocks[blockName] || [];
    const entityReferences = ids.map((id) => ({ entityId: id, entityName: 'article' }));
    setzeCustomAttribute(customAttributes, attributeDefinitionId, { entityReferences });
  }

  if (payment) {
    if (payment.tariftypId !== undefined) {
      setzeCustomAttribute(customAttributes, TARIFTYP_ATTRIBUTE_ID, {
        selectedValueId: payment.tariftypId || null
      });
    }
    if (payment.faktor !== undefined) {
      setzeCustomAttribute(customAttributes, FAKTOR_ATTRIBUTE_ID, {
        numberValue: payment.faktor
      });
    }
    if (payment.kostenProTransaktion !== undefined) {
      setzeCustomAttribute(customAttributes, TXN_FIX_ATTRIBUTE_ID, {
        numberValue: payment.kostenProTransaktion
      });
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

  // Auth-Daten kommen bei GET als Query-Parameter, bei PUT zusätzlich aus dem
  // Body (damit Speichern nicht an einer zu langen Query-String-Grenze scheitert).
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

  const params = event.queryStringParameters || {};

  try {
    // Einstieg über Ticketnummer: löst zu partyId auf, liefert Betreff/Kunde/
    // Ansprechpartner zur Bestätigung zurück - lädt NOCH NICHT den ganzen Katalog.
    if (event.httpMethod === 'GET' && params.ticketnummer) {
      const daten = await loeseTicketAuf(params.ticketnummer);
      return { statusCode: 200, headers, body: JSON.stringify(daten) };
    }

    const partyId = params.partyId;
    if (!partyId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ fehler: 'Query-Parameter partyId oder ticketnummer fehlt.' })
      };
    }

    if (event.httpMethod === 'GET') {
      const daten = await handleGet(partyId, params.ticketId);
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
    const statusCode = error instanceof HandledError ? error.statusCode : 500;
    return {
      statusCode,
      headers,
      body: JSON.stringify({ fehler: error.message })
    };
  }
};
