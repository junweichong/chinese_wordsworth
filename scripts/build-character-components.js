const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataDirectory = path.join(__dirname, '..', 'data', 'character-components');
const sourceDirectory = path.join(dataDirectory, 'sources');
const dictionaryPath = path.join(sourceDirectory, 'makemeahanzi-dictionary.txt');
const unihanPath = path.join(sourceDirectory, 'Unihan_OtherMappings.txt');
const cjkviPath = path.join(sourceDirectory, 'cjkvi-ids.txt');
const outputPath = path.join(dataDirectory, 'index.json');
const sourceHashes = {
  'makemeahanzi-dictionary.txt': '744bb05d5b0742e9ee35c37791f94d56a173349b3367569e7ca11e510364d203',
  'Unihan_OtherMappings.txt': 'fc7bbb8f923fa1e922a4d421aa15387d1c68250cc5e7619bdf81f575ab38472b',
  'cjkvi-ids.txt': 'bfc70a8c09f9f5616ebf0543bd6681e67314e9f7ae2307e5ae8c6f15bdc5c6a6'
};
const unknownMarker = String.fromCodePoint(0xff1f);
const operators = Array.from({ length: 12 }, (_, index) => ({
  symbol: String.fromCodePoint(0x2ff0 + index),
  name: [
    'left-right', 'above-below', 'left-middle-right', 'above-middle-below',
    'full-enclosure', 'enclosure-from-above', 'enclosure-from-below',
    'enclosure-from-left', 'enclosure-from-upper-left', 'enclosure-from-upper-right',
    'enclosure-from-lower-left', 'overlay'
  ][index],
  arity: index === 2 || index === 3 ? 3 : 2
}));
const operatorBySymbol = new Map(operators.map(operator => [operator.symbol, operator]));
const aliases = new Map([
  [String.fromCodePoint(0x4ebb), String.fromCodePoint(0x4eba)],
  [String.fromCodePoint(0x6c35), String.fromCodePoint(0x6c34)],
  [String.fromCodePoint(0x72ad), String.fromCodePoint(0x72ac)]
]);

function readCharacterRanks(filePath) {
  const ranks = new Map();
  const ranksSeen = new Set();
  const expression = /^U\+([0-9A-F]+)\s+kTGH\s+2013:(\d+)$/;

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(expression);
    if (!match) continue;
    const rank = Number(match[2]);
    if (rank < 1 || rank > 6500) continue;

    const character = String.fromCodePoint(Number.parseInt(match[1], 16));
    assert(!ranks.has(character), `Duplicate table entry for ${character}`);
    assert(!ranksSeen.has(rank), `Duplicate table rank ${rank}`);
    ranks.set(character, rank);
    ranksSeen.add(rank);
  }

  assert.equal(ranks.size, 6500, 'Expected the 6,500 Tier 1 and Tier 2 table characters');
  for (let rank = 1; rank <= 6500; rank++) {
    assert(ranksSeen.has(rank), `Missing table rank ${rank}`);
  }
  return ranks;
}

function readSourceDictionary(filePath) {
  const entries = new Map();
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const entry = JSON.parse(line);
    assert(!entries.has(entry.character), `Duplicate dictionary entry for ${entry.character}`);
    entries.set(entry.character, entry);
  }
  return entries;
}

function readCjkviIds(filePath) {
  const entries = new Map();
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const char = parts[1];
      const ids = parts[2].split('[')[0].trim();
      entries.set(char, ids);
    }
  }
  return entries;
}

function parseIds(ids) {
  const symbols = Array.from(ids);
  let position = 0;

  function parseNode() {
    const symbol = symbols[position++];
    assert(symbol, `Unexpected end of IDS: ${ids}`);
    const operator = operatorBySymbol.get(symbol);
    if (!operator) return { character: symbol };
    return {
      operator: symbol,
      components: Array.from({ length: operator.arity }, parseNode)
    };
  }

  const tree = parseNode();
  assert.equal(position, symbols.length, `Unexpected trailing IDS data: ${ids}`);
  return tree;
}

