// Angebotskonfigurator – Frontend-Logik
//
// Erwartet ?partyId=... in der URL (analog zum "Angebot erstellen"-Button aus Leadstart,
// der die Firma bereits kennt und hier nichts erneut abgefragt werden muss).

const FUNCTION_URL = '/.netlify/functions/angebotskonfigurator';
const BLOCK_NAMES = ['kostenpflichtig', 'enthalten', 'kauf', 'vorhanden'];

const state = {
  partyId: null,
  katalog: [],
  blocks: { kostenpflichtig: [], enthalten: [], kauf: [], vorhanden: [] },
  unsavedChanges: false
};

function formatPreis(value) {
  return value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function markiereUngespeichert() {
  state.unsavedChanges = true;
  document.getElementById('save-button').disabled = false;
}

function markiereGespeichert() {
  state.unsavedChanges = false;
  document.getElementById('save-button').disabled = true;
}

async function ladeDaten(partyId) {
  const response = await fetch(`${FUNCTION_URL}?partyId=${encodeURIComponent(partyId)}`);
  if (!response.ok) {
    throw new Error(`Laden fehlgeschlagen (${response.status})`);
  }
  return response.json();
}

async function speichereDaten(partyId) {
  const blocksAlsIds = {};
  for (const blockName of BLOCK_NAMES) {
    blocksAlsIds[blockName] = state.blocks[blockName].map((eintrag) => eintrag.articleId);
  }

  const response = await fetch(`${FUNCTION_URL}?partyId=${encodeURIComponent(partyId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks: blocksAlsIds })
  });

  if (!response.ok) {
    throw new Error(`Speichern fehlgeschlagen (${response.status})`);
  }
  return response.json();
}

function renderKatalog(filterText = '') {
  const liste = document.getElementById('catalog-list');
  liste.innerHTML = '';

  const gefiltert = state.katalog.filter((a) =>
    a.name.toLowerCase().includes(filterText.toLowerCase())
  );

  for (const artikel of gefiltert) {
    const li = document.createElement('li');
    li.className = 'catalog-item';

    const kopf = document.createElement('div');
    kopf.style.display = 'flex';
    kopf.style.justifyContent = 'space-between';
    kopf.style.width = '100%';

    const name = document.createElement('span');
    name.className = 'catalog-item__name';
    name.textContent = artikel.name;

    const preis = document.createElement('span');
    preis.className = 'catalog-item__price';
    preis.textContent = formatPreis(artikel.price);

    kopf.append(name, preis);

    const addRow = document.createElement('div');
    addRow.className = 'catalog-item__add';
    for (const blockName of BLOCK_NAMES) {
      const btn = document.createElement('button');
      btn.textContent = '+ ' + blockName;
      btn.addEventListener('click', () => fuegeZuBlockHinzu(blockName, artikel));
      addRow.appendChild(btn);
    }

    li.append(kopf, addRow);
    liste.appendChild(li);
  }
}

function fuegeZuBlockHinzu(blockName, artikel) {
  const bereitsDrin = state.blocks[blockName].some((a) => a.articleId === artikel.articleId);
  if (bereitsDrin) return;

  state.blocks[blockName].push(artikel);
  markiereUngespeichert();
  renderBloecke();
}

function entferneAusBlock(blockName, articleId) {
  state.blocks[blockName] = state.blocks[blockName].filter((a) => a.articleId !== articleId);
  markiereUngespeichert();
  renderBloecke();
}

function verschiebe(blockName, index, richtung) {
  const liste = state.blocks[blockName];
  const zielIndex = index + richtung;
  if (zielIndex < 0 || zielIndex >= liste.length) return;

  [liste[index], liste[zielIndex]] = [liste[zielIndex], liste[index]];
  markiereUngespeichert();
  renderBloecke();
}

function berechneSumme(blockName) {
  return state.blocks[blockName].reduce((summe, a) => summe + a.price, 0);
}

function renderBloecke() {
  for (const blockName of BLOCK_NAMES) {
    const liste = document.querySelector(`[data-block-list="${blockName}"]`);
    liste.innerHTML = '';

    state.blocks[blockName].forEach((artikel, index) => {
      const li = document.createElement('li');
      li.className = 'block-item';

      const name = document.createElement('span');
      name.className = 'block-item__name';
      name.textContent = artikel.name;

      const preis = document.createElement('span');
      preis.className = 'block-item__price';
      preis.textContent = blockName === 'vorhanden' ? formatPreis(0) : formatPreis(artikel.price);

      const controls = document.createElement('div');
      controls.className = 'block-item__controls';

      const hoch = document.createElement('button');
      hoch.textContent = '↑';
      hoch.title = 'Nach oben verschieben';
      hoch.disabled = index === 0;
      hoch.addEventListener('click', () => verschiebe(blockName, index, -1));

      const runter = document.createElement('button');
      runter.textContent = '↓';
      runter.title = 'Nach unten verschieben';
      runter.disabled = index === state.blocks[blockName].length - 1;
      runter.addEventListener('click', () => verschiebe(blockName, index, 1));

      const entfernen = document.createElement('button');
      entfernen.textContent = '×';
      entfernen.className = 'remove';
      entfernen.title = 'Entfernen';
      entfernen.addEventListener('click', () => entferneAusBlock(blockName, artikel.articleId));

      controls.append(hoch, runter, entfernen);
      li.append(name, preis, controls);
      liste.appendChild(li);
    });

    const summenFeld = document.querySelector(`[data-block-sum="${blockName}"]`);
    if (summenFeld && (blockName === 'kostenpflichtig' || blockName === 'kauf')) {
      summenFeld.textContent = formatPreis(berechneSumme(blockName));
    }
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const partyId = params.get('partyId');

  if (!partyId) {
    document.getElementById('party-name').textContent = 'Kein partyId in der URL angegeben.';
    return;
  }

  state.partyId = partyId;

  try {
    const daten = await ladeDaten(partyId);
    state.katalog = daten.katalog;
    state.blocks = daten.blocks;

    document.getElementById('party-name').textContent = daten.party.company;
    renderKatalog();
    renderBloecke();
  } catch (error) {
    document.getElementById('party-name').textContent = 'Fehler beim Laden: ' + error.message;
  }

  document.getElementById('catalog-search').addEventListener('input', (e) => {
    renderKatalog(e.target.value);
  });

  document.getElementById('save-button').addEventListener('click', async () => {
    const button = document.getElementById('save-button');
    button.disabled = true;
    button.textContent = 'Speichert …';
    try {
      await speichereDaten(state.partyId);
      markiereGespeichert();
      button.textContent = 'Speichern';
    } catch (error) {
      button.textContent = 'Fehler – erneut versuchen';
      button.disabled = false;
      console.error(error);
    }
  });
}

init();
