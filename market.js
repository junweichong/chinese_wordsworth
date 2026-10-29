const { randomUUID } = require('node:crypto');

const SIDE_RADICALS = [
  '氵', '扌', '亻', '犭', '讠', '阝', '纟', '饣', '礻', '衤',
  '木', '禾', '日', '月', '火', '土', '女', '口', '王', '石',
  '贝', '车', '足', '虫', '米', '立', '目', '弓', '耳', '身'
];

const TOP_RADICALS = [
  '艹', '宀', '⺮', '⺣', '⺌', '穴', '广', '厂', '疒', '尸',
  '户', '雨', '⺤', '炙', '爫', '亠', '冖', '⺪', '罒', '耂'
];

const SINGLE_CHARACTERS = [
  '一', '二', '三', '十', '八', '九', '六', '七', '五', '四',
  '人', '大', '小', '口', '日', '月', '水', '火', '土', '木',
  '金', '子', '女', '天', '中', '文', '立', '目', '耳', '手',
  '足', '山', '石', '田', '心', '王', '生', '门', '巾', '弓',
  '又', '力', '干', '工', '上', '下', '寸', '才', '戈', '户'
];

const POOLS = {
  side_radical: SIDE_RADICALS,
  top_radical: TOP_RADICALS,
  single_character: SINGLE_CHARACTERS
};

const CATEGORY_SLOTS = [
  { category: 'side_radical', count: 5 },
  { category: 'top_radical', count: 3 },
  { category: 'single_character', count: 12 }
];

function drawTile(category, usedSymbols, random, slotId = randomUUID()) {
  const pool = POOLS[category] || [];
  const candidates = pool.filter(symbol => !usedSymbols.has(symbol));

  if (candidates.length === 0) {
    throw new Error(`No unused tiles in the ${category} pool.`);
  }

  const selectedSymbol = candidates[Math.floor(random() * candidates.length)];

  return {
    id: slotId,
    symbol: selectedSymbol,
    category
  };
}

function shuffle(items, random) {
  for (let index = items.length - 1; index > 0; index--) {
    const otherIndex = Math.floor(random() * (index + 1));
    [items[index], items[otherIndex]] = [items[otherIndex], items[index]];
  }
  return items;
}

function createMarket(random = Math.random) {
  const plan = CATEGORY_SLOTS.flatMap(({ category, count }) =>
    Array.from({ length: count }, () => category)
  );

  const usedSymbols = new Set();
  const market = plan.map(category => {
    const tile = drawTile(category, usedSymbols, random);
    usedSymbols.add(tile.symbol);
    return tile;
  });

  return shuffle(market, random);
}

function refillMarketTile(market, tileId, random = Math.random) {
  const index = market.findIndex(tile => tile.id === tileId);
  if (index === -1) return null;

  const currentTile = market[index];
  const usedSymbols = new Set(market.map(tile => tile.symbol));
  const replacement = drawTile(currentTile.category, usedSymbols, random, currentTile.id);
  const nextMarket = market.slice();
  nextMarket[index] = replacement;
  return nextMarket;
}

function getPublicMarket(market) {
  return market.map(({ id, symbol }) => ({ id, symbol }));
}

module.exports = { createMarket, refillMarketTile, getPublicMarket, POOLS, CATEGORY_SLOTS };