function codePointCompare(left, right) {
  const leftPoints = Array.from(left, character => character.codePointAt(0));
  const rightPoints = Array.from(right, character => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function addLeafCounts(node, counts) {
  if (node.character) {
    if (node.character !== unknownMarker && node.character !== '?') {
      counts.set(node.character, (counts.get(node.character) || 0) + 1);
    }
    return;
  }
  node.components.forEach(child => addLeafCounts(child, counts));
}

function sequenceMatchesCharacter(result, tiles, records) {
  function matchCharacter(character, start, end, visiting) {
    const record = records.get(character);
    if (!record?.complete || !record.tree) return false;
    const key = `${character}:${start}:${end}`;
    if (visiting.has(key)) return false;
    visiting.add(key);
    const matches = matchNode(record.tree, start, end, visiting);
    visiting.delete(key);
    return matches;
  }

  function matchNode(node, start, end, visiting) {
    if (node.character) {
      if (end === start + 1 && tiles[start] === node.character) return true;
      if (node.character === unknownMarker || node.character === '?') return false;
      return matchCharacter(node.character, start, end, visiting);
    }

    function matchComponents(componentIndex, position) {
      if (componentIndex === node.components.length) return position === end;
      const remainingComponents = node.components.length - componentIndex - 1;
      for (let nextPosition = position + 1; nextPosition <= end - remainingComponents; nextPosition++) {
        if (matchNode(node.components[componentIndex], position, nextPosition, visiting)
          && matchComponents(componentIndex + 1, nextPosition)) return true;
      }
      return false;
    }

    return matchComponents(0, start);
  }

  return matchCharacter(result, 0, tiles.length, new Set());
}

function verifyExamples(records) {
  const chars = points => String.fromCodePoint(...points);
  const examples = [
    { result: chars([0x8349]), ids: `${String.fromCodePoint(0x2ff1)}艹早`, tiles: '艹日十' },
    { result: chars([0x65e9]), ids: `${String.fromCodePoint(0x2ff1)}日十`, tiles: '日十' },
    { result: chars([0x660e]), ids: `${String.fromCodePoint(0x2ff0)}日月`, tiles: '日月' },
    { result: chars([0x6797]), ids: `${String.fromCodePoint(0x2ff0)}木木`, tiles: '木木' },
    { result: chars([0x7433]), ids: `${String.fromCodePoint(0x2ff0)}王林`, tiles: '王木木' },
    { result: chars([0x95f7]), ids: `${String.fromCodePoint(0x2ff5)}门心`, tiles: '门心' },
    { result: chars([0x82d7]), ids: `${String.fromCodePoint(0x2ff1)}艹田`, tiles: '艹田' }
  ];

  for (const example of examples) {
    const record = records.get(example.result);
    assert(record, `Missing required example ${example.result}`);
    assert.equal(record.ids, example.ids, `Unexpected IDS for ${example.result}`);
    assert(sequenceMatchesCharacter(example.result, Array.from(example.tiles), records), `Invalid component sequence for ${example.result}`);
  }
}

for (const [name, expectedHash] of Object.entries(sourceHashes)) {
  const filePath = path.join(sourceDirectory, name);
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  assert.equal(actualHash, expectedHash, `Source file changed: ${name}`);
}

const characterRanks = readCharacterRanks(unihanPath);
const sourceEntries = readSourceDictionary(dictionaryPath);
const cjkviEntries = readCjkviIds(cjkviPath);
const leafCounts = new Map();
const records = new Map();

for (const [character, rank] of characterRanks) {
  const source = sourceEntries.get(character);
  let ids = source?.decomposition || null;
  let complete = Boolean(ids) && !ids.includes(unknownMarker) && !ids.includes('?');

  if (!complete) {
    const fallbackIds = cjkviEntries.get(character);
    if (fallbackIds && !fallbackIds.includes(unknownMarker) && !fallbackIds.includes('?')) {
      ids = fallbackIds;
      complete = true;
    }
  }

  assert(ids, `Missing decomposition for ${character}`);
  const tree = ids ? parseIds(ids) : null;
  const record = { character, rank, ids, tree, complete };
  records.set(character, record);
  if (tree) addLeafCounts(tree, leafCounts);
}

verifyExamples(records);

const tokens = new Map();
for (const [character, rank] of characterRanks) {
  tokens.set(character, {
    symbol: character,
    roles: ['character'],
    tableRank: rank,
    componentOccurrences: leafCounts.get(character) || 0,
    canonicalCharacter: aliases.get(character) || null
  });
}
for (const [symbol, occurrences] of leafCounts) {
  if (tokens.has(symbol)) {
    tokens.get(symbol).roles.push('component');
  } else {
    tokens.set(symbol, {
      symbol,
      roles: ['component-form'],
      tableRank: null,
      componentOccurrences: occurrences,
      canonicalCharacter: aliases.get(symbol) || null
    });
  }
}

const characters = [...records.values()].sort((left, right) => left.rank - right.rank);
const componentTokens = [...tokens.values()].sort((left, right) => codePointCompare(left.symbol, right.symbol));
const completeCount = characters.filter(record => record.complete).length;
const payload = {
  schemaVersion: 1,
  scope: {
    table: '通用规范汉字表 / Table of General Standard Chinese Characters',
    year: 2013,
    tier: '1-2',
    firstRank: 1,
    lastRank: 6500,
    characterCount: characters.length,
    completeDecompositionCount: completeCount,
    incompleteDecompositionCount: characters.length - completeCount
  },
  sources: {
    decompositions: 'Make Me a Hanzi dictionary.txt with CJKVI IDS fallback for missing/incomplete entries',
    characterScope: 'Unicode 18.0.0 Unihan kTGH property; 2013 ranks 1-6500'
  },
  operators,
  aliases: [...aliases].map(([component, character]) => ({ component, character })),
  characters,
  componentTokens,
  incomplete: characters.filter(record => !record.complete).map(({ character, rank, ids }) => ({ character, rank, ids }))
};

fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Wrote ${characters.length} characters, ${componentTokens.length} tokens (${completeCount} complete decompositions).`);
