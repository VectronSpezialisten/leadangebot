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
  vorhanden: '2543133',
  tariftyp: '2571338'
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
  '2568640': 'dienstleistung',
  '2571192': 'texte',
  '2571309': 'tariftyp'
};

// Diese zwei Text-Artikel werden bei jedem Laden als Standardbestückung des
// Texte-Blocks vorgeschlagen. Impressum ist ZWINGEND und im Frontend nicht
// entfernbar (siehe TEXTE_PFLICHT_ARTIKELNUMMERN), AGB ist nur Vorschlag.
const STANDARD_TEXTE_ARTIKELNUMMERN = ['agb', 'imp'];
const TEXTE_PFLICHT_ARTIKELNUMMERN = ['imp'];

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

// Payment-Block: zwei Zusatzfelder auf Party-Ebene (Gruppe "POS & Pay Details").
// Tariftyp lief früher hier als Auswahlfeld (LIST) - läuft jetzt als normaler
// Artikel-Block über BLOCK_ATTRIBUTE_IDS.tariftyp, genau wie die Module.
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
  const faktorAttr = findeCustomAttribute(party, FAKTOR_ATTRIBUTE_ID);
  const txnFixAttr = findeCustomAttribute(party, TXN_FIX_ATTRIBUTE_ID);

  return {
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
    beschreibung: article.longText || null,
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

// ---------- Angebots-Inhalt (E-Mail) generieren ----------
//
// Bewusst tabellenbasiert mit Inline-Styles (kein Flexbox/Grid, keine externen
// Fonts) - das ist die einzige Bauweise, die in allen gängigen Mail-Clients
// (inkl. Outlook Desktop, das viel modernes CSS ignoriert) zuverlässig
// gleich aussieht. Kompakt gehalten, damit keine PDF zum Lesen nötig ist.

function formatPreisServer(wert) {
  return wert.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function renderArtikelZeilen(artikel, mitPreis) {
  if (artikel.length === 0) {
    return '<tr><td style="padding:4px 0;color:#737373;font-style:italic;font-size:13px;">Keine Artikel</td></tr>';
  }
  return artikel.map((a) => {
    const preisZelle = mitPreis
      ? `<td style="padding:4px 0;text-align:right;font-size:13px;color:#404040;white-space:nowrap;">${formatPreisServer(a.price)}</td>`
      : '';
    return `<tr>
      <td style="padding:4px 0;font-size:13px;color:#171717;">${a.name}</td>
      ${preisZelle}
    </tr>`;
  }).join('');
}

function renderModulBlock(titel, artikel, mitPreis, summe) {
  const summenZeile = summe != null
    ? `<tr><td style="padding-top:6px;border-top:1px solid #d4d4d4;font-size:13px;font-weight:600;">Summe</td>
         <td style="padding-top:6px;border-top:1px solid #d4d4d4;text-align:right;font-size:13px;font-weight:600;">${formatPreisServer(summe)}</td></tr>`
    : '';

  return `
    <tr><td colspan="2" style="padding:20px 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#737373;border-bottom:1px solid #d4d4d4;">${titel}</td></tr>
    <tr><td colspan="2">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${renderArtikelZeilen(artikel, mitPreis)}
        ${summenZeile}
      </table>
    </td></tr>
  `;
}

function berechneSummeServer(artikel) {
  return artikel.reduce((s, a) => s + a.price, 0);
}

function berechneSummeDienstleistungServer(artikel) {
  return artikel.reduce((s, a) => s + (a.price * (a.quantity || 0)), 0);
}

function generiereAngebotsHtml(daten) {
  const blocks = daten.blocks;
  const payment = daten.payment || {};
  const ticket = daten.ticket || {};

  const summeKostenpflichtig = berechneSummeServer(blocks.kostenpflichtig);
  const summeKauf = berechneSummeServer(blocks.kauf);
  const summeDienstleistung = berechneSummeDienstleistungServer(blocks.dienstleistung);
  const gesamtMonatlich = summeKostenpflichtig;
  const gesamtEinmalig = summeKauf + summeDienstleistung;

  const dienstleistungMitPreisZeilen = blocks.dienstleistung.length === 0
    ? '<tr><td style="padding:4px 0;color:#737373;font-style:italic;font-size:13px;">Keine Artikel</td></tr>'
    : blocks.dienstleistung.map((a) => `
        <tr>
          <td style="padding:4px 0;font-size:13px;color:#171717;">${a.name} (${(a.quantity || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x)</td>
          <td style="padding:4px 0;text-align:right;font-size:13px;color:#404040;white-space:nowrap;">${formatPreisServer(a.price * (a.quantity || 0))}</td>
        </tr>
      `).join('');

  const anrede = ticket.ansprechpartner ? `Guten Tag ${ticket.ansprechpartner},` : 'Guten Tag,';
  // Intro-Text kommt aus dem Artikellangtext des Artikels "intro" (in weclapp
  // gepflegt, wie AGB/Impressum) - Firmenname wird automatisch angehängt.
  // Fallback auf einen statischen Text, falls der Artikel (noch) nicht existiert.
  const introBasisRoh = daten.introText || 'vielen Dank für Ihr Interesse an Vectron Smart4Pay. Nachfolgend finden Sie Ihr individuelles Angebot für';
  // Abschließende Absatz-/Umbruch-Tags entfernen, damit der fett angehängte
  // Firmenname direkt im selben Textfluss landet statt auf einer neuen Zeile.
  const introBasis = introBasisRoh.replace(/(<\/p>|<br\s*\/?>|\s)+$/i, '');
  const introText = `${introBasis} <strong>${daten.party.company}</strong>.`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  /* Fluid statt fest 600px breit - verhindert horizontales Scrollen auf
     schmalen Bildschirmen (Smartphone-Mailclients, aber auch die Vorschau
     hier im Konfigurator). Auf Desktop bleibt es optisch bei ca. 600px. */
  @media only screen and (max-width: 620px) {
    .email-padding { padding: 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%; max-width:600px; background:#ffffff;border-radius:8px;color:#171717;">
<tr><td class="email-padding" style="padding:32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">

  <!-- Kopf -->
  <tr><td style="font-size:13px;line-height:1.5;padding-bottom:16px;">
    ${anrede}<br>
    ${introText}
  </td></tr>

  <!-- Ergebnis der Konfiguration -->
  <tr><td>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${renderModulBlock('Module kostenpflichtig', blocks.kostenpflichtig, true, summeKostenpflichtig)}
      ${renderModulBlock('Module enthalten', blocks.enthalten, false, null)}
      ${renderModulBlock('Module Kauf', blocks.kauf, true, summeKauf)}
      ${renderModulBlock('Module vorhanden', blocks.vorhanden, false, null)}

      <tr><td colspan="2" style="padding:20px 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#737373;border-bottom:1px solid #d4d4d4;">Dienstleistung</td></tr>
      <tr><td colspan="2">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          ${dienstleistungMitPreisZeilen}
          <tr><td style="padding-top:6px;border-top:1px solid #d4d4d4;font-size:13px;font-weight:600;">Summe</td>
              <td style="padding-top:6px;border-top:1px solid #d4d4d4;text-align:right;font-size:13px;font-weight:600;">${formatPreisServer(summeDienstleistung)}</td></tr>
        </table>
      </td></tr>

      <tr><td colspan="2" style="padding:20px 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#737373;border-bottom:1px solid #d4d4d4;">Payment</td></tr>
      <tr><td colspan="2">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
          <tr><td style="padding:3px 0;color:#404040;">Tariftyp</td><td style="padding:3px 0;text-align:right;">${(blocks.tariftyp && blocks.tariftyp[0] && blocks.tariftyp[0].name) || '–'}</td></tr>
          <tr><td style="padding:3px 0;color:#404040;">Serviceentgelt</td><td style="padding:3px 0;text-align:right;">${payment.faktor != null ? payment.faktor.toString().replace('.', ',') + '%' : '–'}</td></tr>
          <tr><td style="padding:3px 0;color:#404040;">Kosten je Transaktion</td><td style="padding:3px 0;text-align:right;">${payment.kostenProTransaktion != null ? formatPreisServer(payment.kostenProTransaktion) : '–'}</td></tr>
        </table>
      </td></tr>
      ${(blocks.tariftyp && blocks.tariftyp[0] && blocks.tariftyp[0].beschreibung) ? `
      <tr><td colspan="2" style="padding-top:10px;font-size:12px;line-height:1.5;color:#737373;">
        ${blocks.tariftyp[0].beschreibung}
      </td></tr>` : ''}

      <tr><td colspan="2" style="padding:20px 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#737373;border-bottom:1px solid #d4d4d4;">Abschluss</td></tr>
      <tr><td colspan="2">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;font-weight:600;">
          <tr><td style="padding:4px 0;">Gesamt monatlich</td><td style="padding:4px 0;text-align:right;">${formatPreisServer(gesamtMonatlich)}</td></tr>
          <tr><td style="padding:4px 0;">Gesamt einmalig</td><td style="padding:4px 0;text-align:right;">${formatPreisServer(gesamtEinmalig)}</td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- Fuß-Ersatz: 1) Hinweise, 2) Texte (konfigurierte Reihenfolge, ohne Impressum),
       3) Impressum immer zuletzt, zentriert. Kein statischer Signaturtext mehr. -->
  ${daten.hinweise ? `
  <tr><td style="padding-top:28px;border-top:1px solid #d4d4d4;font-size:13px;line-height:1.5;color:#171717;">
    ${daten.hinweise}
  </td></tr>` : ''}

  ${(daten.blocks.texte || []).filter((t) => t.articleNumber !== 'imp').map((t, i, arr) => {
    const istAgb = t.articleNumber === 'agb';
    const groesse = istAgb ? '11px' : '13px';
    const farbe = istAgb ? '#737373' : '#171717';
    return `
    <tr><td style="padding-top:${(!daten.hinweise && i === 0) ? '28' : '20'}px;${(!daten.hinweise && i === 0) ? 'border-top:1px solid #d4d4d4;' : ''}font-size:${groesse};line-height:1.5;color:${farbe};">
      ${t.beschreibung || ''}
    </td></tr>
  `;
  }).join('')}

  ${(() => {
    const impressum = (daten.blocks.texte || []).find((t) => t.articleNumber === 'imp');
    if (!impressum) return '';
    const keineVorherigenElemente = !daten.hinweise && (daten.blocks.texte || []).filter((t) => t.articleNumber !== 'imp').length === 0;
    return `
    <tr><td style="padding-top:${keineVorherigenElemente ? '28' : '20'}px;${keineVorherigenElemente ? 'border-top:1px solid #d4d4d4;' : ''}font-size:11px;line-height:1.5;color:#737373;text-align:center;">
      ${impressum.beschreibung || ''}
    </td></tr>`;
  })()}

</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Löst Ticket + Ansprechpartner zu den Feldern auf, die fürs Info-Panel UND
// für den E-Mail-Kopf/Empfänger gebraucht werden. Eigenständig, damit sowohl
// handleGet (Editor laden) als auch die Vorschau (ohne Speichern) das nutzen
// können, ohne Logik zu duplizieren.
// Letzten Kommentar eines Tickets holen - für die Info-Panel-Anzeige beim
// direkten Wechsel Leadstart -> Angebotskonfigurator (Leadstart schreibt die
// erste Notiz als Kommentar, nicht in die Ticket-Beschreibung). Robust: falls
// der entityId/entityName-Filter doch nicht wie erwartet greift, bleibt das
// Feld einfach leer statt die ganze Seite crashen zu lassen.
async function ladeLetztenKommentar(ticketId) {
  if (!ticketId) return null;
  try {
    const response = await weclapp(
      `/comment?entityName=ticket&entityId=${encodeURIComponent(ticketId)}&sort=-createdDate&pageSize=1`
    );
    const letzter = (response.result || [])[0];
    return letzter ? letzter.comment : null;
  } catch {
    return null;
  }
}

// Intro-Text für den E-Mail-Kopf kommt aus dem Artikellangtext des Artikels
// mit articleNumber "intro" (analog zu agb/imp) - robust gegen fehlenden
// Artikel (z.B. noch nicht angelegt), dann greift der Fallback-Text.
async function ladeIntroText() {
  try {
    const response = await weclapp(`/article?articleNumber-eq=intro`);
    const artikel = (response.result || [])[0];
    return artikel ? artikel.longText : null;
  } catch {
    return null;
  }
}

async function loeseTicketInfo(ticket) {
  if (!ticket) return null;

  const [kontakt, letzterKommentar] = await Promise.all([
    ticket.contactId
      ? weclapp(`/party/id/${ticket.contactId}`).catch(() => null)
      : Promise.resolve(null),
    ladeLetztenKommentar(ticket.id)
  ]);

  return {
    ticketId: ticket.id,
    ticketNummer: ticket.ticketNumber || null,
    betreff: ticket.subject || null,
    beschreibung: ticket.description || null,
    letzterKommentar,
    ansprechpartner: kontakt ? [kontakt.firstName, kontakt.lastName].filter(Boolean).join(' ') : null,
    ansprechpartnerVorname: kontakt ? kontakt.firstName : null,
    telefon: kontakt ? kontakt.mobilePhone1 : null,
    email: kontakt ? kontakt.email : null
  };
}

async function handleGet(partyId, ticketId, overrides = {}) {
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

  // Dienstleistung und Texte haben (noch) kein eigenes Party-Feld zur
  // Speicherung. Normalerweise deshalb bei jedem Laden frisch mit den
  // Standardartikeln vorbelegt - ABER: wenn overrides.dienstleistung/texte
  // mitgegeben wird (siehe "senden"-Route), wird stattdessen der tatsächliche
  // Browser-Zustand übernommen. Sonst würden Änderungen an diesen beiden
  // Blöcken beim finalen Versand ignoriert, weil hier sonst immer die
  // Standardwerte neu aufgebaut würden.
  let dienstleistungBlock = overrides.dienstleistung;
  if (!dienstleistungBlock) {
    const dienstleistungKatalog = katalog.filter((a) => (a.erlaubteBloecke || []).includes('dienstleistung'));
    dienstleistungBlock = STANDARD_DIENSTLEISTUNG_ARTIKELNUMMERN
      .map((nr) => dienstleistungKatalog.find((a) => a.articleNumber === nr))
      .filter(Boolean)
      .map((a) => ({ ...a, quantity: 1 }));
  }

  let texteBlock = overrides.texte;
  if (!texteBlock) {
    const texteKatalog = katalog.filter((a) => (a.erlaubteBloecke || []).includes('texte'));
    texteBlock = STANDARD_TEXTE_ARTIKELNUMMERN
      .map((nr) => texteKatalog.find((a) => a.articleNumber === nr))
      .filter(Boolean)
      .map((a) => ({ ...a, pflicht: TEXTE_PFLICHT_ARTIKELNUMMERN.includes(a.articleNumber) }));
  }

  const payment = await ladePayment(party);

  // Ticket-Info nur, wenn eine ticketId mitgegeben wurde (z.B. aus der
  // Ticketsuche oder künftig direkt aus Leadstarts Link). Ohne ticketId
  // bleibt dieser Teil einfach leer - kein Pflichtbestandteil.
  const ticketInfo = await loeseTicketInfo(ticket);

  return {
    party: { id: party.id, company: party.company },
    katalog,
    blocks: { ...blocksMitDetails, dienstleistung: dienstleistungBlock, texte: texteBlock },
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
    // Das alte Tariftyp-Feld (LIST) wurde entfernt und wird durch einen
    // Artikel-Bezug ersetzt (siehe TARIFTYP_MODUL_ATTRIBUTE_ID) - deshalb hier
    // bewusst kein Schreibversuch mehr auf TARIFTYP_ATTRIBUTE_ID.
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

  // Auth-Daten kommen bei GET als Query-Parameter, bei PUT/POST zusätzlich
  // aus dem Body (damit Speichern/Senden nicht an einer zu langen
  // Query-String-Grenze scheitert).
  let email;
  let passwort;

  if (event.httpMethod === 'PUT' || event.httpMethod === 'POST') {
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

    // Vorschau: liest NICHT aus weclapp gespeicherten Zustand, sondern rendert
    // direkt aus dem aktuellen Browser-Zustand (Blöcke/Payment im Body) - so
    // zeigt die Vorschau auch unsicherheitliche Änderungen, ohne vorher speichern zu müssen.
    if (event.httpMethod === 'POST' && params.aktion === 'vorschau') {
      const body = JSON.parse(event.body || '{}');

      const [party, ticket, introText] = await Promise.all([
        weclapp(`/party/id/${partyId}`),
        params.ticketId ? weclapp(`/ticket/id/${params.ticketId}`).catch(() => null) : Promise.resolve(null),
        ladeIntroText()
      ]);
      const ticketInfo = await loeseTicketInfo(ticket);

      if (!ticketInfo) {
        throw new HandledError(422, 'Ohne verknüpftes Ticket ist keine Vorschau/Versand möglich.');
      }

      const daten = {
        party: { id: party.id, company: party.company },
        blocks: body.blocks,
        payment: body.payment,
        hinweise: body.hinweise || null,
        introText,
        ticket: ticketInfo
      };
      const html = generiereAngebotsHtml(daten);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          html,
          betreff: `Ihr neues Vectron POS-System [${ticketInfo.ticketNummer || ''}]`,
          empfaengerEmail: ticketInfo.email
        })
      };
    }

    // Senden: speichert JETZT erst die aktuellen Blöcke/Payment nach weclapp
    // (bisher machte das ein separater "Speichern"-Klick vorher) und verschickt
    // direkt im Anschluss den frisch gespeicherten Stand als Mail.
    if (event.httpMethod === 'POST' && params.aktion === 'senden') {
      const body = JSON.parse(event.body || '{}');
      if (!body.blocks) {
        throw new HandledError(400, 'Body benötigt Feld "blocks" zum Speichern vor dem Versand.');
      }

      await handlePut(partyId, body);

      const [daten, introText] = await Promise.all([
        handleGet(partyId, params.ticketId, {
          dienstleistung: body.dienstleistung,
          texte: body.texte
        }),
        ladeIntroText()
      ]);
      daten.hinweise = body.hinweise || null;
      daten.introText = introText;

      if (!daten.ticket) {
        throw new HandledError(422, 'Ohne verknüpftes Ticket ist keine Vorschau/Versand möglich.');
      }
      if (!daten.ticket.email) {
        throw new HandledError(422, 'Der Ansprechpartner hat keine hinterlegte E-Mail-Adresse.');
      }
      if (!process.env.N8N_WEBHOOK_URL) {
        throw new HandledError(500, 'N8N_WEBHOOK_URL ist nicht konfiguriert.');
      }

      const html = generiereAngebotsHtml(daten);
      const betreff = `Ihr neues Vectron POS-System [${daten.ticket.ticketNummer || ''}]`;

      const webhookResponse = await fetch(process.env.N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          empfaengerEmail: daten.ticket.email,
          betreff,
          htmlInhalt: html,
          ticketId: daten.ticket.ticketId
        })
      });

      if (!webhookResponse.ok) {
        const text = await webhookResponse.text().catch(() => '');
        throw new HandledError(502, `Mailversand über n8n fehlgeschlagen: ${text || webhookResponse.status}`);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ gesendet: true }) };
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
