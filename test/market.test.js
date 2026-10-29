const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarket, refillMarketTile, getPublicMarket } = require('../market');

const stableRandom = () => 0.5;

test('creates a shuffled 20-tile market with side radicals, top radicals, and single-component characters', () => {
  const market = createMarket(stableRandom);
  assert.equal(market.length, 20);
  assert.equal(new Set(market.map(tile => tile.symbol)).size, 20);

  const sideRadicals = market.filter(tile => tile.category === 'side_radical');
  const topRadicals = market.filter(tile => tile.category === 'top_radical');
  const singleChars = market.filter(tile => tile.category === 'single_character');

  assert.equal(sideRadicals.length, 5);
  assert.equal(topRadicals.length, 3);
  assert.equal(singleChars.length, 12);
});

test('refills a selected slot from its original category pool', () => {
  const market = createMarket(stableRandom);
  const selected = market.find(tile => tile.category === 'side_radical');
  const nextMarket = refillMarketTile(market, selected.id, stableRandom);
  const replacement = nextMarket.find(tile => tile.id === selected.id);

  assert.equal(replacement.category, selected.category);
  assert.notEqual(replacement.symbol, selected.symbol);
  assert.equal(new Set(nextMarket.map(tile => tile.symbol)).size, 20);
  assert.equal(refillMarketTile(market, 'unknown-id', stableRandom), null);
});

test('public market payload contains no category or metadata', () => {
  const market = getPublicMarket(createMarket(stableRandom));
  assert.equal(market.length, 20);
  for (const tile of market) {
    assert.deepEqual(Object.keys(tile).sort(), ['id', 'symbol']);
  }
});

test('market completely refreshes with 20 new tiles on demand', () => {
  const initialMarket = createMarket();
  assert.equal(initialMarket.length, 20);

  // Calling createMarket generates a fresh full set of 20 unique tiles
  const refreshedMarket = createMarket();
  assert.equal(refreshedMarket.length, 20);
  assert.equal(new Set(refreshedMarket.map(tile => tile.symbol)).size, 20);
  assert.equal(refreshedMarket.filter(t => t.category === 'side_radical').length, 5);
  assert.equal(refreshedMarket.filter(t => t.category === 'top_radical').length, 3);
  assert.equal(refreshedMarket.filter(t => t.category === 'single_character').length, 12);
});